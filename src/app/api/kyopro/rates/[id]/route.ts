import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";

const yen = z.number().int().min(0).max(1_000_000);

const updateSchema = z.object({
  billRate: yen.optional(),
  payRateDefault: yen.optional(),
  payRateMin: yen.nullish(),
  payRateMax: yen.nullish(),
  cleanupBillAmount: yen.optional(),
  cleanupPayAmount: yen.optional(),
  note: z.string().max(500).nullish(),
});

/**
 * PATCH /api/kyopro/rates/[id]
 * 既存レート行を直接書き換える。過去のアサインは確定時の金額をスナップショットして
 * 持っているため、ここを変えても実績・請求は動かない。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const min = d.payRateMin ?? null;
  const max = d.payRateMax ?? null;
  if (min !== null && max !== null && min > max) {
    return NextResponse.json({ error: "発注単価の下限が上限を上回っています" }, { status: 400 });
  }
  const rate = await prisma.kyoproRate.update({ where: { id }, data: d });
  return NextResponse.json({ rate });
}
