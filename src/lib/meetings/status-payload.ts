/**
 * 商談記録の処理状態を画面へ返す形。本文・録音URL・meta は返さない。
 * 継続処理（T04）の進捗と、中断して止まった処理の判定もここで行う。
 */
import { isTranscriptionJobMode, readTranscriptionJob, transcriptionProgress } from "./transcription-job";
import { analysisProgress, readAnalysisInput, readAnalysisJob } from "./long-analysis-job";

/** 分析がこれより長く「分析中」のままなら、中断したとみなして再実行を許可する。 */
export const ANALYSIS_STALE_MS = 15 * 60 * 1000;
/** リクエスト内で処理する経路の文字起こしが、これより長く処理中なら再実行を許可する。 */
export const INLINE_TRANSCRIPTION_STALE_MS = 10 * 60 * 1000;

export const MEETING_STATUS_SELECT = {
  id: true,
  processingStatus: true,
  processingError: true,
  durationSec: true,
  audioSizeBytes: true,
  processingStartedAt: true,
  processingCompletedAt: true,
  transcript: true,
  minutes: true,
  summary: true,
  recordingUrl: true,
  meta: true,
} as const;

export type MeetingStatusRow = {
  id: string;
  processingStatus: string;
  processingError: string | null;
  durationSec: number | null;
  audioSizeBytes: number | null;
  processingStartedAt: Date | null;
  processingCompletedAt: Date | null;
  transcript: string | null;
  minutes: string | null;
  summary: string | null;
  recordingUrl: string | null;
  meta: unknown;
};

export function olderThan(value: Date | null | undefined, ms: number, now = Date.now()) {
  return !!value && now - value.getTime() > ms;
}

export function isAnalysisStalled(row: Pick<MeetingStatusRow, "processingStatus" | "processingStartedAt">, now = Date.now()) {
  return row.processingStatus === "analyzing" && olderThan(row.processingStartedAt, ANALYSIS_STALE_MS, now);
}

export function meetingStatusPayload(row: MeetingStatusRow, now = Date.now()) {
  const jobMode = isTranscriptionJobMode();
  const job = jobMode ? readTranscriptionJob(row.meta) : null;
  const progress = transcriptionProgress(job);
  const transcribing = row.processingStatus === "uploaded" || row.processingStatus === "transcribing";
  return {
    id: row.id,
    processingStatus: row.processingStatus,
    processingError: row.processingError,
    durationSec: row.durationSec,
    audioSizeBytes: row.audioSizeBytes,
    processingStartedAt: row.processingStartedAt,
    processingCompletedAt: row.processingCompletedAt,
    hasTranscript: !!row.transcript?.trim(),
    hasMinutes: !!row.minutes,
    hasSummary: !!row.summary,
    hasRecording: !!row.recordingUrl,
    // 長い記録の分析を待っている記録は、継続処理の無い環境（ジョブ方式を切った後）では止まったままになるため再実行を許す。
    analysisStalled: isAnalysisStalled(row, now)
      || (!jobMode && row.processingStatus === "analyzing" && row.processingStartedAt === null && !!readAnalysisJob(row.meta)),
    // 継続処理の環境ではリースの期限切れで自動的に再開するため、止まった表示はリクエスト内処理の環境だけ。
    transcriptionStalled: !jobMode && transcribing && olderThan(row.processingStartedAt, INLINE_TRANSCRIPTION_STALE_MS, now),
    // 長い記録の分析（原文抜粋の抽出→分析）の進捗。
    analysis: (() => {
      const progress = jobMode ? analysisProgress(readAnalysisJob(row.meta)) : null;
      return progress && row.processingStatus === "analyzing"
        ? { mode: "long" as const, ...progress, waiting: row.processingStartedAt === null }
        : null;
    })(),
    // 抜粋で分析した記録の要約（画面の注記用。行番号の一覧は返さない）。
    analysisInput: (() => {
      const input = readAnalysisInput(row.meta);
      return input
        ? {
          originalChars: input.originalChars, condensedChars: input.condensedChars, chunks: input.chunks,
          // 抜粋に入らなかった AI の選択の数と、行が長すぎて入らなかった必ず残す発言の数（画面の注記用）。
          omitted: input.selection?.aiDropped ?? (input.selection?.droppedForBudget ?? 0) + (input.selection?.skippedLongLines ?? 0),
          mustKeepMissing: input.selection?.mustKeepMissing ?? 0,
        }
        : null;
    })(),
    // 動画・分割アップロードの再生用音声（正規化済み）が用意できているか。文字起こしの成否とは別。
    playbackReady: !!job?.playbackFile,
    transcription: jobMode && row.recordingUrl
      ? {
        mode: "job" as const,
        state: progress?.state ?? (transcribing ? "prepare" as const : null),
        completed: progress?.completed ?? 0,
        total: progress?.total ?? 0,
        durationSec: progress?.durationSec ?? null,
        // 処理権を持つ処理が無い＝画面の継続リクエストを待っている。
        waiting: transcribing && row.processingStartedAt === null,
        autoAnalyzePending: row.processingStatus === "transcribed" && job?.state === "done" && job.autoAnalyze && !!row.transcript?.trim(),
      }
      : null,
  };
}
