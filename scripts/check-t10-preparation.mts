import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

process.env.DATABASE_URL ??= "postgresql://t10_check:t10_check@localhost:5432/t10_check";

const require = createRequire(import.meta.url);
const {
  PROPOSAL_STORY_HEADINGS,
  PREPARATION_WEB_SEARCH_MAX_USES,
  buildPreparationResearchPrompt,
  buildPreparationWebSearchRequest,
  canCreatePreparationBrief,
  extractLumaProductNamesFromContext,
  normalizePreparationOutput,
  normalizeProposalStory,
} = require("../src/lib/ai/preparation.ts") as typeof import("../src/lib/ai/preparation");
const { formatLumaContextText } = require("../src/lib/ai/luma-context.ts") as typeof import("../src/lib/ai/luma-context");
const { selectDealsForPreparationCron } = require("../src/lib/preparation-cron.ts") as typeof import("../src/lib/preparation-cron");

const fixtureProducts = [
  {
    name: "SNS運用",
    description: "採用広報のSNS運用支援",
    plans: [{ name: "6ヶ月運用", basePrice: 1200000, description: "投稿設計からレポートまで" }],
  },
  {
    name: "映像制作",
    description: "採用動画と会社紹介動画",
    plans: [{ name: "採用ドラマ風動画", basePrice: 900000, description: "企画、撮影、編集" }],
  },
];
const fixtureProposals = [{ name: "ドラマ風動画", displayOrder: 10 }];
const contextText = formatLumaContextText({
  products: fixtureProducts,
  proposals: fixtureProposals,
  dealProducts: [],
});
const catalogNames = extractLumaProductNamesFromContext(contextText);
const realProductPattern = /映像制作|採用ドラマ風動画|SNS運用|ドラマ風動画/;

const story = normalizeProposalStory({
  story: "# つかみ\n採用環境を確認します。\n\n# 商材提案\n新商品Xだけで進めます。",
  companyName: "T10検証会社",
  industrySummary: "採用広報の強化が必要という公開情報を確認済み https://example.com/recruit",
  hiringInsights: {
    media: "採用媒体は確認できず",
    roles: "営業職",
    scale: "確認できず",
    sources: [{ title: "fixture", url: "https://example.com/recruit" }],
  },
  painHypotheses: [
    {
      hypothesis: "応募前理解が不足している可能性",
      confidence: "medium",
      evidence: "出典なしの仮説: 公開情報では根拠を確認できず。",
      source_url: "",
    },
  ],
  catalogProductNames: catalogNames,
});
for (const heading of PROPOSAL_STORY_HEADINGS) {
  assert.match(story, new RegExp(`# ${heading}`), "A: proposal story should contain all headings");
}
assert.match(story, realProductPattern, "B: proposal story should include a real fixture product name");
assert.notEqual(story.trim(), "新商品X", "B: invented product name alone must not pass");

const normalized = normalizePreparationOutput(
  {
    industry_summary: "出典なしの業界断定",
    hiring_insights: {
      media: "媒体掲載あり",
      roles: "営業職",
      scale: "10名",
      sources: [],
    },
    pain_hypotheses: [],
    sources: [],
    proposal_story: story,
  },
  { companyName: "T10検証会社", catalogProductNames: catalogNames },
);
assert.equal(normalized.industry_summary, "確認できず", "C: unsourced facts should remain unconfirmed");
assert.equal(normalized.hiring_insights.media, "確認できず", "C: hiring media without source should be unconfirmed");

const prompt = buildPreparationResearchPrompt(
  {
    id: "deal-t10",
    title: "T10検証商談",
    status: "PROPOSAL",
    bant: null,
    company: {
      name: "T10検証会社",
      industry: "採用支援",
      employeeCount: 120,
      websiteSummary: "公式サイト要約",
    },
    products: [],
    meetings: [],
  },
  contextText,
);
const request = buildPreparationWebSearchRequest(prompt);
assert.equal(request.tools.length, 1, "D: only one tool should be declared");
assert.equal(request.tools[0].name, "web_search", "D: the tool should be web_search");
assert.equal(request.tools[0].max_uses, PREPARATION_WEB_SEARCH_MAX_USES, "D: max_uses constant should be used");
assert.equal(request.tools[0].max_uses, 10, "D: max_uses must stay 10");
assert.ok(
  prompt.system?.includes(`Registered names for this request are ${JSON.stringify(catalogNames)}`),
  "D: the prompt should name the actual fixture catalog products, not fixed example offerings",
);
assert.equal(
  extractLumaProductNamesFromContext(formatLumaContextText({ products: [], proposals: [] })).length,
  0,
  "D: shared instructions must not turn an empty catalog into registered products",
);
assert.match(
  prompt.system,
  /採用サイトリニューアルの同期設計・スケジュール管理 and 役員会向けROI資料の共同作成 are not catalog capabilities/,
  "D: the prompt should reject unregistered delivery capabilities",
);
assert.match(
  contextText,
  /効果イメージは仮説として書く/,
  "D: shared context should keep effect claims hypothetical",
);

const now = new Date("2026-08-14T03:00:00.000Z"); // JST 2026-08-14 12:00
const old = new Date("2026-08-06T02:59:00.000Z");
const recent = new Date("2026-08-12T03:00:00.000Z");
const candidates = selectDealsForPreparationCron(
  [
    { id: "tomorrow-no-brief", meetingStartAt: "2026-08-14T15:00:00.000Z" },
    { id: "tomorrow-old", meetingStartAt: "2026-08-15T10:00:00.000Z", latestBriefCreatedAt: old },
    { id: "today", meetingStartAt: "2026-08-14T10:00:00.000Z" },
    { id: "recent", meetingStartAt: "2026-08-15T01:00:00.000Z", latestBriefCreatedAt: recent },
    { id: "in-progress", meetingStartAt: "2026-08-15T02:00:00.000Z", hasInProgressBrief: true },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `limit-${index}`,
      meetingStartAt: "2026-08-15T03:00:00.000Z",
      latestBriefCreatedAt: old,
    })),
  ],
  now,
  { staleDays: 7 },
);
assert.ok(candidates.some((deal) => deal.id === "tomorrow-no-brief"), "E: tomorrow deal without brief should be selected");
assert.ok(candidates.some((deal) => deal.id === "tomorrow-old"), "E: tomorrow stale deal should be selected");
assert.ok(!candidates.some((deal) => deal.id === "today"), "E: today's deal should not be selected");
assert.ok(!candidates.some((deal) => deal.id === "recent"), "E: recent brief should not be selected");
assert.ok(!candidates.some((deal) => deal.id === "in-progress"), "E: in-progress brief should not be selected");
assert.equal(candidates.length, 10, "E: cron selection should cap at 10");

assert.equal(canCreatePreparationBrief({ createdToday: 3, isAdmin: false, limit: 3 }), false);
assert.equal(canCreatePreparationBrief({ createdToday: 3, isAdmin: true, limit: 3 }), true);
assert.equal(
  canCreatePreparationBrief({ createdToday: 2, isAdmin: false, limit: 3 }),
  true,
  "F: failed rows are excluded before this count is passed",
);

console.log("check:t10-preparation OK");
