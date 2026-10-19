import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

process.env.DATABASE_URL ??= "postgresql://t08_check:t08_check@localhost:5432/t08_check";

const require = createRequire(import.meta.url);
const {
  formatLumaContextForPrompt,
  formatLumaContextText,
  lumaContextMeetsCacheMinimum,
} = require("../src/lib/ai/luma-context.ts") as typeof import("../src/lib/ai/luma-context");
const {
  buildAnthropicSystemParam,
} = require("../src/lib/ai/anthropic.ts") as typeof import("../src/lib/ai/anthropic");
const {
  buildBantAggregationPrompt,
} = require("../src/lib/ai/summarize-bant.ts") as typeof import("../src/lib/ai/summarize-bant");

const fixtureProducts = [
  {
    name: "SNS運用",
    description: "採用広報のSNS運用支援",
    plans: [
      {
        name: "6ヶ月運用",
        basePrice: 1200000,
        description: "投稿設計からレポートまで",
        sortOrder: 20,
      },
    ],
  },
  {
    name: "映像制作",
    description: "採用動画と会社紹介動画",
    plans: [
      {
        name: "採用ドラマ風動画",
        basePrice: 900000,
        description: "企画、撮影、編集",
        sortOrder: 20,
      },
      {
        name: "採用サイト映像",
        basePrice: 650000,
        description: "採用サイト掲載向け",
        sortOrder: 10,
      },
    ],
  },
];

const fixtureProposals = [
  { name: "社員インタビュー", displayOrder: 20 },
  { name: "ドラマ風動画", displayOrder: 10 },
];

const contextText = formatLumaContextText({
  products: fixtureProducts,
  proposals: fixtureProposals,
  dealProducts: [
    {
      productName: "映像制作",
      planName: "採用ドラマ風動画",
      planProposals: ["ドラマ風動画"],
      yomiStatus: "A",
      amount: 900000,
    },
  ],
});

assert.match(contextText, /Lumaは採用向けの映像制作SNSコンテンツ制作会社である/);
assert.match(contextText, /採用ドラマ風動画/);
assert.match(contextText, /SNS運用/);
assert.match(contextText, /統計は出典ページに書かれた母集団・対象業種・企業規模のまま使う/);
assert.match(contextText, /議事録に無い精度の日付・期間を引用扱いしない/);
assert.match(contextText, /マスタにも議事録にも無い制作期間（例: 目安8週間）を作らない/);
assert.match(contextText, /採用サイトリニューアルの同期設計・スケジュール管理/);
assert.match(contextText, /役員会向けROI資料の共同作成/);
assert.match(contextText, /# Luma提供価値[\s\S]*# 商材カタログ[\s\S]*# 企画型一覧[\s\S]*# この案件の提案中商材/);

const contextTextAgain = formatLumaContextText({
  products: [...fixtureProducts].reverse(),
  proposals: [...fixtureProposals].reverse(),
  dealProducts: [
    {
      productName: "映像制作",
      planName: "採用ドラマ風動画",
      planProposals: ["ドラマ風動画"],
      yomiStatus: "A",
      amount: 900000,
    },
  ],
});
assert.equal(contextTextAgain, contextText);

const prompt = buildBantAggregationPrompt(
  {
    id: "deal-t08",
    title: "T08検証商談",
    status: "active",
    bant: null,
    bantUpdatedAt: null,
    company: { name: "T08検証会社", industry: null },
    products: [],
    meetings: [],
  },
  contextText,
);
assert.match(prompt.cacheableSystem ?? "", /# Luma商材コンテキスト/);
assert.match(prompt.cacheableSystem ?? "", /採用ドラマ風動画/);

const systemParam = buildAnthropicSystemParam({
  system: "通常system",
  cacheableSystem: formatLumaContextForPrompt(contextText),
});
assert.ok(Array.isArray(systemParam));
assert.deepEqual(systemParam[0].cache_control, { type: "ephemeral" });
assert.match(systemParam[0].text, /# Luma商材コンテキスト/);
assert.equal(systemParam[1].text, "通常system");
assert.ok(lumaContextMeetsCacheMinimum(contextText));
assert.ok(formatLumaContextForPrompt(contextText).length >= 1800);

console.log("check:t08-luma-context OK");
