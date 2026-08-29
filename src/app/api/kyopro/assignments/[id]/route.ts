import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import { resolveRate, DEFAULT_CLEANUP_BILL, DEFAULT_CLEANUP_PAY, type RateLike } from "@/lib/kyopro";

const updateSchema = z.object({
  status: z.enum(["TENTATIVE", "CONFIRMED", "DONE", "CANCELLED"]).optional(),
  payAmount: z.number().int().min(0).max(1_000_000).optional(),
  billAmount: z.number().int().min(0).max(1_000_000).optional(),
  /** 現場での片付けチェック。金額はレートから引き直す（画面から金額を渡させない）。 */
  cleanup: z.boolean().optional(),
  adjustAmount: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  adjustNote: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const current = await prisma.kyoproAssignment.findUnique({
    where: { id },
    include: { shoot: { select: { date: true } } },
  });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let cleanupAmounts: { cleanupBillAmount: number; cleanupPayAmount: number } | undefined;
  if (d.cleanup !== undefined) {
    const rates = (await prisma.kyoproRate.findMany()) as unknown as RateLike[];
    const rate = resolveRate(rates, current.role, current.shoot.date);
    cleanupAmounts = d.cleanup
      ? {
          cleanupBillAmount: rate?.cleanupBillAmount ?? DEFAULT_CLEANUP_BILL,
          cleanupPayAmount: rate?.cleanupPayAmount ?? DEFAULT_CLEANUP_PAY,
        }
      : { cleanupBillAmount: 0, cleanupPayAmount: 0 };
  }

  const assignment = await prisma.kyoproAssignment.update({
    where: { id },
    data: {
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.payAmount !== undefined ? { payAmount: d.payAmount } : {}),
      ...(d.billAmount !== undefined ? { billAmount: d.billAmount } : {}),
      ...(d.cleanup !== undefined ? { cleanup: d.cleanup, ...cleanupAmounts } : {}),
      ...(d.adjustAmount !== undefined ? { adjustAmount: d.adjustAmount } : {}),
      ...(d.adjustNote !== undefined ? { adjustNote: d.adjustNote } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
    },
  });
  return NextResponse.json({ assignment });
}

/** アサインの取り消し。実績として残す必要があればステータスを CANCELLED にする運用。 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  await prisma.kyoproAssignment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
