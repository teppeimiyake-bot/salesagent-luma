import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { NextResponse } from "next/server";
import { runMeetingAnalysis } from "@/lib/meetings/analysis";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 300;

// 分析本体は src/lib/meetings/analysis.ts に切り出し済み（T16でMeet自動取り込みからも呼ぶため）。
// このルートは戻り値をHTTPに写すだけで、ステータスコード・JSONの形は従来どおり。
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();
  const { id } = await params;
  const outcome = await runMeetingAnalysis(id);

  if (outcome.ok) {
    return NextResponse.json({ ok: true, result: outcome.result, meetingId: outcome.meetingId });
  }

  if (outcome.kind === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (outcome.kind === "in_flight") {
    return NextResponse.json(
      {
        error: "文字起こしまたはAI分析が処理中です。完了をお待ちください。",
        processingStatus: outcome.processingStatus,
      },
      { status: 409 },
    );
  }
  if (outcome.kind === "empty") {
    return NextResponse.json({ error: "Transcript and minutes are both empty" }, { status: 400 });
  }
  if (outcome.kind === "accepted") {
    // T04/T22: 長い記録は原文抜粋の抽出ジョブとして受け付ける。商談履歴の継続処理が区間ごとに進める。
    return NextResponse.json(
      { accepted: true, mode: "long_analysis", processingStatus: "analyzing", chunks: outcome.chunks },
      { status: 202 },
    );
  }
  return NextResponse.json({ error: outcome.message }, { status: 500 });
}
