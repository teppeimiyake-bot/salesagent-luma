import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prismaUnscoped: prisma } = require("../src/lib/db.ts") as typeof import("../src/lib/db");
const { buildEvidenceSafeFallback, hasBusinessEvidence } = require("../src/lib/ai/pipeline.ts") as typeof import("../src/lib/ai/pipeline");

const dealIds = [
  "16d00000-0000-4000-8000-000000000001",
  "06146d16-0fea-43df-be6d-36f3775b7002",
  "21d00000-0000-4000-8000-000000000003",
];
const legacyIntent = "表向きは情報収集だが、本音は『社内で稟議を通せる材料』を探している。";
const legacyActionPrefix = "決裁者向けROI 1枚";

const meetings = await prisma.meeting.findMany({
  where: {
    dealId: { in: dealIds },
    processingStatus: "completed",
    transcript: { not: null },
  },
  select: {
    id: true,
    dealId: true,
    transcript: true,
    topSales: true,
    meta: true,
  },
});

let repaired = 0;
for (const meeting of meetings) {
  const topSales =
    meeting.topSales && typeof meeting.topSales === "object" && !Array.isArray(meeting.topSales)
      ? (meeting.topSales as Record<string, unknown>)
      : {};
  if (!meeting.transcript) continue;
  const hasLegacyFallback = topSales.real_intent === legacyIntent;
  const lacksBusinessEvidence = !hasBusinessEvidence(meeting.transcript);
  const existingMeta =
    meeting.meta && typeof meeting.meta === "object" && !Array.isArray(meeting.meta)
      ? (meeting.meta as Record<string, unknown>)
      : {};
  const hasOutdatedGuard = existingMeta.qualityGuard === "t18_evidence_safe_fallback_v1";
  if (!hasLegacyFallback && !lacksBusinessEvidence && !hasOutdatedGuard) continue;
  if (!hasLegacyFallback && existingMeta.qualityGuard === "t18_evidence_safe_fallback_v2") continue;

  const safe = buildEvidenceSafeFallback(meeting.transcript);
  await prisma.meeting.update({
    where: { id: meeting.id },
    data: {
      summary: `${safe.topSales.real_intent}\n\n勝ち筋: ${safe.topSales.winning_scenario}`,
      issues: safe.analysis.issues,
      bantBudget: safe.analysis.bant.budget,
      bantAuthority: safe.analysis.bant.authority,
      bantNeed: safe.analysis.bant.need,
      bantTimeline: safe.analysis.bant.timeline,
      analysis: safe.analysis as object,
      topSales: safe.topSales as object,
      strategy: safe.strategy as object,
      nextActions: safe.nextActions as object,
      meta: { ...existingMeta, fallback: true, qualityGuard: "t18_evidence_safe_fallback_v2" },
    },
  });

  const deal = await prisma.deal.findUnique({
    where: { id: meeting.dealId },
    select: { nextAction: true },
  });
  if (deal?.nextAction?.startsWith(legacyActionPrefix)) {
    await prisma.deal.update({
      where: { id: meeting.dealId },
      data: { nextAction: safe.nextActions.next_actions[0]?.action ?? null },
    });
  }
  repaired += 1;
}

let dealNextActionRepaired = 0;
for (const dealId of dealIds) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      nextAction: true,
      meetings: {
        where: { processingStatus: "completed", transcript: { not: null } },
        orderBy: { meetingDate: "desc" },
        take: 1,
        select: { transcript: true },
      },
    },
  });
  const latestTranscript = deal?.meetings[0]?.transcript;
  if (!deal?.nextAction || !latestTranscript || hasBusinessEvidence(latestTranscript)) continue;
  if (!/24時間以内|48時間以内|3日以内|1週間以内|決裁者向けROI/u.test(deal.nextAction)) continue;
  const safe = buildEvidenceSafeFallback(latestTranscript);
  await prisma.deal.update({
    where: { id: dealId },
    data: { nextAction: safe.nextActions.next_actions[0]?.action ?? null },
  });
  dealNextActionRepaired += 1;
}

console.log(`T18 legacy fallback repair: ${repaired} meeting(s), ${dealNextActionRepaired} deal next action(s)`);
await prisma.$disconnect();
