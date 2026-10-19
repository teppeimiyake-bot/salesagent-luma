/**
 * T04: 継続リクエスト1回ぶんの処理。文字起こしを進め、完了後の最初の継続で
 * 議事録・BANT の分析（既存の runMeetingAnalysis）へつなぐ。
 * 画面の継続リクエスト（POST /api/meetings/[id]/transcription）と cron の両方から呼ぶ。
 */
import { prisma } from "@/lib/db";
import { runMeetingAnalysis } from "@/lib/meetings/analysis";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { advanceMeetingTranscription, TRANSCRIPTION_REQUEST_BUDGET_MS } from "./transcription-runner";
import { readTranscriptionJob, withTranscriptionJob } from "./transcription-job";
import { advanceLongAnalysis } from "./long-analysis";
import { readAnalysisJob } from "./long-analysis-job";

export type ContinueMeetingResult = {
  outcome: "idle" | "leased" | "progressed" | "retrying" | "transcribed" | "error" | "analyzed" | "analysis_in_flight" | "analysis_failed" | "analysis_skipped" | "analysis_accepted";
  message?: string;
};

export async function continueMeetingProcessing(
  meetingId: string,
  { budgetMs = TRANSCRIPTION_REQUEST_BUDGET_MS, allowAnalysis = true }: { budgetMs?: number; allowAnalysis?: boolean } = {},
): Promise<ContinueMeetingResult> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { processingStatus: true, meta: true, transcript: true },
  });
  if (!meeting) return { outcome: "idle" };

  // 長い記録の分析（原文抜粋の抽出→分析）が進行中。
  if (meeting.processingStatus === MEETING_PROCESSING_STATUS.ANALYZING && readAnalysisJob(meeting.meta)) {
    return advanceLongAnalysis(meetingId, { budgetMs, allowPipeline: allowAnalysis });
  }

  const job = readTranscriptionJob(meeting.meta);
  if (meeting.processingStatus === MEETING_PROCESSING_STATUS.TRANSCRIBED && job?.state === "done" && job.autoAnalyze && meeting.transcript?.trim()) {
    if (!allowAnalysis) return { outcome: "analysis_skipped" };
    // 自動分析は1回だけ。「分析中」への切替と自動分析の消費を1回の書込で行い、
    // 途中の状態（文字起こし済み・自動分析なし）を他の画面に見せない。以後の分析は「分析を実行」に任せる。
    const claimedAt = new Date();
    const claimed = await prisma.meeting.updateMany({
      where: { id: meetingId, processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED },
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ANALYZING,
        processingStartedAt: claimedAt,
        processingError: null,
        processingCompletedAt: null,
        meta: withTranscriptionJob(meeting.meta, { ...job, autoAnalyze: false }) as object,
      },
    });
    if (claimed.count !== 1) return { outcome: "analysis_in_flight" };
    const analysis = await runMeetingAnalysis(meetingId, { claimedAt });
    if (analysis.ok) return { outcome: "analyzed" };
    if (analysis.kind === "in_flight") return { outcome: "analysis_in_flight" };
    if (analysis.kind === "accepted") return { outcome: "analysis_accepted" };
    return { outcome: "analysis_failed", message: analysis.kind === "failed" ? analysis.message : undefined };
  }

  return advanceMeetingTranscription(meetingId, { budgetMs });
}
