import { NextResponse } from "next/server";
import { prisma, prismaUnscoped } from "@/lib/db";
import { isValidCronSecret } from "@/lib/agent-auth";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { continueMeetingProcessing } from "@/lib/meetings/transcription-continue";
import { isTranscriptionJobMode, readTranscriptionJob } from "@/lib/meetings/transcription-job";
import { TRANSCRIPTION_REQUEST_BUDGET_MS } from "@/lib/meetings/transcription-runner";
import { runAsTenant } from "@/lib/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 7日より古い未完了の記録は追いかけない（利用者の再実行に任せる）。 */
const LOOKBACK_DAYS = 7;
const MAX_MEETINGS_PER_RUN = 10;
/** 分析は1件で数十秒〜数分かかるため、起動直後の余裕があるときだけ始める。 */
const ANALYSIS_START_LIMIT_MS = 30_000;
/**
 * この結果で終わった記録は、同じ実行の中で続けて進める（分析待ちの一覧は実行の冒頭で取り終わっているため、
 * 次の実行を待つと5分遅れる）。文字起こしの完了→自動分析、長い記録の分析の受付→原文抜粋の抽出。
 */
const CHAINED_OUTCOMES: ReadonlySet<string> = new Set(["transcribed", "analysis_accepted"]);
/** 1件あたりの継続の呼出しの上限（文字起こし→分析→抜粋の抽出）。 */
const MAX_STEPS_PER_MEETING = 3;

/**
 * T04: 画面を閉じた後も文字起こし・分析を進めるための定期処理。
 * 画面の継続リクエストと同じ continueMeetingProcessing を呼び、処理権（リース）で二重処理を防ぐ。
 * Cloud Scheduler などから CRON_SECRET 付きで呼ぶ（スケジュール設定は運用作業）。
 */
async function handleMeetingTranscriptionsCron(req: Request) {
  if (!isValidCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isTranscriptionJobMode()) return NextResponse.json({ skipped: true });

  const started = Date.now();
  const since = new Date(started - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const tenants = await prismaUnscoped.tenant.findMany({ where: { active: true }, select: { code: true }, orderBy: { sortOrder: "asc" } });
  const results: Array<{ tenant: string; meetingId: string; outcome: string; steps?: string[] }> = [];
  let timeBudgetSkipped = 0;

  for (const tenant of tenants) {
    if (results.length >= MAX_MEETINGS_PER_RUN) break;
    const rows = await runAsTenant(tenant.code, async () => {
      const common = {
        createdAt: { gte: since },
        recordingUrl: { not: null },
        deal: { deletedAt: null, company: { deletedAt: null } },
      };
      const take = MAX_MEETINGS_PER_RUN - results.length;
      // 文字起こし中のものと、継続処理が作った自動分析待ちのものを別々に取る（分析済みの記録で枠を使わない）。
      const transcribing = await prisma.meeting.findMany({
        where: { ...common, processingStatus: { in: [MEETING_PROCESSING_STATUS.UPLOADED, MEETING_PROCESSING_STATUS.TRANSCRIBING] } },
        select: { id: true, processingStatus: true, meta: true },
        orderBy: { createdAt: "asc" },
        take,
      });
      const awaitingAnalysis = transcribing.length < take
        ? await prisma.meeting.findMany({
          where: {
            ...common,
            processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED,
            AND: [
              { meta: { path: ["transcriptionJob", "state"], equals: "done" } },
              { meta: { path: ["transcriptionJob", "autoAnalyze"], equals: true } },
            ],
          },
          select: { id: true, processingStatus: true, meta: true },
          orderBy: { createdAt: "asc" },
          take: take - transcribing.length,
        })
        : [];
      const analyzingLong = transcribing.length + awaitingAnalysis.length < take
        ? await prisma.meeting.findMany({
          where: {
            createdAt: { gte: since },
            deal: { deletedAt: null, company: { deletedAt: null } },
            processingStatus: MEETING_PROCESSING_STATUS.ANALYZING,
            meta: { path: ["analysisJob", "version"], equals: 1 },
          },
          select: { id: true, processingStatus: true, meta: true },
          orderBy: { createdAt: "asc" },
          take: take - transcribing.length - awaitingAnalysis.length,
        })
        : [];
      const tenantRows: Array<{ tenant: string; meetingId: string; outcome: string; steps?: string[] }> = [];
      for (const meeting of [...transcribing, ...awaitingAnalysis, ...analyzingLong]) {
        const job = readTranscriptionJob(meeting.meta);
        if (meeting.processingStatus === MEETING_PROCESSING_STATUS.TRANSCRIBED && !(job?.state === "done" && job.autoAnalyze)) continue;
        const remaining = TRANSCRIPTION_REQUEST_BUDGET_MS - (Date.now() - started);
        if (remaining <= 0) {
          timeBudgetSkipped++;
          continue;
        }
        const steps: string[] = [];
        try {
          let result = await continueMeetingProcessing(meeting.id, {
            budgetMs: remaining,
            allowAnalysis: Date.now() - started < ANALYSIS_START_LIMIT_MS,
          });
          steps.push(result.outcome);
          // 文字起こしが終わった記録は、分析を始めてよい時間のうちなら続けて分析まで進める。時間の判断・処理権は
          // 冒頭の呼出しと同じ（分析は TRANSCRIBED からの条件付き更新で取るので、画面の継続要求と二重にならない）。
          // 間に合わなければ自動分析の印を残したまま、次の実行の自動分析待ちに回す。
          // BANT の自動集約（分析の保存後に scheduleDealBantSummary が集約中の印を待って行う）は、記録を「完了」に
          // してから始まり、記録の処理権とは別の印なので、ここで続けても印の取り合いにはならない。
          while (CHAINED_OUTCOMES.has(result.outcome) && steps.length < MAX_STEPS_PER_MEETING) {
            const elapsed = Date.now() - started;
            const allowAnalysis = elapsed < ANALYSIS_START_LIMIT_MS;
            const left = TRANSCRIPTION_REQUEST_BUDGET_MS - elapsed;
            if (left <= 0 || (result.outcome === "transcribed" && !allowAnalysis)) break;
            const next = await continueMeetingProcessing(meeting.id, { budgetMs: left, allowAnalysis });
            steps.push(next.outcome);
            // 続きがなかった（自動分析の対象でない等）ときは、直前の結果を記録の結果として残す。
            if (next.outcome === "idle") break;
            result = next;
          }
          tenantRows.push({ tenant: tenant.code, meetingId: meeting.id, outcome: result.outcome, ...(steps.length > 1 ? { steps } : {}) });
        } catch (error) {
          // 1件の失敗で残りの記録・会社を止めない。
          console.error("[cron/meeting-transcriptions] continuation failed", { meetingId: meeting.id, name: error instanceof Error ? error.name : "unknown" });
          tenantRows.push({ tenant: tenant.code, meetingId: meeting.id, outcome: "exception", ...(steps.length ? { steps } : {}) });
        }
      }
      return tenantRows;
    });
    results.push(...rows);
  }

  return NextResponse.json({ skipped: false, processed: results.length, timeBudgetSkipped, results });
}

export async function GET(req: Request) {
  return handleMeetingTranscriptionsCron(req);
}

export async function POST(req: Request) {
  return handleMeetingTranscriptionsCron(req);
}
