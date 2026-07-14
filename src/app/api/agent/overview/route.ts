import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

// エージェントメイン画面（/agent）の概況データ。
// ログイン済みユーザーなら閲覧可能（承認・取り込みなどの変更操作は admin API 側で制御）。
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [statusCounts, runCount, runs, recent] = await Promise.all([
    prisma.agentCandidate.groupBy({
      by: ["reviewStatus"],
      _count: { _all: true },
    }),
    prisma.agentRun.count(),
    prisma.agentRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        source: true,
        agentRunId: true,
        createdAt: true,
        _count: { select: { candidates: true } },
      },
    }),
    prisma.agentCandidate.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        companyName: true,
        industry: true,
        websiteUrl: true,
        contactFormUrl: true,
        reviewStatus: true,
        createdAt: true,
        run: { select: { source: true } },
      },
    }),
  ]);

  const counts: Record<string, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    ingested: 0,
  };
  let total = 0;
  for (const row of statusCounts) {
    counts[row.reviewStatus] = row._count._all;
    total += row._count._all;
  }

  return NextResponse.json({
    counts: { ...counts, total },
    runCount,
    runs: runs.map((r) => ({
      id: r.id,
      source: r.source,
      agentRunId: r.agentRunId,
      createdAt: r.createdAt,
      candidateCount: r._count.candidates,
    })),
    recent,
  });
}
