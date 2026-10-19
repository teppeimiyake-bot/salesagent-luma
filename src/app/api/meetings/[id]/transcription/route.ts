import { NextResponse } from "next/server";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { continueMeetingProcessing } from "@/lib/meetings/transcription-continue";
import { isTranscriptionJobMode } from "@/lib/meetings/transcription-job";
import { MEETING_STATUS_SELECT, meetingStatusPayload } from "@/lib/meetings/status-payload";
import { getRequestTenant } from "@/lib/tenant-context";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

/**
 * POST /api/meetings/[id]/transcription
 *
 * T04: Cloud Run 向けの継続処理。1回あたり約230秒の範囲で文字起こしを区間ごとに進め、
 * 完了後の最初の呼び出しで議事録・BANT の分析へつなぐ。録音カード・添付・商談履歴が
 * 完了まで繰り返し呼ぶ。別の呼び出しが処理中なら leased を返すだけで、二重に処理しない。
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();
  if (!isTranscriptionJobMode()) {
    return NextResponse.json({ error: "この環境では文字起こしをアップロード時に処理します。", code: "TRANSCRIPTION_JOB_DISABLED" }, { status: 409 });
  }

  // 全社統合ビューは読み取り専用。処理を進める書込ができないため、画面の確認を止めてもらう。
  if ((await getRequestTenant())?.crossTenant) {
    return NextResponse.json({ error: "全社統合ビューでは処理を進められません。会社を切り替えてください。", code: "CROSS_TENANT_READ_ONLY" }, { status: 409 });
  }

  const { id } = await params;
  const target = await prisma.meeting.findUnique({
    where: { id },
    select: { id: true, deal: { select: { deletedAt: true, company: { select: { deletedAt: true } } } } },
  });
  if (!target || target.deal.deletedAt || target.deal.company.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await continueMeetingProcessing(id);
  const fresh = await prisma.meeting.findUnique({ where: { id }, select: MEETING_STATUS_SELECT });
  if (!fresh) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ outcome: result.outcome, meeting: meetingStatusPayload(fresh) });
}
