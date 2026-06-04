import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/payments/recurring
 * 定期契約の一覧（月次グリッド込み）。各契約の periods を含めて返す。
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "viewer")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const billings = await prisma.recurringBilling.findMany({
    orderBy: [{ customerName: "asc" }],
    include: {
      company: { select: { id: true, name: true } },
      periods: { orderBy: { yearMonth: "asc" } },
    },
  });
  return NextResponse.json({ billings });
}
