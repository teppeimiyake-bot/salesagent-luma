import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { summarizeDealBant } from "@/lib/ai/summarize-bant";
import { acquireBantSummaryLock, releaseBantSummaryLock } from "@/lib/ai/bant-summary-lock";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 30;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const me = { permission: await getCurrentPermission() };
    if (!hasPermission(me?.permission, "user")) {
      return await writeForbidden();
    }

    const deal = await prisma.deal.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, company: { select: { deletedAt: true } } },
    });
    if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (deal.deletedAt || deal.company.deletedAt) {
      return NextResponse.json({ error: "Deleted" }, { status: 410 });
    }

    // QG26-03: 同じ商談の集約が実行中なら、AI を呼ばずに 409（AI再分析の処理中チェックと同じ扱い）。
    const lease = await acquireBantSummaryLock(id, "manual_button");
    if (!lease) {
      return NextResponse.json(
        { error: "AI再集約が処理中です。完了をお待ちください。", inFlight: true },
        { status: 409 },
      );
    }
    try {
      const result = await summarizeDealBant(id, { trigger: "manual_button" });
      return NextResponse.json({ bant: result.bant, fallback: result.fallback });
    } finally {
      await releaseBantSummaryLock(lease).catch((e) => {
        // 消せなくても印は期限（BANT_SUMMARY_LOCK_TTL_MS）で無効になる。
        console.error("[summarize-bant] in-flight marker not released", e instanceof Error ? e.message : e);
      });
    }
  } catch (e) {
    console.error("[summarize-bant] error", e);
    return NextResponse.json(
      {
        error: "internal",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
