import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runPipeline } from "@/lib/ai/pipeline";

export const maxDuration = 120;

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: { deal: { include: { company: true } } },
  });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const sourceText = meeting.transcript || meeting.minutes;
  if (!sourceText) {
    return NextResponse.json({ error: "Transcript and minutes are both empty" }, { status: 400 });
  }

  // 過去のユーザー編集を学習機構へ供給
  const recentEdits = await prisma.aiLog.findMany({
    where: { dealId: meeting.dealId, step: { in: ["task_user_edit", "bant_user_edit"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const pastEdits = recentEdits.map((e) => ({
    aiOutput: JSON.stringify(e.input),
    userEdit: JSON.stringify(e.userEdit ?? e.output),
  }));

  const ctx = {
    companyName: meeting.deal.company.name,
    dealTitle: meeting.deal.title,
    industry: meeting.deal.company.industry,
    pastEdits,
  };

  const result = await runPipeline(sourceText, ctx);

  // 議事録（要約）に分析結果を反映
  const summary = `${result.topSales.real_intent}\n\n勝ち筋: ${result.topSales.winning_scenario}`;
  // minutes が空なら、AI がドラフトとして埋める
  const minutesDraft = meeting.minutes
    ? meeting.minutes
    : [
        "■ 商談要約（AI生成ドラフト）",
        "",
        "◆ サマリ",
        summary,
        "",
        "◆ 課題",
        ...result.analysis.issues.map((i) => `・${i}`),
        "",
        "◆ BANT",
        `・予算（B）：${result.analysis.bant.budget}`,
        `・決裁（A）：${result.analysis.bant.authority}`,
        `・課題（N）：${result.analysis.bant.need}`,
        `・時期（T）：${result.analysis.bant.timeline}`,
      ].join("\n");
  await prisma.meeting.update({
    where: { id },
    data: {
      minutes: minutesDraft,
      summary,
      issues: result.analysis.issues,
      bantBudget: result.analysis.bant.budget,
      bantAuthority: result.analysis.bant.authority,
      bantNeed: result.analysis.bant.need,
      bantTimeline: result.analysis.bant.timeline,
      structured: result.structured as object,
      analysis: result.analysis as object,
      topSales: result.topSales as object,
      strategy: result.strategy as object,
      nextActions: result.nextActions as object,
      scores: result.scores as object,
      meta: { improved: result.improved, fallback: result.fallback },
    },
  });

  // 各ステップを ai_logs に保存
  for (const t of result.trace) {
    await prisma.aiLog.create({
      data: {
        dealId: meeting.dealId,
        step: t.step,
        input: t.input as object,
        output: t.output as object,
      },
    });
  }

  // dealのnext_actionを最高優先度のものに更新
  const top = result.nextActions.next_actions[0];
  if (top) {
    await prisma.deal.update({
      where: { id: meeting.dealId },
      data: { nextAction: top.action },
    });
  }

  return NextResponse.json({ ok: true, result, meetingId: id });
}
