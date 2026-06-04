import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/payments/spot
 * スポット入金管理の一覧。一覧＋インライン編集に必要な情報を返す。
 * 並び: 着金見込み日（昇順・null末尾）→ 顧客名。
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "viewer")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const records = await prisma.invoiceRecord.findMany({
    orderBy: [{ expectedPaymentDate: "asc" }, { customerName: "asc" }],
    include: {
      company: { select: { id: true, name: true } },
      deal: { select: { id: true, title: true } },
    },
  });
  return NextResponse.json({ records });
}
