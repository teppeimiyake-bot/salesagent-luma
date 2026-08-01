import { NextResponse } from "next/server";
import { prisma, prismaUnscoped } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * POST /api/companies/[id]/restore
 * 企業のソフト削除を解除（admin only）
 * 同時にソフト削除されていた紐づくDealも自動復元
 *
 * 注：Companyを削除すると Deal は連動削除されるため、
 * Deal.deletedAt は Company.deletedAt と同じ時刻が入っている。
 * 復元時はその「Companyと一緒に消されたDealたち」だけを戻す。
 * （Company復元前に単独で消されていた古いDealは消えたまま残す）
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const company = await prisma.company.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!company.deletedAt) {
    return NextResponse.json({ ok: true, alreadyActive: true });
  }

  const deletedAt = company.deletedAt;
  // Companyと同時刻（±2秒の揺れ）で消されたDealだけ復元
  const range = {
    gte: new Date(deletedAt.getTime() - 2000),
    lte: new Date(deletedAt.getTime() + 2000),
  };

  // 企業の復元では、その企業にぶら下がる両社の商談をまとめて戻す必要があるため
  // テナント境界を通さない（prisma を使うと片方の会社の商談だけ復元されてしまう）
  const result = await prismaUnscoped.$transaction([
    prismaUnscoped.deal.updateMany({
      where: { companyId: id, deletedAt: range },
      data: { deletedAt: null },
    }),
    prismaUnscoped.company.update({
      where: { id },
      data: { deletedAt: null },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    restoredDeals: result[0].count,
  });
}
