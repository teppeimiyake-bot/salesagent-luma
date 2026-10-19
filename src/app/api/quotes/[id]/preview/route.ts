import React from "react";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { QuotePdfV2 } from "@/lib/pdf/quote-pdf";
import { renderPdfBuffer } from "@/lib/pdf/render";
import { ensureQuoteIssuerProfile, issuerSnapshot } from "@/lib/quote-issuer";
import { logoForPdf } from "@/lib/quote-logo-pdf";
import { validateQuoteLines, type CalculableQuoteLine } from "@/lib/quote-calculation";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 60;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) return await writeForbidden();
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const quote = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const lines: CalculableQuoteLine[] = quote.lines.map((line) => ({
    name: line.name, detail: line.detail, qty: line.qty, unitPrice: line.unitPrice, unit: line.unit,
    taxCategory: line.taxCategory === "non_taxable" ? "non_taxable" : "taxable", taxRate: line.taxRate,
  }));
  const error = validateQuoteLines(lines);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const profile = await ensureQuoteIssuerProfile(prisma, quote.tenantId);
  const issuer = issuerSnapshot(profile);
  const logo = await logoForPdf(issuer.logoUrl, "preview");
  const buffer = await renderPdfBuffer(React.createElement(QuotePdfV2, { data: {
    quoteNumber: quote.quoteNumber ?? "（プレビュー）", clientName: quote.clientName,
    clientHonorific: quote.clientHonorific, subject: quote.subject, issueDate: quote.issueDate,
    note: quote.note, issuer: { ...issuer, logoUrl: logo.src }, lines,
  } }));
  const headers: Record<string, string> = { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=quote-preview.pdf", "Cache-Control": "no-store" };
  // ロゴなしで描いたときは画面で知らせる（ヘッダーは ASCII だけなので URL エンコードする）
  if (logo.warning) headers["X-Quote-Logo-Warning"] = encodeURIComponent(logo.warning);
  return new Response(new Uint8Array(buffer), { headers });
}
