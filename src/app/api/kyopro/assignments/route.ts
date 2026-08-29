import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import {
  KYOPRO_ROLES,
  computeAssignmentAmounts,
  resolveRate,
  type RateLike,
} from "@/lib/kyopro";
import type { KyoproRole } from "@prisma/client";

const roleEnum = z.enum(KYOPRO_ROLES as [string, ...string[]]);

const createSchema = z.object({
  shootId: z.string().uuid(),
  staffId: z.string().uuid(),
  role: roleEnum,
  status: z.enum(["TENTATIVE", "CONFIRMED", "DONE", "CANCELLED"]).optional(),
  /** 未指定なら レート × 人材の個別単価 から自動決定する */
  payAmount: z.number().int().min(0).max(1_000_000).nullish(),
  billAmount: z.number().int().min(0).max(1_000_000).nullish(),
  cleanup: z.boolean().optional(),
  note: z.string().max(500).nullish(),
});

/**
 * POST /api/kyopro/assignments
 * 撮影会に人材を割り当てる。金額は撮影日時点のレートから確定させて保存する
 * （後のレート改定を過去に波及させないためのスナップショット）。
 */
export async function POST(req: Request) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const role = d.role as KyoproRole;

  const [shoot, staff, rates] = await Promise.all([
    prisma.kyoproShoot.findUnique({ where: { id: d.shootId } }),
    prisma.kyoproStaff.findUnique({ where: { id: d.staffId } }),
    prisma.kyoproRate.findMany(),
  ]);
  if (!shoot) return NextResponse.json({ error: "撮影会が見つかりません" }, { status: 404 });
  if (!staff) return NextResponse.json({ error: "人材が見つかりません" }, { status: 404 });

  const dup = await prisma.kyoproAssignment.findFirst({
    where: { shootId: d.shootId, staffId: d.staffId, role },
  });
  if (dup) {
    return NextResponse.json({ error: "この人はこの撮影会の同じ職種に既に入っています" }, { status: 409 });
  }

  const rate = resolveRate(rates as unknown as RateLike[], role, shoot.date);
  const amounts = computeAssignmentAmounts({
    rate,
    role,
    payOverrides: staff.payOverrides,
    payAmountInput: d.payAmount ?? null,
    billAmountInput: d.billAmount ?? null,
    cleanup: d.cleanup ?? false,
  });

  const assignment = await prisma.kyoproAssignment.create({
    data: {
      shootId: d.shootId,
      staffId: d.staffId,
      role,
      status: d.status ?? "CONFIRMED",
      billAmount: amounts.billAmount,
      payAmount: amounts.payAmount,
      cleanup: d.cleanup ?? false,
      cleanupBillAmount: amounts.cleanupBillAmount,
      cleanupPayAmount: amounts.cleanupPayAmount,
      note: d.note ?? null,
    },
    include: { staff: { select: { name: true } } },
  });
  return NextResponse.json({ assignment });
}
