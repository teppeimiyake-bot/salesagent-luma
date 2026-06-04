import { NextResponse } from "next/server";
import React from "react";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { putFile, deleteFile } from "@/lib/storage";
import { renderPdfBuffer } from "@/lib/pdf/render";
import { QuotePdf } from "@/lib/pdf/quote-pdf";

export const maxDuration = 60;

/**
 * POST /api/quotes/[id]/finalize
 * 見積（Quote）を確定し、見積書PDFを生成して Document(category=quote, scope=deal) として格納する。
 * 既に発行済みの場合は古い Document/ファイルを差し替える（再生成）。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const session = await getSession();

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } }, deal: { select: { id: true } } },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.lines.length === 0) {
    return NextResponse.json({ error: "明細が空の見積は確定できません" }, { status: 400 });
  }

  const element = React.createElement(QuotePdf, {
    data: {
      clientName: quote.clientName,
      clientHonorific: quote.clientHonorific,
      subject: quote.subject,
      issueDate: quote.issueDate,
      taxRate: quote.taxRate,
      note: quote.note,
      version: quote.version,
      lines: quote.lines.map((l) => ({
        name: l.name,
        detail: l.detail,
        qty: l.qty,
        unitPrice: l.unitPrice,
      })),
    },
  });

  let buffer: Buffer;
  try {
    buffer = await renderPdfBuffer(element);
  } catch (e) {
    console.error("[quotes finalize] PDF render failed:", e);
    return NextResponse.json({ error: `PDF生成に失敗しました: ${(e as Error).message}` }, { status: 500 });
  }

  const filename = `quote_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.pdf`;
  let fileUrl: string;
  try {
    ({ url: fileUrl } = await putFile({ dir: "documents", filename, buffer, contentType: "application/pdf" }));
  } catch (e) {
    console.error("[quotes finalize] putFile failed:", e);
    return NextResponse.json({ error: `ファイル保存に失敗しました: ${(e as Error).message}` }, { status: 500 });
  }

  const docName = `${quote.clientName} 見積書${quote.version ? `（${quote.version}）` : ""}`;

  // 既存発行物があれば差し替え（古いファイル本体も削除）
  let documentId: string;
  if (quote.documentId) {
    const old = await prisma.document.findUnique({ where: { id: quote.documentId }, select: { fileUrl: true } });
    const updated = await prisma.document.update({
      where: { id: quote.documentId },
      data: {
        name: docName,
        fileUrl,
        fileSize: buffer.length,
        mimeType: "application/pdf",
        version: quote.version ?? undefined,
        status: "final",
      },
    });
    documentId = updated.id;
    if (old?.fileUrl && old.fileUrl !== fileUrl) await deleteFile(old.fileUrl);
  } else {
    const doc = await prisma.document.create({
      data: {
        name: docName,
        category: "quote",
        sourceType: "file",
        scope: "deal",
        status: "final",
        dealId: quote.dealId,
        dealProductId: quote.dealProductId,
        version: quote.version,
        fileUrl,
        fileSize: buffer.length,
        mimeType: "application/pdf",
        uploadedById: session?.userId ?? null,
        tags: ["見積", "自動生成"],
      },
    });
    documentId = doc.id;
  }

  await prisma.quote.update({ where: { id }, data: { status: "final", documentId } });

  return NextResponse.json({ ok: true, documentId });
}
