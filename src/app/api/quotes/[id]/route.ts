import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { deleteFile } from "@/lib/storage";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { writeForbidden } from "@/lib/write-guard";

/**
 * GET    /api/quotes/[id]
 * PATCH  /api/quotes/[id]  — ヘッダ＋明細を全置換で更新（手修正可）
 * DELETE /api/quotes/[id]  — 見積と発行PDF Document を削除
 */

const lineSchema = z.object({
  name: z.string().min(1),
  detail: z.string().nullable().optional(),
  qty: z.number().int().min(1).default(1),
  unitPrice: z.number().int().min(0),
  unit: z.string().min(1).optional(),
  taxCategory: z.enum(["taxable", "non_taxable"]).optional(),
  taxRate: z.number().int().min(0).max(100).optional(),
});

const patchSchema = z.object({
  clientName: z.string().min(1).optional(),
  clientHonorific: z.string().optional(),
  subject: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  taxRate: z.number().int().min(0).max(100).optional(),
  version: z.string().nullable().optional(),
  issueDate: z.string().refine(value => Number.isFinite(Date.parse(value)), "Invalid date").optional(),
  lines: z.array(lineSchema).min(1).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!perm) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ quote });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return await writeForbidden();
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await prisma.quote.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isQuotePdfV2Enabled() && existing.status === "final") {
    return NextResponse.json({ error: "発行済み見積は編集できません。改訂版を作成してください" }, { status: 409 });
  }

  // 明細は全置換（編集UIは行配列を丸ごと送る前提）。編集すると status は draft に戻す。
  let updated;
  try {
  updated = await prisma.quote.update({
    where: { id, ...(isQuotePdfV2Enabled() ? { status: { not: "final" } } : {}) },
    data: {
      ...(d.clientName !== undefined ? { clientName: d.clientName } : {}),
      ...(d.clientHonorific !== undefined ? { clientHonorific: d.clientHonorific } : {}),
      ...(d.subject !== undefined ? { subject: d.subject } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.taxRate !== undefined ? { taxRate: d.taxRate } : {}),
      ...(d.version !== undefined ? { version: d.version } : {}),
      ...(d.issueDate ? { issueDate: new Date(d.issueDate) } : {}),
      ...(d.lines
        ? {
            status: "draft",
            lines: {
              deleteMany: {},
              create: d.lines.map((l, i) => ({
                name: l.name,
                detail: l.detail ?? null,
                qty: l.qty,
                unitPrice: l.unitPrice,
                unit: l.unit ?? "式",
                taxCategory: l.taxCategory ?? "taxable",
                taxRate: l.taxRate ?? d.taxRate ?? 10,
                sortOrder: i,
              })),
            },
          }
        : {}),
    },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "見積が更新されました。再読み込みしてください。" }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ quote: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return await writeForbidden();
  }
  const { id } = await params;
  const quote = await prisma.quote.findUnique({ where: { id }, select: { documentId: true, status: true } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isQuotePdfV2Enabled() && (quote.status === "final" || quote.documentId)) {
    return NextResponse.json({ error: "発行済み見積は削除できません" }, { status: 409 });
  }
  if (quote.documentId) {
    const doc = await prisma.document.findUnique({ where: { id: quote.documentId }, select: { fileUrl: true } });
    await prisma.document.delete({ where: { id: quote.documentId } }).catch(() => {});
    if (doc?.fileUrl) await deleteFile(doc.fileUrl);
  }
  await prisma.quote.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
