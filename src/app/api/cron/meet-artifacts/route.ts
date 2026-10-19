import { NextResponse } from "next/server";
import { prisma, prismaUnscoped } from "@/lib/db";
import { isValidCronSecret } from "@/lib/agent-auth";
import { isMeetAutoRecordEnabled } from "@/lib/feature-flags";
import { MEET_ARTIFACT_MAX_ATTEMPTS, ingestDealMeetArtifacts } from "@/lib/meetings/meet-ingest";
import { runAsTenant } from "@/lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 1回の起動で取り込む商談の上限。長時間関数を1本で使い切らないための歯止め。 */
const MAX_DEALS_PER_RUN = 5;
/**
 * 会議記録はMeet側で30日で消えるため、7日より古い商談は追いかけない。
 * 画面はこの期間を過ぎても成果物が無い商談を「要対応」にする（src/lib/meetings/meet-phase.ts の
 * MEET_ARTIFACT_LOOKBACK_DAYS）。値は必ず揃える（tests/t16-cron-budget.test.mjs で突き合わせている）。
 * 試行上限（MEET_ARTIFACT_MAX_ATTEMPTS）に達した商談は、取り込み側が failed で確定するので「成果物待ち」のまま残らない。
 */
const LOOKBACK_DAYS = 7;
/**
 * この経過時間を過ぎたら新しい商談の取り込みを始めない。
 * Cloud Run のリクエスト上限（300秒）に対し、1件の取り込み（文字起こし取得＋AI分析）が
 * 長引いても途中で打ち切られないよう半分で止め、残りは次回の起動で拾う。
 */
const TIME_BUDGET_MS = 150 * 1000;

/**
 * T16: 終了済み商談のMeet成果物を定期的に取り込む。
 * 手動導線（POST /api/deals/[id]/meet/artifacts）と同じ関数を叩くだけなので、
 * cronが止まっていても担当者が画面から取得できる。
 */
async function handleMeetArtifactsCron(req: Request) {
  const startedAt = Date.now();
  const overBudget = () => Date.now() - startedAt >= TIME_BUDGET_MS;

  if (!isValidCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isMeetAutoRecordEnabled()) {
    return NextResponse.json({ skipped: true });
  }

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const tenants = await prismaUnscoped.tenant.findMany({
    where: { active: true },
    select: { code: true },
    orderBy: { sortOrder: "asc" },
  });

  let processed = 0;
  // 時間切れで着手しなかった商談の数（次回の起動で拾う）。
  // 時間切れ後のテナントは問い合わせないので下限値であり、実際に残った件数はこれより多いことがある。
  let timeBudgetSkipped = 0;
  // 時間切れで打ち切ったか。true なら timeBudgetSkipped 以外にも未処理の商談が残っている可能性がある。
  let timeBudgetExhausted = false;
  const results: Array<{ tenant: string; dealId: string; status: string; message: string }> = [];

  for (const tenant of tenants) {
    const remaining = MAX_DEALS_PER_RUN - processed;
    if (remaining <= 0) break;
    if (overBudget()) {
      timeBudgetExhausted = true;
      break;
    }

    const tenantResults = await runAsTenant(tenant.code, async () => {
      const deals = await prisma.deal.findMany({
        where: {
          deletedAt: null,
          company: { deletedAt: null },
          meetingOwnerType: "own_meet",
          meetEventId: { not: null },
          meetingEndAt: { lt: now, gte: since },
          meetArtifactStatus: { in: ["waiting", "fetching"] },
          meetArtifactAttempts: { lt: MEET_ARTIFACT_MAX_ATTEMPTS },
        },
        select: { id: true },
        orderBy: { meetingEndAt: "desc" },
        take: remaining,
      });

      // meetArtifactStatus が NULL（未着手）の商談は in 条件で拾えないので別に引く。
      const untouched =
        deals.length < remaining
          ? await prisma.deal.findMany({
              where: {
                deletedAt: null,
                company: { deletedAt: null },
                meetingOwnerType: "own_meet",
                meetEventId: { not: null },
                meetingEndAt: { lt: now, gte: since },
                meetArtifactStatus: null,
                meetArtifactAttempts: { lt: MEET_ARTIFACT_MAX_ATTEMPTS },
              },
              select: { id: true },
              orderBy: { meetingEndAt: "desc" },
              take: remaining - deals.length,
            })
          : [];

      const rows: Array<{ tenant: string; dealId: string; status: string; message: string }> = [];
      for (const deal of [...deals, ...untouched]) {
        if (overBudget()) {
          timeBudgetExhausted = true;
          timeBudgetSkipped++;
          continue;
        }
        const result = await ingestDealMeetArtifacts(deal.id, { trigger: "cron" });
        rows.push({ tenant: tenant.code, dealId: deal.id, status: result.status, message: result.message });
      }
      return rows;
    });

    processed += tenantResults.length;
    results.push(...tenantResults);
    if (processed >= MAX_DEALS_PER_RUN) break;
  }

  return NextResponse.json({
    skipped: false,
    processed,
    fetched: results.filter((r) => r.status === "fetched").length,
    waiting: results.filter((r) => r.status === "waiting").length,
    failed: results.filter((r) => r.status === "failed").length,
    timeBudgetSkipped,
    timeBudgetExhausted,
    results,
  });
}

export async function GET(req: Request) {
  return handleMeetArtifactsCron(req);
}
