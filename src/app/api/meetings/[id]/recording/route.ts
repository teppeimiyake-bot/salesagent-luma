import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { fetchStored } from "@/lib/storage";

export const maxDuration = 60;

/**
 * GET /api/meetings/[id]/recording
 *
 * 商談録音の本体を「アプリの認証を通して」配信するプロキシ。
 * Vercel Blob はプライベートストアなので blob の生 URL は 401。
 * (1) ログイン認証 (2) blob/local から取得 (3) ストリーム返却（再生用に inline）。
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { recordingUrl: true },
  });
  if (!meeting || !meeting.recordingUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const fetched = await fetchStored(meeting.recordingUrl);
  if (!fetched) {
    return NextResponse.json({ error: "録音ファイルを取得できませんでした" }, { status: 404 });
  }

  const contentType = fetched.contentType || "audio/webm";
  return new NextResponse(fetched.buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="recording_${id}.webm"`,
      "Content-Length": String(fetched.buffer.length),
      "Cache-Control": "private, no-store",
    },
  });
}
