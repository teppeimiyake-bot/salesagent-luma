import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/payments/spot
 * スポット入金管理の一覧。一覧＋インライン編集に必要な情報を返す。
 * 並び: 着金見込み日（昇順・null末尾）→ 顧客名。
 */
export async function GET() {
  // Phase 9：入金管理は admin 限定（GET含む）
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Phase 9：プロダクト単位エントリ（dealProductId あり）のみ表示。
  //   CSV由来のソース行（dealProductId=null）はバックフィルの引き継ぎ元として残すが一覧には出さない。
  const records = await prisma.invoiceRecord.findMany({
    where: { dealProductId: { not: null } },
    orderBy: [{ expectedPaymentDate: "asc" }, { customerName: "asc" }],
    include: {
      company: { select: { id: true, name: true } },
      deal: { select: { id: true, title: true } },
      dealProduct: {
        select: {
          id: true,
          productName: true,
          amount: true,
          productionProject: { select: { deliveryDate: true } },
        },
      },
    },
  });
  return NextResponse.json({ records });
}
