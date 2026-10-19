import { prisma } from "@/lib/db";

/**
 * QG26-03: AI再集約（summarize-bant）の二重実行防止。
 *
 * AI再分析が meeting.processingStatus の条件付き更新で2本目を 409 にしているのと同じ考え方で、
 * 商談ごとに「集約中」の印を1つだけ持たせる。商談テーブルに列を足さずに済むよう、印は
 * ai_logs の1行（step = BANT_SUMMARY_IN_FLIGHT_STEP）で表す。印の確認と作成は商談ごとの
 * advisory lock（トランザクション単位。見積の確定と同じ方法）の中で行うので、同時の2本でも
 * 印を作れるのは1本だけになる。
 *
 * 印は実行が終われば（失敗しても）消す。インスタンスが落ちて消せなかった印は
 * BANT_SUMMARY_LOCK_TTL_MS を過ぎると無効になり、次の取得のときに片付ける。
 */
export const BANT_SUMMARY_IN_FLIGHT_STEP = "bant_summary_in_flight";
// summarize-bant の maxDuration（30秒）と AI 呼び出しの再試行に十分な余裕を持たせた期限。
export const BANT_SUMMARY_LOCK_TTL_MS = 3 * 60 * 1000;

export type BantSummaryLease = { id: string };

/** 集約中の印を取る。ほかの集約が実行中なら null（AI は呼ばない）。 */
export async function acquireBantSummaryLock(dealId: string, trigger: string): Promise<BantSummaryLease | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bant-summary:${dealId}`}))`;
    const since = new Date(Date.now() - BANT_SUMMARY_LOCK_TTL_MS);
    const running = await tx.aiLog.findFirst({
      where: { dealId, step: BANT_SUMMARY_IN_FLIGHT_STEP, createdAt: { gte: since } },
      select: { id: true },
    });
    if (running) return null;
    // 期限切れの印（途中で落ちた実行の残り）はここで片付ける。
    await tx.aiLog.deleteMany({ where: { dealId, step: BANT_SUMMARY_IN_FLIGHT_STEP, createdAt: { lt: since } } });
    const lease = await tx.aiLog.create({
      data: {
        dealId,
        step: BANT_SUMMARY_IN_FLIGHT_STEP,
        input: { trigger, ttlMs: BANT_SUMMARY_LOCK_TTL_MS } as object,
        output: {} as object,
      },
      select: { id: true },
    });
    return { id: lease.id };
  });
}

/** 自分が取った印だけを消す。 */
export async function releaseBantSummaryLock(lease: BantSummaryLease): Promise<void> {
  await prisma.aiLog.deleteMany({ where: { id: lease.id, step: BANT_SUMMARY_IN_FLIGHT_STEP } });
}

// 会議後の自動集約が実行中の集約を待つときの確認間隔。
const BANT_SUMMARY_LOCK_POLL_MS = 1000;

/**
 * 印が取れるまで待つ（会議後の自動集約用）。実行中の集約は印の期限までに終わるか期限切れになるので、
 * 待つのは最長でも期限＋少しだけ。それでも取れなければ null。
 */
export async function waitForBantSummaryLock(dealId: string, trigger: string): Promise<BantSummaryLease | null> {
  const deadline = Date.now() + BANT_SUMMARY_LOCK_TTL_MS + 10 * 1000;
  for (;;) {
    const lease = await acquireBantSummaryLock(dealId, trigger);
    if (lease || Date.now() >= deadline) return lease;
    await new Promise((resolve) => setTimeout(resolve, BANT_SUMMARY_LOCK_POLL_MS));
  }
}
