import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { fileExtension, isMediaAttachmentExtension, unsupportedAttachmentMessage } from "@/lib/meetings/upload-formats";
import { isTranscriptionJobMode } from "@/lib/meetings/transcription-job";
import { mediaToolsAvailable } from "@/lib/meetings/audio-segments";
import { createUploadManifest, removeExpiredUploadSessions, UPLOAD_SESSION_MAX_BYTES, writeUploadManifest } from "@/lib/meetings/upload-sessions";
import { writeForbidden } from "@/lib/write-guard";

const createSchema = z.object({
  dealId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  durationSec: z.number().int().nonnegative().max(2147483647).optional(),
});

/**
 * POST /api/meetings/upload-sessions
 *
 * T22: Cloud Run の1リクエスト上限（32MiB）を超える録画を、8MiBずつ送るための受付。
 * 分割した録画を区間ごとに文字起こしできる継続処理の環境（ffmpeg あり）でだけ使える。
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();
  if (!isTranscriptionJobMode() || !await mediaToolsAvailable()) {
    return NextResponse.json({ error: "この環境では分割アップロードを利用できません。", code: "UPLOAD_SESSION_UNAVAILABLE" }, { status: 409 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "添付ファイルの情報を確認して再試行してください。" }, { status: 400 });
  const { dealId, filename, size, durationSec } = parsed.data;
  const extension = fileExtension(filename);
  if (!isMediaAttachmentExtension(extension)) {
    return NextResponse.json({ error: unsupportedAttachmentMessage(filename), code: "UNSUPPORTED_ATTACHMENT_TYPE" }, { status: 415 });
  }
  if (size > UPLOAD_SESSION_MAX_BYTES) {
    return NextResponse.json({ error: "録画ファイルが大きすぎます（2,000MBまで）。音声（mp3/m4a）に書き出して添付してください。", code: "UPLOAD_TOO_LARGE" }, { status: 413 });
  }
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { deletedAt: true, company: { select: { deletedAt: true } } } });
  if (!deal || deal.deletedAt || deal.company.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const manifest = createUploadManifest({
    uploadId: crypto.randomUUID(), dealId, userId: session.userId, filename, extension, size, durationSec: durationSec ?? null,
  }, new Date());
  await writeUploadManifest(manifest);
  // 放棄された分割アップロードの掃除は応答を待たせない（失敗しても受付には影響しない）。
  void removeExpiredUploadSessions().catch(() => 0);
  return NextResponse.json({ uploadId: manifest.uploadId, partBytes: manifest.partBytes, totalParts: manifest.totalParts }, { status: 201 });
}
