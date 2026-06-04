import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/pm
 * 受注企業の案件進捗（PMタブ・機能4）一覧。
 * ProductionProject を企業名・撮影日とともに返す。サブタブ分けは category で行う。
 * 並び: 納品済みは後ろ → 納品予定日（昇順・null末尾）→ 企業名。
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "viewer")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const projects = await prisma.productionProject.findMany({
    orderBy: [{ delivered: "asc" }, { deliveryDate: "asc" }, { createdAt: "asc" }],
    include: {
      deal: {
        select: {
          id: true,
          title: true,
          company: { select: { id: true, name: true } },
        },
      },
      dealProduct: {
        select: { id: true, productName: true, planName: true, yomiStatus: true, amount: true },
      },
    },
  });

  return NextResponse.json({ projects });
}
