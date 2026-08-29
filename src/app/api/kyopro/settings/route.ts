import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro, ensureKyoproRates } from "@/lib/kyopro-server";

const updateSchema = z.object({
  /** 支払期日＝撮影月＋Nヶ月の月末。1=翌月末 / 2=翌々月末 */
  payoutDueMonths: z.number().int().min(0).max(6).optional(),
  taxRate: z.number().min(0).max(0.5).optional(),
});

export async function PATCH(req: Request) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { setting } = await ensureKyoproRates();
  const updated = await prisma.kyoproSetting.update({ where: { id: setting.id }, data: parsed.data });
  return NextResponse.json({ setting: updated });
}
