import { NextResponse } from "next/server";
import React from "react";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { putFile, deleteFile, StorageConfigError } from "@/lib/storage";
import { renderPdfBuffer } from "@/lib/pdf/render";
import { QuotePdf, QuotePdfV2 } from "@/lib/pdf/quote-pdf";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { calculateQuote, normalizeHonorific, validateQuoteLines, type CalculableQuoteLine } from "@/lib/quote-calculation";
import { ensureQuoteIssuerProfile, issuerSnapshot, quoteNumber } from "@/lib/quote-issuer";
import { logoForPdf } from "@/lib/quote-logo-pdf";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 60;

/** 別のタブ・別の要求が同じ見積を発行中のとき、その発行が終わるのを待つ上限（maxDuration の範囲内）。 */
const CONCURRENT_ISSUE_WAIT_MS = 20_000;
const CONCURRENT_ISSUE_POLL_MS = 500;

type IssuedQuote = { documentId: string; quoteNumber: string | null };

/** JSON の値を、キーの順序に関係なく比べるための文字列にする（jsonb はキーの順序を保たない）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    // 値が undefined のキーは JSON に保存されないので、比べるときも除く
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 確保済みの内容が、これから確保する内容と同じか。 */
function sameReservation(stored: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.keys(next).every((key) => stableJson(stored[key]) === stableJson(next[key]));
}

/** すでに発行済みの見積への確定は、新しい番号・PDF を作らずに、その発行結果を返す。 */
function alreadyIssuedResponse(issued: IssuedQuote) {
  return NextResponse.json({
    ok: true,
    documentId: issued.documentId,
    quoteNumber: issued.quoteNumber,
    idempotent: true,
    alreadyIssued: true,
    message: `この見積はすでに発行されています${issued.quoteNumber ? `（${issued.quoteNumber}）` : ""}`,
  });
}

/** 別の要求が番号を確保して発行中の見積が、発行済みになるのを待つ。上限までに終わらなければ null。 */
async function waitForIssued(id: string): Promise<IssuedQuote | null> {
  const deadline = Date.now() + CONCURRENT_ISSUE_WAIT_MS;
  for (;;) {
    const row = await prisma.quote.findUnique({ where: { id }, select: { status: true, documentId: true, quoteNumber: true } });
    if (row?.status === "final" && row.documentId) return { documentId: row.documentId, quoteNumber: row.quoteNumber };
    if (!row || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, CONCURRENT_ISSUE_POLL_MS));
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) return await writeForbidden();
  const { id } = await params;
  return isQuotePdfV2Enabled() ? finalizeV2(req, id) : finalizeLegacy(id);
}

async function finalizeV2(req: Request, id: string) {
  const session = await getSession();
  const body: unknown = await req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body) || ("idempotencyKey" in body && typeof body.idempotencyKey !== "string")) {
    return NextResponse.json({ error: "Invalid idempotency key" }, { status: 400 });
  }
  const input = body as { idempotencyKey?: string };
  const idempotencyKey = (req.headers.get("Idempotency-Key") || input.idempotencyKey || crypto.randomUUID()).slice(0, 120);
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.status === "final" && quote.documentId) {
    return alreadyIssuedResponse({ documentId: quote.documentId, quoteNumber: quote.quoteNumber });
  }

  const lines: CalculableQuoteLine[] = quote.lines.map((line) => ({
    name: line.name, detail: line.detail, qty: line.qty, unitPrice: line.unitPrice,
    unit: line.unit, taxCategory: line.taxCategory === "non_taxable" ? "non_taxable" : "taxable", taxRate: line.taxRate,
  }));
  const validationError = validateQuoteLines(lines);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });
  const recipient = normalizeHonorific(quote.clientName, quote.clientHonorific);
  if (!recipient.clientName) return NextResponse.json({ error: "宛名を入力してください" }, { status: 400 });
  if (Number.isNaN(quote.issueDate.getTime())) return NextResponse.json({ error: "発行日が不正です" }, { status: 400 });
  const totals = calculateQuote(lines);

  type Prepared = { number: string; issuer: ReturnType<typeof issuerSnapshot>; updatedAt: Date };
  // 2タブで同時に発行すると、後の要求は「下書き」を読んだ後で、先の要求が番号を確保した（または発行を終えた）
  // 見積のロックを取る。これを採番の失敗として返すと、実際は発行済みなのに利用者は失敗と受け取るので、区別する。
  let outcome: { kind: "prepared"; prepared: Prepared } | { kind: "issued"; issued: IssuedQuote } | { kind: "issuing" } | { kind: "changed" };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const locked = await tx.quote.findUnique({
        where: { id },
        select: {
          quoteNumber: true, idempotencyKey: true, updatedAt: true, status: true, documentId: true,
          issuerSnapshot: true, templateVersion: true, clientName: true, clientHonorific: true, subtotal: true, taxTotal: true, grandTotal: true,
        },
      });
      if (!locked) throw new Error("見積が見つかりません");
      if (locked.status === "final" && locked.documentId) {
        return { kind: "issued" as const, issued: { documentId: locked.documentId, quoteNumber: locked.quoteNumber } };
      }
      if (locked.status === "final" || locked.updatedAt.getTime() !== quote.updatedAt.getTime()) {
        // 読んだ後に別の要求が番号（または発行の冪等キー）を確保した ＝ 別のタブが発行中。それ以外は内容の編集。
        const reservedByOther = locked.quoteNumber !== quote.quoteNumber || locked.idempotencyKey !== quote.idempotencyKey;
        return { kind: reservedByOther ? "issuing" as const : "changed" as const };
      }
      let issuer = await ensureQuoteIssuerProfile(tx, quote.tenantId);
      let number = locked.quoteNumber;
      if (!number) {
        // 採番は「読んだ値を使い、別の UPDATE で +1」にしない。読んだ後に別の見積の発行や管理画面の
        // 開始番号変更がコミットすると、同じ番号を2回使う（(tenant_id, quote_number) の一意制約で
        // 発行が失敗する）か番号が飛ぶ。この会社の行を1つの UPDATE … SET next_quote_number =
        // next_quote_number + 1 で進め、その結果（行ロック中で他から変わらない）の1つ前を使う。
        // 番号を確保済みの見積（やり直し）では進めない。
        issuer = await tx.quoteIssuerProfile.update({ where: { tenantId: quote.tenantId }, data: { nextQuoteNumber: { increment: 1 } } });
        number = quoteNumber(issuer.numberPrefix, quote.issueDate, issuer.nextQuoteNumber - 1);
      }
      const snapshot = issuerSnapshot(issuer);
      // 確保済みの見積で、確保した内容（発行者・宛名・金額）がいまの内容と同じなら、書き直さない。
      // 書き直すと updatedAt が進み、同じ番号で先に PDF を作っている要求（もう1つのタブ）の確定が
      // 「編集中に更新されました」で失敗する（実際はこちらと同じ番号・内容）。内容が変わったとき（編集後のやり直し）は書き直す。
      const reservation = {
        issuerSnapshot: snapshot, templateVersion: "T14-v2", clientName: recipient.clientName, clientHonorific: recipient.honorific,
        subtotal: totals.subtotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
      };
      if (locked.quoteNumber && locked.quoteNumber === number && locked.idempotencyKey && sameReservation(locked, reservation)) {
        return { kind: "prepared" as const, prepared: { number, issuer: snapshot, updatedAt: locked.updatedAt } };
      }
      const reserved = await tx.quote.update({
        where: { id },
        data: {
          quoteNumber: number,
          issuerSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          templateVersion: "T14-v2",
          idempotencyKey: locked.idempotencyKey ?? idempotencyKey,
          clientName: recipient.clientName,
          clientHonorific: recipient.honorific,
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
        },
      });
      return { kind: "prepared" as const, prepared: { number, issuer: snapshot, updatedAt: reserved.updatedAt } };
    });
  } catch (error) {
    console.error("[quotes finalize v2] prepare failed:", error);
    return NextResponse.json({ error: "採番に失敗しました。再度お試しください" }, { status: 409 });
  }
  if (outcome.kind === "issued") return alreadyIssuedResponse(outcome.issued);
  if (outcome.kind === "changed") {
    return NextResponse.json({ error: "見積が編集中に更新されました。再読み込みして発行してください。" }, { status: 409 });
  }
  if (outcome.kind === "issuing") {
    // 先の要求の発行（PDF 作成と保存）が終わるのを待ち、その番号・PDF をそのまま返す。番号も PDF も二重に作らない。
    const issued = await waitForIssued(id);
    if (issued) return alreadyIssuedResponse(issued);
    return NextResponse.json(
      { error: "この見積は別の画面で発行処理中です。しばらく待ってから再読み込みして、発行結果を確認してください。", code: "QUOTE_ISSUING" },
      { status: 409 },
    );
  }
  const prepared = outcome.prepared;

  // ロゴは短い上限時間で取得して data URL で渡す。取れなければロゴなしで発行し、結果で知らせる
  // （issuerSnapshot には設定どおりの値を残す）。
  const logo = await logoForPdf(prepared.issuer.logoUrl, "issue");
  let buffer: Buffer;
  try {
    buffer = await renderPdfBuffer(React.createElement(QuotePdfV2, {
      data: {
        quoteNumber: prepared.number, clientName: recipient.clientName, clientHonorific: recipient.honorific,
        subject: quote.subject, issueDate: quote.issueDate, note: quote.note, issuer: { ...prepared.issuer, logoUrl: logo.src }, lines,
      },
    }));
  } catch (error) {
    console.error("[quotes finalize v2] PDF render failed:", error);
    return NextResponse.json({ error: `PDF生成に失敗しました: ${(error as Error).message}` }, { status: 500 });
  }

  const filename = `quote_${prepared.number.replace(/[^A-Za-z0-9_-]/g, "_")}_${crypto.randomBytes(4).toString("hex")}.pdf`;
  let fileUrl: string;
  try {
    ({ url: fileUrl } = await putFile({ dir: "documents", filename, buffer, contentType: "application/pdf" }));
  } catch (error) {
    console.error("[quotes finalize v2] putFile failed:", error);
    const status = error instanceof StorageConfigError ? 503 : 500;
    return NextResponse.json({ error: `ファイル保存に失敗しました: ${(error as Error).message}` }, { status });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const current = await tx.quote.findUnique({ where: { id }, select: { status: true, documentId: true, quoteNumber: true, updatedAt: true } });
      if (!current) throw new Error("見積が見つかりません");
      if (current.status === "final" && current.documentId) {
        return { documentId: current.documentId, quoteNumber: current.quoteNumber, duplicateUpload: true };
      }
      if (current.updatedAt.getTime() !== prepared.updatedAt.getTime()) throw new Error("QUOTE_CHANGED");
      const doc = await tx.document.create({
        data: {
          name: `${recipient.clientName} 見積書（${prepared.number}）`, category: "quote", sourceType: "file", scope: "deal",
          status: "final", dealId: quote.dealId, dealProductId: quote.dealProductId, version: quote.version,
          fileUrl, fileSize: buffer.length, mimeType: "application/pdf", uploadedById: session?.userId ?? null,
          tags: ["見積", "自動生成", "T14"],
        },
      });
      await tx.quote.update({ where: { id }, data: { status: "final", documentId: doc.id, finalizedAt: new Date() } });
      return { documentId: doc.id, quoteNumber: prepared.number, duplicateUpload: false };
    });
    if (result.duplicateUpload) await deleteFile(fileUrl);
    return NextResponse.json({
      ok: true, documentId: result.documentId, quoteNumber: result.quoteNumber, idempotent: result.duplicateUpload,
      ...(logo.warning && !result.duplicateUpload ? { logoWarning: logo.warning } : {}),
    });
  } catch (error) {
    await deleteFile(fileUrl);
    if (error instanceof Error && error.message === "QUOTE_CHANGED") return NextResponse.json({ error: "見積が編集中に更新されました。再読み込みして発行してください。" }, { status: 409 });
    console.error("[quotes finalize v2] commit failed:", error);
    return NextResponse.json({ error: "見積書の保存に失敗しました" }, { status: 500 });
  }
}

/** フラグOFF時はT14以前の再発行・旧PDFレイアウトを維持する。 */
async function finalizeLegacy(id: string) {
  const session = await getSession();
  const quote = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!quote.lines.length) return NextResponse.json({ error: "明細が空の見積は確定できません" }, { status: 400 });
  let buffer: Buffer;
  try {
    buffer = await renderPdfBuffer(React.createElement(QuotePdf, { data: {
      clientName: quote.clientName, clientHonorific: quote.clientHonorific, subject: quote.subject,
      issueDate: quote.issueDate, taxRate: quote.taxRate, note: quote.note, version: quote.version,
      lines: quote.lines.map((line) => ({ name: line.name, detail: line.detail, qty: line.qty, unitPrice: line.unitPrice })),
    } }));
  } catch (error) {
    return NextResponse.json({ error: `PDF生成に失敗しました: ${(error as Error).message}` }, { status: 500 });
  }
  const filename = `quote_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.pdf`;
  let fileUrl: string;
  try { ({ url: fileUrl } = await putFile({ dir: "documents", filename, buffer, contentType: "application/pdf" })); }
  catch (error) { return NextResponse.json({ error: `ファイル保存に失敗しました: ${(error as Error).message}` }, { status: 500 }); }
  const data = { name: `${quote.clientName} 見積書${quote.version ? `（${quote.version}）` : ""}`, fileUrl, fileSize: buffer.length, mimeType: "application/pdf", version: quote.version ?? undefined, status: "final" };
  let documentId: string;
  if (quote.documentId) {
    const old = await prisma.document.findUnique({ where: { id: quote.documentId }, select: { fileUrl: true } });
    documentId = (await prisma.document.update({ where: { id: quote.documentId }, data })).id;
    if (old?.fileUrl !== fileUrl) await deleteFile(old?.fileUrl);
  } else {
    documentId = (await prisma.document.create({ data: {
      ...data, category: "quote", sourceType: "file", scope: "deal", dealId: quote.dealId,
      dealProductId: quote.dealProductId, uploadedById: session?.userId ?? null, tags: ["見積", "自動生成"],
    } })).id;
  }
  await prisma.quote.update({ where: { id }, data: { status: "final", documentId } });
  return NextResponse.json({ ok: true, documentId });
}
