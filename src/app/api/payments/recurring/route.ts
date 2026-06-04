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
  // Phase 10：入金管理の正本＝スプレッドシート由来の行（source_key='recurring::%'）のみ表示。
  //   Phase 9 の余剰 dpid:: エントリは表示しない（cleanup で削除）。
  const billings = await prisma.recurringBilling.findMany({
    where: { sourceKey: { startsWith: "recurring::" } },
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
