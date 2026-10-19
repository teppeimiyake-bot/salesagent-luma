import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { isMeetAutoRecordEnabled } from "@/lib/feature-flags";
import { configureDealMeetArtifacts } from "@/lib/meetings/meet-ingest";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 60;

/**
 * T16: Meetの自動録画・自動文字起こし設定の「手動再試行」。
 * 自動でやる処理には必ず手で叩ける口を用意する、という方針でこのルートを置いている。
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isMeetAutoRecordEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const me = { permission: await getCurrentPermission() };
  if (!hasPermission(me?.permission, "user")) {
    return await writeForbidden();
  }

  const deal = await prisma.deal.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, meetingOwnerType: true },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt) return NextResponse.json({ error: "Deleted" }, { status: 410 });
  if (deal.meetingOwnerType !== "own_meet") {
    return NextResponse.json(
      { error: "Own Meet required", message: "自社発行Meetの商談だけ設定できます。" },
      { status: 409 },
    );
  }

  const result = await configureDealMeetArtifacts(id);
  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    error: result.error ?? null,
    message: result.ok
      ? "Meetの自動録画・自動文字起こしを設定しました。"
      : (result.error ?? "設定に失敗しました。"),
  });
}
