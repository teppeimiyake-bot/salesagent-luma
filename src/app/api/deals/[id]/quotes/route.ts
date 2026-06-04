import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET  /api/deals/[id]/quotes  — この商談の見積（Quote）一覧（明細込み）
 * POST /api/deals/[id]/quotes  — 見積ドラフトを作成
 */

const lineSchema = z.object({
  name: z.string().min(1),
  detail: z.string().nullable().optional(),
  qty: z.number().int().min(1).default(1),
  unitPrice: z.number().int().min(0),
});

const createSchema = z.object({
  dealProductId: z.string().uuid().nullable().optional(),
  clientName: z.string().min(1),
  clientHonorific: z.string().optional(),
  subject: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  taxRate: z.number().int().min(0).max(100).optional(),
  version: z.string().nullable().optional(),
  lines: z.array(lineSchema).min(1),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const quotes = await prisma.quote.findMany({
    where: { dealId: id },
    orderBy: { createdAt: "desc" },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      createdBy: { select: { id: true, name: true } },
      dealProduct: { select: { id: true, productName: true, planName: true } },
    },
  });
  return NextResponse.json({ quotes });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      status: "draft",
      createdById: session?.userId ?? null,
      lines: {
        create: d.lines.map((l, i) => ({
          name: l.name,
          detail: l.detail ?? null,
          qty: l.qty,
          unitPrice: l.unitPrice,
          sortOrder: i,
        })),
      },
    },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

  return NextResponse.json({ quote });
}
