import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { isMeetAutoRecordEnabled } from "@/lib/feature-flags";
import { ingestDealMeetArtifacts } from "@/lib/meetings/meet-ingest";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

/**
 * T16: Meet成果物（会議記録・文字起こし）の「手動取得」。
 * cronを待たずに担当者がその場で取り込めるようにするための口。
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
      { error: "Own Meet required", message: "自社発行Meetの商談だけ成果物を取得できます。" },
      { status: 409 },
    );
  }

  const result = await ingestDealMeetArtifacts(id, { trigger: "manual" });
  return NextResponse.json(result);
}
