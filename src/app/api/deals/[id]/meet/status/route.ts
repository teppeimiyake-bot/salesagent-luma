import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { isMeetAutoRecordEnabled } from "@/lib/feature-flags";
import { dealMeetStatus } from "@/lib/meetings/meet-ingest";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 30;

/** T16: MeetSessionPanel のポーリング先。進行状態だけを返す。 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
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
    select: { meetingOwnerType: true, deletedAt: true },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt) return NextResponse.json({ error: "Deleted" }, { status: 410 });
  if (deal.meetingOwnerType !== "own_meet") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const status = await dealMeetStatus(id);
  if (!status) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ status });
}
