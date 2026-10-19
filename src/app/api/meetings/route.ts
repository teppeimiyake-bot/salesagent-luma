import { NextResponse } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import {
  putFile,
  StorageConfigError,
} from "@/lib/storage";
import {
  MEETING_PROCESSING_STATUS,
  scheduleMeetingTranscription,
} from "@/lib/meetings/processing";
import { extractAttachmentText } from "@/lib/meetings/attachment-text";
import { isTranscriptionJobMode } from "@/lib/meetings/transcription-job";
import { mediaToolsAvailable } from "@/lib/meetings/audio-segments";
import {
  fileExtension,
  isMediaAttachmentExtension,
  isTextAttachmentExtension,
  unsupportedAttachmentMessage,
} from "@/lib/meetings/upload-formats";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

const createSchema = z.object({
  dealId: z.string().uuid(),
  title: z.string().trim().max(200).optional(),
  minutes: z.string().optional(),
  transcript: z.string().optional(),
  meetingDate: z.string().datetime().optional(),
  // 手動の記録追加だけは、本文を後から編集する空の記録を明示的に作成できる。
  createDraft: z.literal(true).optional(),
}).refine(data => data.createDraft === true || Boolean(data.minutes?.trim() || data.transcript?.trim()), "本文を入力してください");

export async function POST(req: Request) {
  // middleware を大容量 upload のためバイパスしているので、ここで認証する
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();

  async function validDeal(dealId: string) {
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { deletedAt: true, company: { select: { deletedAt: true } } } });
    return deal && !deal.deletedAt && !deal.company.deletedAt;
  }

  const ct = req.headers.get("content-type") ?? "";
  const contentLength = req.headers.get("content-length");

  if (ct.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch (e) {
      const err = e as Error;
      console.error("[api/meetings] formData parse failed:", {
        message: err?.message,
        contentLength,
        contentType: ct,
      });
      return NextResponse.json(
        {
          error:
            "アップロードデータの解析に失敗しました。動画が大きすぎるか、通信が途中で切れた可能性があります。可能なら音声(mp3/m4a/webm)に書き出して再試行してください。",
          debug: {
            contentLength,
            parseError: err?.message ?? null,
          },
        },
        { status: 400 },
      );
    }
    const dealId = form.get("dealId");
    const file = form.get("file") as File | null;
    const durationSecRaw = form.get("durationSec");
    const durationSec =
      typeof durationSecRaw === "string" && /^\d+$/.test(durationSecRaw)
        ? Number(durationSecRaw)
        : null;

    if (typeof dealId !== "string" || !z.string().uuid().safeParse(dealId).success || !(file instanceof File)) {
      return NextResponse.json({ error: "dealId and file are required" }, { status: 400 });
    }
    if (!await validDeal(dealId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (durationSec !== null && (!Number.isSafeInteger(durationSec) || durationSec > 2147483647)) {
      return NextResponse.json({ error: "Invalid duration" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json(
        { error: "Recording data is empty. Check microphone/tab audio permission and try again." },
        { status: 400 },
      );
    }

    const ext = fileExtension(file.name);
    if (!isTextAttachmentExtension(ext) && !isMediaAttachmentExtension(ext)) {
      return NextResponse.json(
        { error: unsupportedAttachmentMessage(file.name), code: "UNSUPPORTED_ATTACHMENT_TYPE" },
        { status: 415 },
      );
    }

    // Cloud Run（Vertex検証）では ffmpeg で音声を正規化・区間分割するため、長時間録音・動画も受け付ける。
    // ffmpeg が無いイメージでは、1回で送れる6MB以下の音声だけに限る（T04以前の制限）。
    const jobMode = isTranscriptionJobMode();
    if (jobMode && isMediaAttachmentExtension(ext)
      && (file.size > 6 * 1024 * 1024 || !["wav", "webm", "mp3", "m4a", "ogg", "flac"].includes(ext))
      && !await mediaToolsAvailable()) {
      return NextResponse.json({ error: "AI接続検証では6MB以下のWAV・WebM・MP3・M4A・OGG・FLAC音声を使用してください。", code: "VERIFICATION_AUDIO_LIMIT" }, { status: 413 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (isTextAttachmentExtension(ext)) {
      let transcript: string;
      try {
        transcript = extractAttachmentText(file.name, buf);
      } catch (error) {
        return NextResponse.json(
          {
            error: error instanceof Error ? error.message : "添付ファイルから本文を抽出できませんでした。",
            code: "ATTACHMENT_TEXT_EXTRACTION_FAILED",
          },
          { status: 422 },
        );
      }

      const meeting = await prisma.meeting.create({
        data: {
          dealId,
          title: file.name,
          transcript,
          audioSizeBytes: file.size,
          sourceType: "manual_text",
          processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED,
          processingError: null,
          processingStartedAt: new Date(),
          processingCompletedAt: new Date(),
          meta: {
            attachment: {
              filename: file.name,
              extension: ext,
              extractedChars: transcript.length,
              skippedTranscription: true,
            },
          },
        },
      });
      return NextResponse.json(
        { meeting, ingestType: "text_attachment", skippedTranscription: true },
        { status: 201 },
      );
    }

    const safeName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;

    let recordingUrl: string;
    try {
      ({ url: recordingUrl } = await putFile({
        dir: "recordings",
        filename: safeName,
        buffer: buf,
        contentType: file.type || undefined,
      }));
    } catch (e) {
      const err = e as Error;
      console.error("[api/meetings] putFile failed:", {
        name: err?.name,
        message: err?.message,
        blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
        onVercel: !!process.env.VERCEL,
      });
      const base =
        e instanceof StorageConfigError
          ? err.message
          : "Failed to save recording file.";
      const detail =
        e instanceof StorageConfigError
          ? undefined
          : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
      return NextResponse.json(
        {
          error: detail ? `${base} Detail: ${detail}` : base,
          debug: {
            errorName: err?.name ?? null,
            errorMessage: err?.message ?? null,
            blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
            onVercel: !!process.env.VERCEL,
          },
        },
        { status: 500 },
      );
    }

    let meeting;
    try {
      meeting = await prisma.meeting.create({
        data: {
          dealId,
          recordingUrl,
          audioSizeBytes: file.size,
          durationSec,
          processingStatus: MEETING_PROCESSING_STATUS.UPLOADED,
          processingError: null,
        },
      });
    } catch (e) {
      const err = e as Error;
      console.error("[api/meetings] create failed:", {
        name: err?.name,
        message: err?.message,
        dealId,
        recordingUrl,
        fileSize: file.size,
      });
      return NextResponse.json(
        {
          error: `商談レコードの保存に失敗しました: ${err?.message ?? "unknown"}`,
        },
        { status: 500 },
      );
    }

    // T04: 受付だけを即時に返す。文字起こしは POST /api/meetings/[id]/transcription の
    // 継続処理が区間ごとに進め、完了後に議事録・BANTの分析へつなぐ。
    if (jobMode) return NextResponse.json({ meeting, transcriptionMode: "job" }, { status: 202 });

    await scheduleMeetingTranscription(meeting.id);

    const fresh = await prisma.meeting.findUnique({ where: { id: meeting.id } });
    return NextResponse.json({ meeting: fresh ?? meeting }, { status: 202 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {
      dealId: "商談を選び直してください。",
      title: "商談のラベルは200文字以内で入力してください。",
      minutes: "議事録を文字列で入力してください。",
      transcript: "文字起こし本文を文字列で入力してください。",
      meetingDate: "商談日時を確認してください。",
      createDraft: "記録の作成方法を確認して再試行してください。",
    };
    const issue = parsed.error.issues[0];
    const error = issue.code === "custom"
      ? "本文を入力してください。"
      : fieldErrors[String(issue.path[0])] ?? "入力内容を確認して再試行してください。";
    return NextResponse.json({ error }, { status: 400 });
  }
  if (!await validDeal(parsed.data.dealId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const meeting = await prisma.meeting.create({
    data: {
      dealId: parsed.data.dealId,
      title: parsed.data.title || null,
      minutes: parsed.data.minutes ?? null,
      transcript: parsed.data.transcript ?? null,
      meetingDate: parsed.data.meetingDate ? new Date(parsed.data.meetingDate) : undefined,
      processingStatus: MEETING_PROCESSING_STATUS.COMPLETED,
      processingError: null,
      sourceType: "manual_text",
    },
  });
  return NextResponse.json({ meeting });
}
