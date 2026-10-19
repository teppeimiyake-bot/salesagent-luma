import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { writeForbidden } from "@/lib/write-guard";

/**
 * GET  /api/deals/[id]/quotes  — この商談の見積（Quote）一覧（明細込み）
 * POST /api/deals/[id]/quotes  — 見積ドラフトを作成
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

const createSchema = z.object({
  dealProductId: z.string().uuid().nullable().optional(),
  clientName: z.string().min(1),
  clientHonorific: z.string().optional(),
  subject: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  taxRate: z.number().int().min(0).max(100).optional(),
  version: z.string().nullable().optional(),
  issueDate: z.string().optional(),
  lines: z.array(lineSchema).min(1),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!perm) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const quotes = await prisma.quote.findMany({
    where: { dealId: id },
    orderBy: { createdAt: "desc" },
    // include なのでスカラー列（quoteNumber / supersedesQuoteId / finalizedAt を含む）は全て返る。
    // T17: クライアント側で改訂チェーンを組み立てるためにこれらが必要なので、
    // ここを select に絞る変更をするときは必ずこの3列を残すこと。
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
      dealProduct: { select: { id: true, productName: true, planName: true } },
      // 改訂元の見積番号（一覧の「〜の改訂」表示に使う。親が同一商談に無い場合の保険）
      supersedes: { select: { id: true, quoteNumber: true, version: true } },
    },
  });
  return NextResponse.json({ quotes });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return await writeForbidden();
  }
  const { id: dealId } = await params;
  const session = await getSession();
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const quote = await prisma.quote.create({
    data: {
      dealId,
      dealProductId: d.dealProductId ?? null,
      clientName: d.clientName,
      clientHonorific: d.clientHonorific ?? "御中",
      subject: d.subject ?? null,
      note: d.note ?? null,
      taxRate: d.taxRate ?? 10,
      version: d.version ?? null,
      ...(d.issueDate ? { issueDate: new Date(d.issueDate) } : {}),
      status: "draft",
      createdById: session?.userId ?? null,
      lines: {
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
    },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

  return NextResponse.json({ quote });
}
