import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, getSession, hasPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { nextQuoteVersion } from "@/lib/quote-version";
import { writeForbidden } from "@/lib/write-guard";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) return await writeForbidden();
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const session = await getSession();
  const source = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (source.status !== "final") return NextResponse.json({ error: "発行済み見積だけを改訂できます" }, { status: 409 });
  const revised = await prisma.quote.create({ data: {
    dealId: source.dealId, dealProductId: source.dealProductId, clientName: source.clientName,
    clientHonorific: source.clientHonorific, subject: source.subject, issueDate: new Date(), note: source.note,
    taxRate: source.taxRate, status: "draft",
    // T17: 版番号を採番する（従来は親の version をそのままコピーしていて、
    // 一覧でどれが最新の改訂か判別できなかった）
    version: nextQuoteVersion(source.version), supersedesQuoteId: source.id,
    createdById: session?.userId ?? null,
    lines: { create: source.lines.map((line, index) => ({
      name: line.name, detail: line.detail, qty: line.qty, unitPrice: line.unitPrice, unit: line.unit,
      taxCategory: line.taxCategory, taxRate: line.taxRate, sortOrder: index,
    })) },
  }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  return NextResponse.json({ quote: revised });
}
