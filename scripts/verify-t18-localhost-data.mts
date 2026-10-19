import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prismaUnscoped: prisma } = require("../src/lib/db.ts") as typeof import("../src/lib/db");
const { hasBusinessEvidence } = require("../src/lib/ai/pipeline.ts") as typeof import("../src/lib/ai/pipeline");

const ids = {
  ownMeet: "16d00000-0000-4000-8000-000000000001",
  realMeet: "06146d16-0fea-43df-be6d-36f3775b7002",
  zoom: "21d00000-0000-4000-8000-000000000003",
};

const deals = await prisma.deal.findMany({
  where: { id: { in: Object.values(ids) } },
  select: {
    id: true,
    nextAction: true,
    bant: true,
    preparationBriefs: {
      where: { status: "done" },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: {
        model: true,
        hiringInsights: true,
        painHypotheses: true,
        proposalStory: true,
        sources: true,
      },
    },
    meetings: {
      where: { processingStatus: "completed", transcript: { not: null } },
      orderBy: { meetingDate: "desc" },
      select: {
        transcript: true,
        minutes: true,
        bantBudget: true,
        bantAuthority: true,
        bantNeed: true,
        bantTimeline: true,
        topSales: true,
        strategy: true,
        nextActions: true,
        meta: true,
      },
    },
  },
});

assert.equal(deals.length, 3);
const byId = new Map(deals.map((deal) => [deal.id, deal]));

const own = byId.get(ids.ownMeet);
assert.ok(own);
const ownMeeting = own.meetings[0];
assert.ok(ownMeeting?.transcript?.includes("300万円を確保"));
assert.match(ownMeeting.bantBudget ?? "", /300万円/u);
assert.match(ownMeeting.bantAuthority ?? "", /代表取締役/u);
assert.match(ownMeeting.bantTimeline ?? "", /9月15日/u);
assert.match(ownMeeting.minutes ?? "", /11月10日公開目標/u);

const zoom = byId.get(ids.zoom);
assert.ok(zoom);
const zoomMeeting = zoom.meetings.find((meeting) => meeting.transcript?.includes("DX枠450万円"));
assert.ok(zoomMeeting);
assert.match(zoomMeeting.bantBudget ?? "", /450万円/u);
assert.match(zoomMeeting.bantAuthority ?? "", /代表取締役/u);
assert.match(zoomMeeting.bantTimeline ?? "", /10月15日/u);
assert.match(zoomMeeting.minutes ?? "", /9月10日/u);

const real = byId.get(ids.realMeet);
assert.ok(real);
const forbiddenSparseClaims = ["24時間以内", "48時間以内", "3日以内", "1週間以内", "第1週", "第2-3週", "第4週"];
for (const meeting of real.meetings) {
  if (!meeting.transcript || hasBusinessEvidence(meeting.transcript)) continue;
  const output = JSON.stringify({
    topSales: meeting.topSales,
    strategy: meeting.strategy,
    nextActions: meeting.nextActions,
  });
  for (const forbidden of forbiddenSparseClaims) {
    assert.equal(output.includes(forbidden), false, `sparse transcript must not invent ${forbidden}`);
  }
  assert.match(output, /未確認/u);
  const meta = meeting.meta as Record<string, unknown> | null;
  assert.equal(meta?.qualityGuard, "t18_evidence_safe_fallback_v2");
}
assert.match(JSON.stringify(real.bant), /未確定/u);
assert.doesNotMatch(real.nextAction ?? "", /24時間以内|48時間以内|第1週/u);

const brief = own.preparationBriefs[0];
assert.ok(brief);
assert.match(brief.model ?? "", /^claude-/u);
const briefJson = JSON.stringify(brief);
assert.doesNotMatch(briefJson, /明確な回答.*(?:記載|確認)(?:なし|できず)/u);
assert.doesNotMatch(briefJson, /商談内で合意|InstagramおよびYouTubeへの展開は合意済み/u);
assert.match(briefJson, /面接前辞退が約35パーセント/u);
const sources = Array.isArray(brief.sources) ? (brief.sources as Array<Record<string, unknown>>) : [];
assert.ok(sources.length > 0);
for (const source of sources) assert.match(String(source.url ?? ""), /^https:\/\//u);

console.log("T18 localhost data verification passed: 3 deals / brief / minutes / BANT / right context");
await prisma.$disconnect();
