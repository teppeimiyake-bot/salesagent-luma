import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import fs from "node:fs/promises";
import { fetchStored } from "@/lib/storage";
import { readTranscriptionJob } from "@/lib/meetings/transcription-job";
import { playbackAudioPath } from "@/lib/meetings/transcription-files";
import { isUploadManifestKey } from "@/lib/meetings/upload-sessions";

export const maxDuration = 60;

/**
 * GET /api/meetings/[id]/recording
 *
 * 商談録音の本体を「アプリの認証を通して」配信するプロキシ。
 * Vercel Blob はプライベートストアなので blob の生 URL は 401。
 * (1) ログイン認証 (2) blob/local から取得 (3) ストリーム返却（再生用に inline）。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { recordingUrl: true, meta: true },
  });
  if (!meeting || !meeting.recordingUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // T04/T22: 動画・分割アップロード・大容量の録音は、文字起こし用に正規化した音声で再生する。
  // 元の大きなファイルを毎回メモリへ全体読込しないため。
  const playbackPath = playbackAudioPath(id, readTranscriptionJob(meeting.meta));
  const playback = playbackPath ? await fs.readFile(playbackPath).catch(() => null) : null;
  if (!playback && isUploadManifestKey(meeting.recordingUrl)) {
    return NextResponse.json({ error: "再生用の音声を準備中です。文字起こしの開始後に再度お試しください。" }, { status: 404 });
  }
  const fetched = playback
    ? { buffer: playback, contentType: "audio/mpeg" }
    : await fetchStored(meeting.recordingUrl);
  if (!fetched) {
    return NextResponse.json({ error: "録音ファイルを取得できませんでした" }, { status: 404 });
  }

  const contentType = fetched.contentType || "audio/webm";
  const size = fetched.buffer.length;
  const range = req.headers.get("range");

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2])) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const safeEnd = Math.min(end, size - 1);
    const chunk = fetched.buffer.subarray(start, safeEnd + 1);
    return new NextResponse(chunk as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="recording_${id}.webm"`,
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${safeEnd}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      },
    });
  }

  return new NextResponse(fetched.buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="recording_${id}.webm"`,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    },
  });
}
