import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const schema = z.object({
  yearMonth: z.number().int().min(190001).max(299912),
  sent: z.boolean().optional(),
  paid: z.boolean().optional(),
});

/**
 * PUT /api/payments/recurring/[id]/period
 * 月次グリッドのセル（請求送付/着金）トグル。upsert で作成 or 更新。
 * body: { yearMonth: 202506, sent?: bool, paid?: bool }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Phase 9：入金管理は admin 限定
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id: billingId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { yearMonth, sent, paid } = parsed.data;

  // 既存値を取得して、未指定フラグは温存
  const existing = await prisma.recurringBillingPeriod.findUnique({
    where: { billingId_yearMonth: { billingId, yearMonth } },
  });

  const period = await prisma.recurringBillingPeriod.upsert({
    where: { billingId_yearMonth: { billingId, yearMonth } },
    create: {
      billingId,
      yearMonth,
      sent: sent ?? false,
      paid: paid ?? false,
    },
    update: {
      ...(sent !== undefined ? { sent } : {}),
      ...(paid !== undefined ? { paid } : {}),
    },
  });

  // 「着金=true」にしたのに「送付=false」のままなら整合性のため送付も true へ寄せる
  // （送付していないのに着金は通常ありえないが、運用上は手動優先のため強制はしない）
  void existing;

  return NextResponse.json({ period });
}
