import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { fyPeriodLabel } from "@/lib/config";

// MS送付のKPI目標（会計年度単位・組織全体の単一目標）の取得。閲覧は全ロール。
// クエリ: ?fy=2026 → period="FY2026" の目標を返す。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fy = url.searchParams.get("fy");
  if (!fy) return NextResponse.json({ error: "fy required" }, { status: 400 });
  const period = fyPeriodLabel(Number(fy));
  const goal = await prisma.msKpiGoal.findUnique({ where: { period } });
  return NextResponse.json({ goal });
}

// 目標返信率(=目標アポ率)の upsert。admin のみ。
// targetReplyRate は割合（0.005 = 0.50%）で受け取る。
const upsertSchema = z.object({
  fy: z.number().int().min(2020).max(2100),
  targetReplyRate: z.number().min(0).max(1),
  targetSent: z.number().int().min(0).optional().nullable(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const period = fyPeriodLabel(parsed.data.fy);
  const goal = await prisma.msKpiGoal.upsert({
    where: { period },
    create: {
      period,
      targetReplyRate: parsed.data.targetReplyRate,
      targetSent: parsed.data.targetSent ?? null,
    },
    update: {
      targetReplyRate: parsed.data.targetReplyRate,
      targetSent: parsed.data.targetSent ?? null,
    },
  });
  return NextResponse.json({ goal });
}
