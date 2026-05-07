import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * POST /api/deals/[id]/restore
 * 商談のソフト削除を解除（admin only）
 * 親Companyが削除済みの場合は restore できない（先にCompanyを restore する必要がある）
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const deal = await prisma.deal.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, company: { select: { deletedAt: true } } },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!deal.deletedAt) {
    return NextResponse.json({ ok: true, alreadyActive: true });
  }
  if (deal.company.deletedAt) {
    return NextResponse.json(
      { error: "Parent company is deleted. Restore the company first." },
      { status: 409 },
    );
  }

  await prisma.deal.update({
    where: { id },
    data: { deletedAt: null },
  });
  return NextResponse.json({ ok: true });
}
