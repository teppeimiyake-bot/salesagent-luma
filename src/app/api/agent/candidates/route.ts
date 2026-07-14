import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

// エージェント候補の閲覧用一覧（/agent の候補レビュータブ）。
// 閲覧はログインユーザー全員に許可。承認/却下/取り込みは admin API 側で権限チェックする。
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
