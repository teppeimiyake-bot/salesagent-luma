/**
 * 商談履歴のAI分析（7段推論パイプライン）本体。
 *
 * もとは src/app/api/meetings/[id]/analyze/route.ts にベタ書きだった処理を、
 * HTTP以外（Meet成果物の自動取り込み・T16）からも同じ流れを呼べるように関数へ切り出したもの。
 * ルート側は本関数の戻り値をHTTPレスポンスに写すだけの薄い層に変えてあり、
 * ステータスコード・JSONの形は従来と完全に同一。
 */
import { prisma } from "@/lib/db";
import { runPipeline } from "@/lib/ai/pipeline";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { isAutoBantFeatureEnabled } from "@/lib/feature-flags";
import { scheduleDealBantSummary } from "@/lib/ai/summarize-bant";
import { isAnalysisStalled } from "@/lib/meetings/status-payload";
import { isTranscriptionJobMode } from "@/lib/meetings/transcription-job";
import {
  exceedsLongAnalysisLimit,
  exceedsSinglePassLimit,
  LONG_ANALYSIS_EXTRACT_PROMPT_VERSION,
  LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES,
  longAnalysisMustKeepBytes,
  rebuildCondensedSource,
  sha256,
} from "@/lib/ai/long-transcript";
import {
  analysisJobFromInput,
  excerptLimitMessage,
  nextExcerptTarget,
  readAnalysisInput,
  readAnalysisJob,
  resumeOrCreateAnalysisJob,
  withAnalysisInput,
  withAnalysisJob,
  type AnalysisInputSummary,
} from "@/lib/meetings/long-analysis-job";

/** 分析結果。ルートはこの kind を見てステータスコードを決める。 */
export type MeetingAnalysisResult =
  | { ok: true; meetingId: string; result: Awaited<ReturnType<typeof runPipeline>> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "in_flight"; processingStatus: string }
  | { ok: false; kind: "empty" }
  | { ok: false; kind: "failed"; message: string }
  /** 長時間の記録のため、原文抜粋の抽出ジョブとして受け付けた（継続処理が進める）。 */
  | { ok: false; kind: "accepted"; chunks: number };

/** 長時間の記録の分析で、過去の編集ログ1件あたりに渡す上限（抜粋の分析でだけ使う。抜粋の目安22,000バイトの計測の前提）。 */
const LONG_ANALYSIS_PAST_EDIT_CHARS = 100;

/**
 * @param options.claimedAt 呼び出し側が「分析中」への切替を済ませている場合の切替時刻（T04の自動分析）。
 *   その処理権を持ったままのときだけ実行・保存する。
 * @param options.source 長時間の記録の原文抜粋（long-analysis.ts が作る）。指定時は全文の代わりに分析する。
 * @param options.onInputLimit 抜粋でも入力上限に達した場合の扱い（抜粋を小さくして作り直す）。null ならエラーとして保存する。
 */
export async function runMeetingAnalysis(
  meetingId: string,
  options: {
    claimedAt?: Date;
    source?: { text: string; analysisInput: AnalysisInputSummary };
    onInputLimit?: (claim: { id: string; processingStatus: string; processingStartedAt: Date }) => Promise<MeetingAnalysisResult | null>;
  } = {},
): Promise<MeetingAnalysisResult> {
  const id = meetingId;
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      deal: {
        include: {
          company: true,
          products: { select: { productName: true, planName: true, yomiStatus: true, amount: true } },
        },
      },
    },
  });
  if (!meeting || meeting.deal.deletedAt || meeting.deal.company.deletedAt) return { ok: false, kind: "not_found" };

  const hasExistingMinutes = !!meeting.minutes?.trim();
  const sourceText = meeting.transcript?.trim() || meeting.minutes?.trim();
  const preClaimed = options.claimedAt
    && meeting.processingStatus === MEETING_PROCESSING_STATUS.ANALYZING
    && meeting.processingStartedAt?.getTime() === options.claimedAt.getTime();
  if (options.claimedAt && !preClaimed) return { ok: false, kind: "in_flight", processingStatus: meeting.processingStatus };
  // 処理が中断して長く「分析中」のままの記録だけは、再実行で取り直せる（Cloud Runの300秒上限など）。
  // 長い記録の分析を待っている記録も、継続処理の無い環境（ジョブ方式を切った後）では再実行で取り直せる。
  const jobMode = isTranscriptionJobMode();
  const stalled = isAnalysisStalled(meeting) || (!jobMode && meeting.processingStatus === MEETING_PROCESSING_STATUS.ANALYZING
    && meeting.processingStartedAt === null && !!readAnalysisJob(meeting.meta));
  if (!preClaimed && meeting.processingStatus === MEETING_PROCESSING_STATUS.ANALYZING && !stalled) return { ok: false, kind: "in_flight", processingStatus: meeting.processingStatus };
  if (!sourceText) {
    const inflight =
      meeting.processingStatus === MEETING_PROCESSING_STATUS.UPLOADED ||
      meeting.processingStatus === MEETING_PROCESSING_STATUS.TRANSCRIBING;
    if (inflight) {
      return { ok: false, kind: "in_flight", processingStatus: meeting.processingStatus };
    }
    await prisma.meeting.update({
      where: { id },
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ERROR,
        processingError: "Transcript and minutes are both empty.",
        processingCompletedAt: new Date(),
      },
    });
    return { ok: false, kind: "empty" };
  }

  // T04/T22: Cloud Run の検証用 Vertex は1回の入力に上限がある。全文では確実に超える長い記録は、
  // 原文抜粋の抽出ジョブとして受け付け、継続処理（区間ごとに再開）で進める。短い記録は従来どおり。
  const sourceField = meeting.transcript?.trim() ? "transcript" as const : "minutes" as const;
  const sourceSha = sha256(sourceText);
  let source = options.source ?? null;
  let onInputLimit = options.onInputLimit;
  const startLongAnalysis = async (where: Record<string, unknown>): Promise<MeetingAnalysisResult> => {
    const refuse = async (message: string): Promise<MeetingAnalysisResult> => {
      await prisma.meeting.updateMany({
        where,
        data: { processingStatus: MEETING_PROCESSING_STATUS.ERROR, processingError: message, processingCompletedAt: new Date() },
      });
      return { ok: false, kind: "failed", message };
    };
    const size = `約${sourceText.length.toLocaleString("ja-JP")}文字`;
    if (exceedsLongAnalysisLimit(sourceText)) {
      // 抽出の回数と費用が本文の長さに比例して増えるため、上限を超える記録は AI を呼ばずに止める。
      return refuse(`記録は保存済みです。ただし記録が非常に長く（${size}）、長い記録の分析で扱える上限（180分の文字起こしの約1.6倍）を超えるため、議事録・BANTの分析を実行できませんでした。記録を分けて登録してください。この状態では再実行しても同じ結果になります。`);
    }
    if (longAnalysisMustKeepBytes(sourceText) > LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES) {
      // 撤回・訂正・未確認などの必ず残す発言だけで抜粋の上限を超えるなら、抽出しても分析できない（AI を呼ぶ前に止める）。
      return refuse(`記録は保存済みです。ただし撤回・訂正・未確認などの必ず残す発言だけで長い記録の分析の上限を超えるため（${size}）、議事録・BANTの分析を実行できませんでした。記録を分けて登録してください。この状態では再実行しても同じ結果になります。`);
    }
    const existing = readAnalysisJob(meeting.meta);
    if (existing?.stopped === "input_limit" && existing.sourceSha256 === sourceSha && existing.sourceField === sourceField
      && existing.promptVersion === LONG_ANALYSIS_EXTRACT_PROMPT_VERSION) {
      // 同じ本文で抜粋をこれ以上小さくできずに止まった記録は、同じ結果になるので AI を呼ばない。
      return refuse(excerptLimitMessage(sourceText.length, false));
    }
    const job = resumeOrCreateAnalysisJob(existing, sourceText, sourceField, new Date());
    const queued = await prisma.meeting.updateMany({
      where,
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ANALYZING,
        processingError: null,
        processingStartedAt: null,
        processingCompletedAt: null,
        meta: withAnalysisJob(meeting.meta, job) as object,
      },
    });
    if (queued.count !== 1) return { ok: false, kind: "in_flight", processingStatus: MEETING_PROCESSING_STATUS.ANALYZING };
    return { ok: false, kind: "accepted", chunks: job.chunks.length };
  };
  const currentClaim = preClaimed
    ? { id, processingStatus: MEETING_PROCESSING_STATUS.ANALYZING, processingStartedAt: options.claimedAt }
    : { id, processingStatus: meeting.processingStatus, ...(stalled ? { processingStartedAt: meeting.processingStartedAt } : {}) };
  if (!source && jobMode) {
    const savedJob = readAnalysisJob(meeting.meta);
    const saved = readAnalysisInput(meeting.meta);
    const rebuilt = saved && saved.sourceField === sourceField && saved.sourceSha256 === sourceSha
      && saved.promptVersion === LONG_ANALYSIS_EXTRACT_PROMPT_VERSION
      ? rebuildCondensedSource(sourceText, saved.sourceLineIds) : null;
    if (savedJob?.sourceSha256 === sourceSha && savedJob.sourceField === sourceField) {
      // この本文の抜粋の分析が途中で止まった・失敗した記録は、完了済みの区間と縮めた抜粋の目安を残して再開する。
      return startLongAnalysis(currentClaim);
    }
    if (saved && rebuilt) {
      // 同じ本文の再分析では、保存済みの抽出結果から同じ抜粋を作り直す（抽出のAI呼出しを繰り返さない）。
      source = { text: rebuilt, analysisInput: saved };
      // 入力上限に達したら、保存済みの選択から小さい抜粋を作り直すジョブ（抽出なし）として受け付ける。
      onInputLimit = async (claim) => {
        const { next, canShrink } = nextExcerptTarget(LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES, saved.condensedTurnsJsonBytes, saved.selection?.mustKeepBytes ?? 0);
        if (!canShrink || !saved.selectedUnits.length) {
          // これ以上小さくできない。止まった印を残し、次の「分析を実行」では AI を呼ばずに同じ結果を返す。
          const stopped = { ...analysisJobFromInput(sourceText, saved, saved.condensedTurnsJsonBytes, new Date()), stopped: "input_limit" as const };
          await prisma.meeting.updateMany({ where: claim, data: { meta: withAnalysisJob(meeting.meta, stopped) as object } });
          return null;
        }
        const job = analysisJobFromInput(sourceText, saved, next, new Date());
        const queued = await prisma.meeting.updateMany({
          where: claim,
          data: { processingStartedAt: null, processingError: null, meta: withAnalysisJob(meeting.meta, job) as object },
        });
        return queued.count === 1 ? { ok: false, kind: "accepted", chunks: job.chunks.length } : null;
      };
    } else if (exceedsSinglePassLimit(sourceText)) {
      return startLongAnalysis(currentClaim);
    }
  }
  // ここで残っている抽出ジョブは別の本文のもの（古い）。全文での分析の処理権と同時に外し、
  // 画面・継続処理が長い記録の処理と取り違えないようにする。
  const staleJob = !options.source && !!readAnalysisJob(meeting.meta);

  const claimedAt = preClaimed ? options.claimedAt! : new Date();
  const claimed = preClaimed
    ? staleJob
      ? await prisma.meeting.updateMany({ where: currentClaim, data: { meta: withAnalysisJob(meeting.meta, null) as object } })
      : { count: 1 }
    : await prisma.meeting.updateMany({
      where: currentClaim,
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ANALYZING,
        processingError: null,
        processingStartedAt: claimedAt,
        processingCompletedAt: null,
        ...(staleJob ? { meta: withAnalysisJob(meeting.meta, null) as object } : {}),
      },
    });
  // 結果・エラーの保存は、この分析が処理権を持ったままのときだけ。中断扱いで取り直された後に
  // 止まっていた古い分析が再開しても、新しい結果を上書きしない。
  const ownClaim = { id, processingStatus: MEETING_PROCESSING_STATUS.ANALYZING, processingStartedAt: claimedAt };

  if (claimed.count !== 1) return { ok: false, kind: "in_flight", processingStatus: MEETING_PROCESSING_STATUS.ANALYZING };

  try {
    const recentEdits = await prisma.aiLog.findMany({
      where: { dealId: meeting.dealId, step: { in: ["task_user_edit", "bant_user_edit"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    // 抜粋で分析する長い記録では、編集ログ（編集前後の議事録全文を含みうる）を短く切る。
    const clip = (value: string) => source ? value.slice(0, LONG_ANALYSIS_PAST_EDIT_CHARS) : value;
    const pastEdits = recentEdits.map((e) => ({
      aiOutput: clip(JSON.stringify(e.input)),
      userEdit: clip(JSON.stringify(e.userEdit ?? e.output)),
    }));

    const ctx = {
      companyName: meeting.deal.company.name,
      dealTitle: meeting.deal.title,
      industry: meeting.deal.company.industry,
      products: meeting.deal.products
        .map((p) => [p.productName, p.planName].filter(Boolean).join(" / "))
        .filter(Boolean),
      dealProducts: meeting.deal.products,
      pastEdits,
    };

    const result = await runPipeline(source?.text ?? sourceText, ctx);
    const summary = `${result.topSales.real_intent}\n\n勝ち筋: ${result.topSales.winning_scenario}`;

    const saved = await prisma.meeting.updateMany({
      where: ownClaim,
      data: {
        summary,
        issues: result.analysis.issues,
        bantBudget: result.analysis.bant.budget,
        bantAuthority: result.analysis.bant.authority,
        bantNeed: result.analysis.bant.need,
        bantTimeline: result.analysis.bant.timeline,
        structured: result.structured as object,
        analysis: result.analysis as object,
        topSales: result.topSales as object,
        strategy: result.strategy as object,
        nextActions: result.nextActions as object,
        scores: result.scores as object,
        meta: {
          // 抜粋で分析した場合はその記録を残し、全文で分析し直した場合は古い記録を外す。抽出ジョブは完了。
          ...withAnalysisJob(withAnalysisInput(meeting.meta, source?.analysisInput ?? null), null),
          improved: result.improved,
          fallback: result.fallback,
          // backend / fallbackSteps は Vertex 移行の A/B 証跡（どのバックエンドで動き、どの段がフォールバックしたか）。
          fallbackSteps: result.fallbackSteps,
          backend: result.backend,
          recommendationGuard: result.recommendationGuard ?? null,
          t05MinutesFallback: result.meetingMinutes.usedFallback,
          preservedExistingMinutes: hasExistingMinutes,
        },
        processingStatus: MEETING_PROCESSING_STATUS.COMPLETED,
        processingError: null,
        processingCompletedAt: new Date(),
      },
    });
    if (saved.count !== 1) return { ok: false, kind: "in_flight", processingStatus: MEETING_PROCESSING_STATUS.ANALYZING };

    if (!hasExistingMinutes) {
      // A human may have edited minutes while the AI was running.
      await prisma.meeting.updateMany({
        where: { id, minutes: meeting.minutes },
        data: { minutes: result.meetingMinutes.markdown, minutesJson: result.meetingMinutes.json as object },
      });
    }

    for (const t of result.trace) {
      await prisma.aiLog.create({
        data: {
          dealId: meeting.dealId,
          step: t.step,
          input: t.input as object,
          output: t.output as object,
        },
      });
    }

    const top = result.nextActions.next_actions[0];
    // Keep the initial suggestion for an unconfigured deal, but never replace a
    // saved action or combine a new suggestion with an existing due date.
    // The version check also protects an edit-and-clear made while AI ran.
    if (top?.action?.trim() && !meeting.deal.nextAction?.trim() && meeting.deal.nextActionAt === null) {
      await prisma.deal.updateMany({
        where: {
          id: meeting.dealId,
          nextAction: meeting.deal.nextAction,
          nextActionAt: null,
          updatedAt: meeting.deal.updatedAt,
        },
        data: { nextAction: top.action },
      });
    }

    if (isAutoBantFeatureEnabled()) {
      await scheduleDealBantSummary(meeting.dealId, "meeting_analyze_completed");
    }

    return { ok: true, meetingId: id, result };
  } catch (e) {
    const inputLimitError = (e as { code?: unknown } | null)?.code === "input_limit";
    // 全文での分析が途中の段階で入力上限に達した（事前判定より少し短い記録）場合も、抜粋の分析へ切り替える。
    if (inputLimitError && jobMode && !source) return startLongAnalysis(ownClaim);
    if (inputLimitError && source && onInputLimit) {
      const retried = await onInputLimit(ownClaim);
      if (retried) return retried;
    }
    // 長時間録音の文字起こしは、検証用の1回あたりの入力上限を超える。再実行しても同じなので、その旨を明示する。
    const inputLimit = inputLimitError && !!meeting.transcript?.trim();
    const message = inputLimitError && source
      ? `記録は保存済みです。長い記録のため関係する発言を原文のまま抜粋して分析しましたが、これ以上抜粋を小さくできず、現在のAI検証の1回あたりの入力上限を超えたため、議事録・BANTを作成できませんでした（元の記録 約${sourceText.length.toLocaleString("ja-JP")}文字）。この状態では再実行しても同じ結果になります。上限の見直しが必要です。`
      : inputLimit
      ? `文字起こしは保存済みです。ただし文字起こしが長く、現在のAI検証の1回あたりの入力上限を超えるため、議事録・BANTの分析を実行できませんでした（約${sourceText.length.toLocaleString("ja-JP")}文字）。この状態では再実行しても同じ結果になります。長時間録音の分析方式（分割して要約する等）または上限の見直しが必要です。`
      : e instanceof Error ? e.message : "Analysis failed.";
    await prisma.meeting.updateMany({
      where: ownClaim,
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ERROR,
        processingError: message,
        processingCompletedAt: new Date(),
      },
    });
    return { ok: false, kind: "failed", message };
  }
}
