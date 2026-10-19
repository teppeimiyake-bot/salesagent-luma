/**
 * T04/T22: 長時間の記録の分析（継続処理）。
 *
 * 1) extract: 区間ごとに Vertex へ「関係する発言の行番号と、その行の文字どおりの一部」を選ばせ、
 *    原文と一致した選択だけを区間ごとに meta.analysisJob へ保存する（1回の継続は約230秒の範囲）。
 * 2) pipeline: 選んだ行を元の文字どおりに並べた原文抜粋を作り、既存の runMeetingAnalysis（7段の
 *    パイプライン・根拠補正・保存）へそのまま渡す。抜粋の本文は保存せず、行番号を meta.analysisInput に残す。
 * 処理権（リース）は文字起こしと同じく processingStartedAt を時計兼CASトークンに使う（状態は「分析中」）。
 */
import { prisma } from "@/lib/db";
import { callClaudeHeavyJSON } from "@/lib/ai/anthropic";
import { VertexError, VERTEX_MAX_OUTPUT } from "@/lib/ai/vertex-policy";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { runMeetingAnalysis, type MeetingAnalysisResult } from "@/lib/meetings/analysis";
import {
  buildCondensedSource,
  chunkTurns,
  EXTRACT_RESPONSE_SCHEMA,
  extractionPrompt,
  sha256,
  splitLongChunk,
  verifySelections,
} from "@/lib/ai/long-transcript";
import {
  analysisAttemptLimit,
  analysisChunkLabel,
  excerptLimitMessage,
  nextExcerptTarget,
  readAnalysisJob,
  withAnalysisJob,
  type AnalysisInputSummary,
  type AnalysisJob,
} from "./long-analysis-job";

/** 抽出中のリース（保存の間隔の最大は抽出1回の120秒程度）。 */
const EXTRACT_LEASE_MS = 290_000;
/** 分析（7〜9回の AI 呼出し）中のリース。途中で保存しないため長めにとる（15分の中断判定より短く）。 */
const PIPELINE_LEASE_MS = 12 * 60 * 1000;
const REQUEST_BUDGET_MS = 230_000;
const EXTRACT_STEP_RESERVE_MS = 135_000;
/** 分析は1回の継続の冒頭で、残りが十分あるときだけ始める。 */
const PIPELINE_START_RESERVE_MS = 200_000;
const FROZEN_MARGIN_MS = 60_000;
const MAX_STEP_ATTEMPTS = 3;
const MAX_PIPELINE_ATTEMPTS = 2;
/** 議事録・BANT の生成を始める回数の上限（300秒で打ち切られた生成の取り直しも数える）。 */
const MAX_PIPELINE_RUNS = 4;

export type AdvanceLongAnalysisResult = {
  outcome: "idle" | "leased" | "progressed" | "retrying" | "analyzed" | "analysis_failed" | "error";
  message?: string;
};

class LongAnalysisError extends Error {
  constructor(message: string, public transient = false) {
    super(message);
    this.name = "LongAnalysisError";
  }
}

function isTransient(error: unknown) {
  if (error instanceof LongAnalysisError) return error.transient;
  if (error instanceof VertexError) {
    return ["timeout", "transport", "http_429", "retry_exhausted", "ledger_busy"].includes(error.code) || /^(?:http|count)_5\d\d$/.test(error.code);
  }
  // 予算台帳（GCS）の読み書きなど、VertexError に包まれない通信の失敗・時間切れ。
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  if (name === "TimeoutError" || name === "AbortError") return true;
  if (name === "TypeError" && message === "fetch failed") return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034", "EIO", "ETIMEDOUT", "ECONNRESET"].includes(code);
}

function failureMessage(error: unknown) {
  if (error instanceof VertexError || error instanceof LongAnalysisError) return error.message;
  return "発言の抽出中に不明なエラーが発生しました。時間をおいて「分析を実行」を試してください。";
}

/**
 * 抜粋でも入力上限に達したときの扱い。小さくできる間は、実際の抜粋の大きさの0.75倍を目安に次の継続で作り直し
 * （追加の抽出なし）、回数を使い切ったらエラーとして保存する（次の「分析を実行」は、さらに小さい抜粋から始める）。
 * 必ず残す発言（撤回・訂正・未確認など）より小さくはできない。どちらも分析の処理権（claim）を持ったままのときだけ書き込む。
 */
async function requeueSmallerExcerpt(
  claim: { id: string; processingStatus: string; processingStartedAt: Date },
  baseMeta: unknown,
  job: AnalysisJob,
  excerpt: { originalChars: number; bytes: number; mustKeepBytes: number },
  now: () => Date,
): Promise<MeetingAnalysisResult> {
  const { next, canShrink } = nextExcerptTarget(job.targetBytes, excerpt.bytes, excerpt.mustKeepBytes);
  if (canShrink && job.pipelineAttempts < MAX_PIPELINE_ATTEMPTS) {
    const smaller: AnalysisJob = { ...job, targetBytes: next, pipelineAttempts: job.pipelineAttempts + 1, updatedAt: now().toISOString() };
    const requeued = await prisma.meeting.updateMany({ where: claim, data: { processingStartedAt: null, meta: withAnalysisJob(baseMeta, smaller) as object } });
    return requeued.count === 1
      ? { ok: false, kind: "accepted", chunks: job.chunks.length }
      : { ok: false, kind: "in_flight", processingStatus: MEETING_PROCESSING_STATUS.ANALYZING };
  }
  const message = excerptLimitMessage(excerpt.originalChars, canShrink);
  // 小さくできない場合は止まった印を残し、同じ本文の再実行では AI を呼ばずに同じ結果を返す。
  const failedJob: AnalysisJob = canShrink
    ? { ...job, targetBytes: next, updatedAt: now().toISOString() }
    : { ...job, stopped: "input_limit", updatedAt: now().toISOString() };
  const saved = await prisma.meeting.updateMany({
    where: claim,
    data: {
      processingStatus: MEETING_PROCESSING_STATUS.ERROR,
      processingError: message,
      processingCompletedAt: now(),
      meta: withAnalysisJob(baseMeta, failedJob) as object,
    },
  });
  return saved.count === 1
    ? { ok: false, kind: "failed", message }
    : { ok: false, kind: "in_flight", processingStatus: MEETING_PROCESSING_STATUS.ANALYZING };
}

/** 抽出結果から原文抜粋と記録を作る（決定論的。同じ入力なら同じ抜粋）。 */
export function condensedFromJob(job: AnalysisJob, sourceText: string, now: Date): { text: string; analysisInput: AnalysisInputSummary; mustKeepBytes: number } {
  const modelSelections = job.chunks.flatMap(chunk => chunk.selections ?? []);
  const condensed = buildCondensedSource(sourceText, modelSelections, job.chunks, job.targetBytes);
  const stats = job.chunks.reduce((total, chunk) => ({
    accepted: total.accepted + (chunk.stats?.accepted ?? 0),
    relocated: total.relocated + (chunk.stats?.relocated ?? 0),
    rejected: total.rejected + (chunk.stats ? chunk.stats.rejected.invalid_id + chunk.stats.rejected.not_verbatim + chunk.stats.rejected.duplicate : 0),
  }), { accepted: 0, relocated: 0, rejected: 0 });
  return {
    text: condensed.text,
    analysisInput: {
      version: 1,
      mode: "condensed",
      promptVersion: job.promptVersion,
      sourceField: job.sourceField,
      sourceSha256: job.sourceSha256,
      originalChars: sourceText.length,
      condensedChars: condensed.text.length,
      condensedTurnsJsonBytes: condensed.condensedTurnsJsonBytes,
      chunks: job.chunks.length,
      sourceLineIds: condensed.sourceLineIds,
      selectedUnits: condensed.selectedUnits,
      selection: {
        ...stats,
        guardAdded: condensed.guardAdded,
        contextAdded: condensed.contextAdded,
        droppedForBudget: condensed.droppedForBudget,
        guardDropped: condensed.guardDropped,
        skippedLongLines: condensed.skippedLongLines,
        mustKeepBytes: condensed.mustKeepBytes,
        aiDropped: condensed.aiDropped,
        mustKeepMissing: condensed.mustKeepMissing,
      },
      completedAt: now.toISOString(),
    },
    mustKeepBytes: condensed.mustKeepBytes,
  };
}

export async function advanceLongAnalysis(
  meetingId: string,
  { budgetMs = REQUEST_BUDGET_MS, now = () => Date.now(), allowPipeline = true }: { budgetMs?: number; now?: () => number; allowPipeline?: boolean } = {},
): Promise<AdvanceLongAnalysisResult> {
  const startedAt = now();
  const select = { id: true, processingStatus: true, processingStartedAt: true, transcript: true, minutes: true, meta: true } as const;
  const before = await prisma.meeting.findUnique({ where: { id: meetingId }, select });
  if (!before || before.processingStatus !== MEETING_PROCESSING_STATUS.ANALYZING) return { outcome: "idle" };
  const beforeJob = readAnalysisJob(before.meta);
  if (!beforeJob) return { outcome: "idle" };
  const pipelineIdle = (state: AnalysisJob["state"]) => state === "pipeline" && (!allowPipeline || budgetMs < PIPELINE_START_RESERVE_MS);
  if (pipelineIdle(beforeJob.state)) return { outcome: "idle" };

  const leaseMs = beforeJob.state === "pipeline" ? PIPELINE_LEASE_MS : EXTRACT_LEASE_MS;
  let lease = new Date(now());
  const claimed = await prisma.meeting.updateMany({
    where: {
      id: meetingId,
      processingStatus: MEETING_PROCESSING_STATUS.ANALYZING,
      OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(now() - leaseMs) } }],
    },
    data: { processingStartedAt: lease, processingError: null },
  });
  if (claimed.count !== 1) return { outcome: "leased" };
  // 取得の直前に別の継続が進めて手放した場合に古い状態で上書きしないよう、取得後の状態を読み直す。
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId }, select });
  const savedJob = meeting ? readAnalysisJob(meeting.meta) : null;
  if (!meeting || meeting.processingStatus !== MEETING_PROCESSING_STATUS.ANALYZING || meeting.processingStartedAt?.getTime() !== lease.getTime() || !savedJob) {
    return { outcome: "leased" };
  }
  if (pipelineIdle(savedJob.state)) {
    await prisma.meeting.updateMany({
      where: { id: meetingId, processingStatus: MEETING_PROCESSING_STATUS.ANALYZING, processingStartedAt: lease },
      data: { processingStartedAt: null },
    });
    return { outcome: "idle" };
  }

  const baseMeta = meeting.meta;
  let job = savedJob;
  async function save(data: Record<string, unknown>, release = false) {
    const next = release ? null : new Date(Math.max(now(), lease.getTime() + 1));
    const updated = await prisma.meeting.updateMany({
      where: { id: meetingId, processingStatus: MEETING_PROCESSING_STATUS.ANALYZING, processingStartedAt: lease },
      data: { ...data, processingStartedAt: next },
    });
    if (updated.count !== 1) return false;
    if (next) lease = next;
    return true;
  }
  const jobMeta = (nextJob: AnalysisJob) => withAnalysisJob(baseMeta, { ...nextJob, updatedAt: new Date(now()).toISOString() });
  const saveJob = (nextJob: AnalysisJob) => save({ meta: jobMeta(nextJob) });
  const frozen = () => now() - startedAt > budgetMs + FROZEN_MARGIN_MS || now() - lease.getTime() > leaseMs;
  let failedIndex: number | null = null;

  const sourceText = (job.sourceField === "transcript" ? meeting.transcript : meeting.minutes)?.trim() ?? "";
  try {
    if (!sourceText || sha256(sourceText) !== job.sourceSha256) {
      // 古い本文のジョブは残さない（後の通常の分析を長い記録の処理と取り違えないように）。
      await save({
        processingStatus: MEETING_PROCESSING_STATUS.ERROR,
        processingError: "分析の元になる文字起こし・議事録が変更されました。「分析を実行」で最初から分析し直してください。",
        processingCompletedAt: new Date(now()),
        meta: withAnalysisJob(baseMeta, null),
      }, true).catch(() => false);
      return { outcome: "error", message: "分析の元になる文字起こし・議事録が変更されました。「分析を実行」で最初から分析し直してください。" };
    }
    for (;;) {
      const remaining = budgetMs - (now() - startedAt);
      if (job.state === "pipeline") {
        if (!allowPipeline || remaining < PIPELINE_START_RESERVE_MS) break;
        if (job.pipelineRuns >= MAX_PIPELINE_RUNS) {
          throw new LongAnalysisError(`抜粋からの議事録・BANTの生成を${MAX_PIPELINE_RUNS}回始めましたが、時間内に完了しませんでした。時間をおいて「分析を実行」で再実行してください。`);
        }
        // 生成を始めた回数を、抜粋を作る前に保存する（300秒で打ち切られて取り直された場合も数える）。
        const started: AnalysisJob = { ...job, pipelineRuns: job.pipelineRuns + 1 };
        if (!await saveJob(started)) return { outcome: "leased" };
        job = started;
        const running = job;
        const { text, analysisInput, mustKeepBytes } = condensedFromJob(job, sourceText, new Date(now()));
        if (!text.trim()) throw new LongAnalysisError("長い記録から分析に使う発言を抽出できませんでした。「分析を実行」で再実行してください。");
        // 抜粋でも入力上限に達した場合は、抜粋を小さくして次の継続で作り直す（最大2回、追加の抽出なし）。
        const excerpt = { originalChars: sourceText.length, bytes: analysisInput.condensedTurnsJsonBytes, mustKeepBytes };
        const onInputLimit = (claim: { id: string; processingStatus: string; processingStartedAt: Date }) =>
          requeueSmallerExcerpt(claim, baseMeta, running, excerpt, () => new Date(now()));
        const result = await runMeetingAnalysis(meetingId, { claimedAt: lease, source: { text, analysisInput }, onInputLimit });
        if (result.ok) return { outcome: "analyzed" };
        if (result.kind === "accepted") return { outcome: "retrying" };
        if (result.kind === "in_flight") return { outcome: "leased" };
        return { outcome: "analysis_failed", message: result.kind === "failed" ? result.message : undefined };
      }

      const index = job.chunks.findIndex(chunk => chunk.status !== "done");
      if (index < 0) {
        const ready: AnalysisJob = { ...job, state: "pipeline" };
        if (!await saveJob(ready)) return { outcome: "leased" };
        job = ready;
        continue;
      }
      failedIndex = index;
      const pending = job.chunks[index];
      if (pending.attempts >= MAX_STEP_ATTEMPTS) throw new LongAnalysisError(`同じ区間の抽出を${MAX_STEP_ATTEMPTS}回試しても完了しませんでした。`);
      if (job.vertexAttempts >= analysisAttemptLimit(job)) {
        throw new LongAnalysisError("この記録で予定したAI呼び出し回数の上限に達したため、費用保護のため停止しました。利用状況を確認してから再実行してください。");
      }
      if (remaining < EXTRACT_STEP_RESERVE_MS) break;
      const attempted: AnalysisJob = {
        ...job,
        vertexAttempts: job.vertexAttempts + 1,
        chunks: job.chunks.map((chunk, i) => i === index ? { ...chunk, attempts: chunk.attempts + 1 } : chunk),
      };
      if (!await saveJob(attempted)) return { outcome: "leased" };
      job = attempted;

      const turns = chunkTurns(sourceText, pending);
      const prompt = extractionPrompt(turns, pending, job.chunks.length);
      const started = now();
      let raw: Awaited<ReturnType<typeof callClaudeHeavyJSON>>;
      try {
        raw = await callClaudeHeavyJSON({
          feature: "meeting_extract", system: prompt.system, user: prompt.user, json: true,
          responseSchema: EXTRACT_RESPONSE_SCHEMA as unknown as Record<string, unknown>, maxTokens: VERTEX_MAX_OUTPUT, temperature: 0,
        });
      } catch (error) {
        // 1区間の発言が多すぎて出力・入力の上限に達した場合は、区間を半分に分けて送り直す。
        if (error instanceof VertexError && ["incomplete", "input_limit"].includes(error.code) && !frozen()) {
          const halves = splitLongChunk(pending);
          if (halves) {
            const split: AnalysisJob = {
              ...job,
              chunks: [...job.chunks.slice(0, index), ...halves.map(half => ({ ...half, status: "pending" as const, attempts: 0 })), ...job.chunks.slice(index + 1)]
                .map((chunk, i) => ({ ...chunk, index: i })),
            };
            if (!await saveJob(split)) return { outcome: "leased" };
            job = split;
            failedIndex = null;
            continue;
          }
        }
        throw error;
      }
      if (!raw) throw new LongAnalysisError("AIの抽出結果を読み取れませんでした。", true);
      const verified = verifySelections(raw.parsed, turns);
      const usage = raw.usage && typeof raw.usage === "object"
        ? Object.fromEntries(Object.entries(raw.usage).filter(([, value]) => typeof value === "number")) as Record<string, number>
        : undefined;
      const done: AnalysisJob = {
        ...job,
        chunks: job.chunks.map((chunk, i) => i === index
          ? { ...chunk, status: "done", selections: verified.selections, stats: verified.stats, usage, elapsedMs: now() - started, error: undefined }
          : chunk),
      };
      if (!await saveJob(done)) return { outcome: "leased" };
      job = done;
      failedIndex = null;
    }
    // 時間予算を使い切った。完了した区間は保存済みなので、処理権を手放して次の継続に任せる。
    await save({ meta: jobMeta(job) }, true);
    return { outcome: "progressed" };
  } catch (error) {
    const stepAttempts = failedIndex !== null && job.chunks[failedIndex] ? job.chunks[failedIndex].attempts : MAX_STEP_ATTEMPTS;
    if (frozen() || (isTransient(error) && stepAttempts < MAX_STEP_ATTEMPTS && job.vertexAttempts < analysisAttemptLimit(job))) {
      console.warn("[long-analysis] retry later", { meetingId, chunk: failedIndex, frozen: frozen() });
      await save({ meta: jobMeta(job) }, true).catch(() => false);
      return { outcome: "retrying" };
    }
    const detail = failureMessage(error);
    const message = failedIndex !== null && job.chunks[failedIndex]
      ? `${analysisChunkLabel(job, failedIndex)}の発言の抽出に失敗しました: ${detail} 抽出済みの区間は保存済みです。「分析を実行」で失敗した区間から再開します。`
      : detail;
    const failedJob: AnalysisJob = failedIndex !== null
      ? { ...job, chunks: job.chunks.map((chunk, i) => i === failedIndex ? { ...chunk, status: "error", error: detail } : chunk) }
      : job;
    console.error("[long-analysis] failed", { meetingId, chunk: failedIndex, code: error instanceof VertexError ? error.code : error instanceof Error ? error.name : "unknown" });
    await save({
      processingStatus: MEETING_PROCESSING_STATUS.ERROR,
      processingError: message,
      processingCompletedAt: new Date(now()),
      meta: jobMeta(failedJob),
    }, true).catch(() => false);
    return { outcome: "error", message };
  }
}
