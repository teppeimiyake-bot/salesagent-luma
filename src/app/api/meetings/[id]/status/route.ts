import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  MEETING_PROCESSING_STATUS,
  scheduleMeetingTranscription,
} from "@/lib/meetings/processing";
import { INLINE_TRANSCRIPTION_STALE_MS, MEETING_STATUS_SELECT, meetingStatusPayload, olderThan } from "@/lib/meetings/status-payload";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

const actionSchema = z.object({
  action: z.literal("retry-transcription"),
});

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: MEETING_STATUS_SELECT,
  });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ meeting: meetingStatusPayload(meeting) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { id: true, recordingUrl: true, transcript: true, processingStatus: true, processingStartedAt: true },
  });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (meeting.transcript?.trim()) return NextResponse.json({ error: "文字起こし済みです。AI再分析を実行してください。" }, { status: 409 });
  // 処理中の再実行は拒否する。ただし、処理が中断して長く止まっている記録は再実行で復旧できる。
  const inFlight = ["uploaded", "transcribing", "analyzing"].includes(meeting.processingStatus);
  const stalled = inFlight && meeting.processingStatus !== "analyzing"
    && olderThan(meeting.processingStartedAt, INLINE_TRANSCRIPTION_STALE_MS);
  if (inFlight && !stalled) {
    return NextResponse.json({ error: "処理中です。完了をお待ちください。" }, { status: 409 });
  }
  if (!meeting.recordingUrl) {
    return NextResponse.json({ error: "Recording file is missing." }, { status: 400 });
  }

  const claimed = await prisma.meeting.updateMany({
    where: {
      id,
      processingStatus: meeting.processingStatus,
      transcript: meeting.transcript,
      ...(stalled ? { processingStartedAt: meeting.processingStartedAt } : {}),
    },
    data: {
      processingStatus: MEETING_PROCESSING_STATUS.UPLOADED,
      processingError: null,
      processingStartedAt: null,
      processingCompletedAt: null,
    },
  });
  if (claimed.count !== 1) return NextResponse.json({ error: "処理状態が更新されました。再読み込みしてください。" }, { status: 409 });
  // 継続処理の環境では何もしない。完了済みの区間を残したまま、画面の継続リクエストが再開する。
  await scheduleMeetingTranscription(id);

  const fresh = await prisma.meeting.findUnique({
    where: { id },
    select: MEETING_STATUS_SELECT,
  });

  return NextResponse.json(
    {
      ok: true,
      meeting: fresh
        ? meetingStatusPayload(fresh)
        : {
            id,
            processingStatus: MEETING_PROCESSING_STATUS.UPLOADED,
            processingError: null,
          },
    },
    { status: 202 },
  );
}
