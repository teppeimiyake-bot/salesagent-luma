import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import {
  acquireUploadCompletion,
  missingUploadParts,
  readUploadManifest,
  releaseUploadCompletion,
  uploadManifestKey,
  uploadSessionExpired,
  writeUploadManifest,
} from "@/lib/meetings/upload-sessions";
import { writeForbidden } from "@/lib/write-guard";

/**
 * POST /api/meetings/upload-sessions/[uploadId]/complete
 *
 * 全パートがそろったら商談記録を作成し、通常の録音アップロードと同じく202で受付だけ返す。
 * 文字起こしは継続処理（POST /api/meetings/[id]/transcription）がパートを順に読んで行う。
 */
export async function POST(_: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();

  const { uploadId } = await params;
  const manifest = await readUploadManifest(uploadId);
  if (!manifest || manifest.userId !== session.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // 完了応答が届かず再送された場合は、同じ記録を返して二重に作らない。
  if (manifest.completedMeetingId) {
    const existing = await prisma.meeting.findUnique({ where: { id: manifest.completedMeetingId } });
    if (existing) return NextResponse.json({ meeting: existing, transcriptionMode: "job" }, { status: 202 });
    // 作成済みの記録が削除された後は、同じパートから作り直さない。
    return NextResponse.json({ error: "このアップロードから作成した記録は削除されています。必要なら最初から添付し直してください。" }, { status: 410 });
  }
  if (uploadSessionExpired(manifest)) return NextResponse.json({ error: "アップロードの有効期限が切れました。最初から添付し直してください。" }, { status: 410 });
  const missing = await missingUploadParts(manifest);
  if (missing.length) {
    return NextResponse.json({ error: `未送信のパートがあります（${missing.length}件）。再試行してください。`, missingParts: missing.slice(0, 20) }, { status: 409 });
  }
  const deal = await prisma.deal.findUnique({ where: { id: manifest.dealId }, select: { deletedAt: true, company: { select: { deletedAt: true } } } });
  if (!deal || deal.deletedAt || deal.company.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // マニフェストの書込が失敗していても、記録が作成済みならそれを返す（録音キーで一意に分かる）。
  const created = () => prisma.meeting.findFirst({ where: { recordingUrl: uploadManifestKey(uploadId) } });
  // 同時に届いた完了は1つだけが記録を作る。他方は少し待って再送すれば作成済みの記録を受け取れる。
  if (!await acquireUploadCompletion(uploadId)) {
    const existing = await created();
    if (existing) return NextResponse.json({ meeting: existing, transcriptionMode: "job" }, { status: 202 });
    return NextResponse.json({ error: "完了処理中です。少し待ってから再試行してください。", code: "UPLOAD_COMPLETING" }, { status: 409 });
  }
  const existingInLock = await created();
  if (existingInLock) return NextResponse.json({ meeting: existingInLock, transcriptionMode: "job" }, { status: 202 });
  // ロックを取った後にも、パートがそろっていることを確かめ直す。
  if ((await missingUploadParts(manifest)).length) {
    await releaseUploadCompletion(uploadId);
    return NextResponse.json({ error: "未送信のパートがあります。再試行してください。" }, { status: 409 });
  }

  let meeting;
  try {
    meeting = await prisma.meeting.create({
      data: {
        dealId: manifest.dealId,
        recordingUrl: uploadManifestKey(uploadId),
        audioSizeBytes: manifest.size,
        durationSec: manifest.durationSec,
        processingStatus: MEETING_PROCESSING_STATUS.UPLOADED,
        processingError: null,
        meta: { attachment: { filename: manifest.filename, extension: manifest.extension, uploadParts: manifest.totalParts } },
      },
    });
    await writeUploadManifest({ ...manifest, completedMeetingId: meeting.id });
  } catch (error) {
    // 作成に失敗した場合だけロックを外し、再試行できるようにする（作成後はロックを残して二重作成を防ぐ）。
    if (!meeting) await releaseUploadCompletion(uploadId);
    throw error;
  }
  return NextResponse.json({ meeting, transcriptionMode: "job" }, { status: 202 });
}
