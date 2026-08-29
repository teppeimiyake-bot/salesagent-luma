import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro, ensureKyoproRates } from "@/lib/kyopro-server";
import { payoutDueDate } from "@/lib/kyopro";

const schema = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  staffId: z.string().uuid(),
  status: z.enum(["UNPAID", "SCHEDULED", "PAID"]),
  /** 画面が表示している当月の発注合計。支払時点の金額として残す。 */
  amount: z.number().int().min(0),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  note: z.string().max(500).nullish(),
});

/**
 * PATCH /api/kyopro/payouts
 * 月 × スタッフの支払ステータスを更新する（行が無ければ作る）。
 * 支払期日は「撮影月 + 設定Nヶ月の月末」で毎回引き直すので、設定変更が未払い分に効く。
 */
export async function PATCH(req: Request) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { yearMonth, staffId, status, amount } = parsed.data;
  const { setting } = await ensureKyoproRates();
  const dueDate = payoutDueDate(yearMonth, setting.payoutDueMonths);
  const paidDate =
    parsed.data.paidDate === undefined
      ? status === "PAID"
        ? new Date()
        : null
      : parsed.data.paidDate
        ? new Date(`${parsed.data.paidDate}T00:00:00.000Z`)
        : null;

  const existing = await prisma.kyoproPayout.findFirst({ where: { yearMonth, staffId } });
  const data = {
    status,
    amount,
    dueDate,
    paidDate,
    ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
  };
  const payout = existing
    ? await prisma.kyoproPayout.update({ where: { id: existing.id }, data })
    : await prisma.kyoproPayout.create({ data: { yearMonth, staffId, ...data } });
  return NextResponse.json({ payout });
}
