import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/payments/recurring
 * 定期契約の一覧（月次グリッド込み）。各契約の periods を含めて返す。
 */
export async function GET() {
  // Phase 9：入金管理は admin 限定（GET含む）
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Phase 9：プロダクト単位エントリ（dealProductId あり）のみ表示。
  const billings = await prisma.recurringBilling.findMany({
    where: { dealProductId: { not: null } },
    orderBy: [{ customerName: "asc" }],
    include: {
      company: { select: { id: true, name: true } },
      deal: { select: { id: true, title: true } },
      periods: { orderBy: { yearMonth: "asc" } },
      dealProduct: {
        select: {
          id: true,
          productName: true,
          amount: true,
          productionProject: {
            select: { serviceStartMonth: true, serviceEndMonth: true },
          },
        },
      },
    },
  });
  return NextResponse.json({ billings });
}
