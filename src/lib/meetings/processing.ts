import path from "node:path";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { transcribeFileWithMetrics } from "@/lib/ai/openai";
import { cleanupTempFile, fetchStored, writeTempFile } from "@/lib/storage";
import { isTranscriptionJobMode } from "@/lib/meetings/transcription-job";

export const MEETING_PROCESSING_STATUS = {
  UPLOADED: "uploaded",
  TRANSCRIBING: "transcribing",
  TRANSCRIBED: "transcribed",
  ANALYZING: "analyzing",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

const INLINE_GEMINI_LIMIT_BYTES = 18 * 1024 * 1024;

/**
 * 文字起こしを起動する。
 * - Cloud Run（Vertex検証）: 何もしない。POST /api/meetings/[id]/transcription の継続処理が
 *   区間ごとに進める（transcription-runner.ts）。リクエスト外にCPUが割り当てられないため。
 * - ローカル/dev: リクエスト内で await（レスポンス後の fire-and-forget は打ち切られるため）
 * - 本番(Vercel): after() でレスポンス後に継続
 */
export async function scheduleMeetingTranscription(meetingId: string): Promise<void> {
  if (isTranscriptionJobMode()) return;
  const runInline = process.env.NODE_ENV !== "production" || !process.env.VERCEL;

  if (runInline) {
    await processMeetingTranscription(meetingId);
    return;
  }

  try {
    after(() => {
      return processMeetingTranscription(meetingId).catch((e) => {
        console.error("[meeting-processing] unhandled transcription error", {
          meetingId,
          message: e instanceof Error ? e.message : String(e),
        });
      });
    });
  } catch (e) {
    console.warn("[meeting-processing] after() unavailable; running inline", e);
    await processMeetingTranscription(meetingId);
  }
}

export async function processMeetingTranscription(meetingId: string) {
  let tmp: string | null = null;
  console.log("[meeting-processing] transcription start", { meetingId });

  try {
    const claimed = await prisma.meeting.updateMany({
      where: { id: meetingId, processingStatus: MEETING_PROCESSING_STATUS.UPLOADED },
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBING,
        processingError: null,
        processingStartedAt: new Date(),
        processingCompletedAt: null,
      },
    });

    if (claimed.count !== 1) return;

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        recordingUrl: true,
        audioSizeBytes: true,
        durationSec: true,
        meta: true,
      },
    });

    if (!meeting?.recordingUrl) {
      throw new Error("録音ファイルが保存されていないため、文字起こしを開始できません。");
    }

    const fetched = await fetchStored(meeting.recordingUrl);
    if (!fetched) {
      throw new Error("保存済み録音ファイルを読み込めませんでした。Blob設定または ./uploads のファイルを確認してください。");
    }

    const ext = path.extname(meeting.recordingUrl.split("?")[0] ?? "") || ".webm";
    tmp = await writeTempFile(`meeting_${meetingId}${ext}`, fetched.buffer);
    const transcription = await transcribeFileWithMetrics(tmp);
    const transcript = transcription.text;

    if (!transcript?.trim()) {
      const size = meeting.audioSizeBytes ?? fetched.buffer.byteLength;
      const sizeMB = (size / (1024 * 1024)).toFixed(1);
      const detail =
        size > INLINE_GEMINI_LIMIT_BYTES
          ? `録音サイズが18MBを超えています（${sizeMB}MB）。Gemini Files APIで文字起こしできませんでした。APIキー、Files APIの利用可否、音声形式を確認してください。`
          : "Gemini文字起こし結果が空でした。APIキー、音声形式、録音内容を確認してください。";
      throw new Error(detail);
    }

    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        transcript: transcript.trim(),
        processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED,
        processingError: null,
        processingCompletedAt: new Date(),
        meta: {
          ...(meeting.meta && typeof meeting.meta === "object" && !Array.isArray(meeting.meta)
            ? meeting.meta
            : {}),
          transcription: {
            ...transcription.metrics,
            inputDurationSec: meeting.durationSec,
          },
        },
      },
    });
    console.log("[meeting-processing] transcription done", {
      meetingId,
      chars: transcript.trim().length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "文字起こし中に不明なエラーが発生しました。";
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        processingStatus: MEETING_PROCESSING_STATUS.ERROR,
        processingError: message,
        processingCompletedAt: new Date(),
      },
    });
    console.error("[meeting-processing] transcription failed", { meetingId, message });
  } finally {
    if (tmp) await cleanupTempFile(tmp);
  }
}
