import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// エージェント候補の一覧（admin レビュー画面用）。?status=pending/approved/rejected/ingested で絞込。
export async function GET(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const where = status ? { reviewStatus: status } : {};

  const candidates = await prisma.agentCandidate.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { run: { select: { source: true, agentRunId: true } } },
  });

  const counts = await prisma.agentCandidate.groupBy({
    by: ["reviewStatus"],
    _count: { _all: true },
  });

  return NextResponse.json({ candidates, counts });
}
