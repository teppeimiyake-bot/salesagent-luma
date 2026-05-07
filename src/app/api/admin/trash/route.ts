import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/admin/trash
 * ゴミ箱に入っている企業・商談の一覧（admin only）
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  try {
    const [companies, deals] = await Promise.all([
      prisma.company.findMany({
        where: { deletedAt: { not: null } },
        include: {
          _count: { select: { deals: true, contacts: true } },
        },
        orderBy: { deletedAt: "desc" },
      }),
      prisma.deal.findMany({
        where: { deletedAt: { not: null } },
        include: {
          company: { select: { id: true, name: true, logoUrl: true, logoColor: true, deletedAt: true } },
          owner: { select: { id: true, name: true, avatarColor: true } },
          _count: { select: { tasks: true, meetings: true } },
        },
        orderBy: { deletedAt: "desc" },
      }),
    ]);

    return NextResponse.json({ companies, deals });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/admin/trash] error:", msg);
    return NextResponse.json({ error: "Server error", detail: msg }, { status: 500 });
  }
}
