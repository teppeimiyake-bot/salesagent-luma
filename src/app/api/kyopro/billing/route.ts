import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";

const schema = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  billStatus: z.enum(["NOT_SENT", "SENT", "PAID"]).optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  /** 締め時点の金額を残す（未指定なら実績集計のまま） */
  amountNet: z.number().int().min(0).nullish(),
  amountGross: z.number().int().min(0).nullish(),
  note: z.string().max(1000).nullish(),
});

const toDate = (v: string | null | undefined) => (v ? new Date(`${v}T00:00:00.000Z`) : null);

/**
 * PATCH /api/kyopro/billing
 * 月次の京プロ宛請求（送付・入金ステータス、請求日、入金日）を更新する。
 * 対象月の行が無ければ作る。
 */
export async function PATCH(req: Request) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { yearMonth, ...rest } = parsed.data;

  const data = {
    ...(rest.billStatus !== undefined ? { billStatus: rest.billStatus } : {}),
    ...(rest.invoiceDate !== undefined ? { invoiceDate: toDate(rest.invoiceDate) } : {}),
    ...(rest.paidDate !== undefined ? { paidDate: toDate(rest.paidDate) } : {}),
    ...(rest.amountNet !== undefined ? { amountNet: rest.amountNet } : {}),
    ...(rest.amountGross !== undefined ? { amountGross: rest.amountGross } : {}),
    ...(rest.note !== undefined ? { note: rest.note } : {}),
  };

  const existing = await prisma.kyoproBillingPeriod.findFirst({ where: { yearMonth } });
  const period = existing
    ? await prisma.kyoproBillingPeriod.update({ where: { id: existing.id }, data })
    : await prisma.kyoproBillingPeriod.create({ data: { yearMonth, ...data } });
  return NextResponse.json({ period });
}
