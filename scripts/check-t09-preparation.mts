import { strict as assert } from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildPreparationResearchPrompt,
  buildPreparationWebSearchRequest,
  fallbackPreparationBrief,
  normalizePreparationOutput,
  PREPARATION_WEB_SEARCH_MAX_USES,
} = require("../src/lib/ai/preparation.ts") as typeof import("../src/lib/ai/preparation");
const {
  cloneAnthropicContent,
  contentBlockTypes,
  extractAnthropicText,
  formatAnthropicDebug,
  shouldContinueAnthropicTurn,
} = require("../src/lib/ai/anthropic.ts") as typeof import("../src/lib/ai/anthropic");

const normalized = normalizePreparationOutput({
  industry_summary: "採用活動を強化している",
  hiring_insights: {
    media: "マイナビ掲載あり",
    roles: "営業職を募集",
    scale: "10名規模",
    sources: [],
  },
  pain_hypotheses: [
    {
      hypothesis: "応募母集団が不足している可能性",
      confidence: "HIGH",
      evidence: "採用媒体の掲載があるため",
    },
  ],
  sources: [],
});

assert.equal(normalized.industry_summary, "確認できず");
assert.equal(normalized.hiring_insights.media, "確認できず");
assert.equal(normalized.hiring_insights.roles, "確認できず");
assert.equal(normalized.hiring_insights.scale, "確認できず");
assert.equal(normalized.pain_hypotheses[0].confidence, "high");
assert.equal(normalized.pain_hypotheses[0].source_url, "");
assert.match(normalized.pain_hypotheses[0].evidence, /出典なしの仮説/);

const prompt = buildPreparationResearchPrompt(
  {
    id: "deal-t09",
    title: "T09検証商談",
    status: "LEAD",
    bant: {
      budget: "未確定",
      meetingNotes: "SHOULD_NOT_APPEAR",
      isNG: true,
    },
    company: {
      name: "T09検証会社",
      industry: "採用支援",
      employeeCount: 120,
      websiteSummary: "公式サイト要約",
    },
    products: [
      {
        productName: "採用動画",
        planName: "ドラマ風動画",
        planProposals: ["社員インタビュー"],
        yomiStatus: "A",
        amount: 900000,
      },
    ],
    meetings: [
      {
        title: "初回商談",
        meetingDate: new Date("2026-08-14T00:00:00.000Z"),
        minutes: "採用広報を強化したい",
        bantBudget: "100万円前後",
        bantAuthority: "人事部長",
        bantNeed: "応募前理解",
        bantTimeline: "今期中",
      },
    ],
  },
  "# Luma商材コンテキスト\n- 採用動画",
);
const request = buildPreparationWebSearchRequest(prompt);
assert.equal(request.tools[0].name, "web_search");
assert.equal(request.tools[0].max_uses, PREPARATION_WEB_SEARCH_MAX_USES);
assert.equal(request.tools[0].max_uses, 10);
assert.doesNotMatch(request.user, /SHOULD_NOT_APPEAR/);
assert.match(prompt.system, /Preserve the population and scope stated by each source/);
assert.match(prompt.system, /that exact value is verifiable at its cited URL/);
assert.match(prompt.system, /the exact value appears in the meeting record/);
assert.match(prompt.system, /Do not infer causation or a person's inner thoughts from meeting facts/);
assert.match(prompt.system, /Do not state unsourced claims such as "エントリーが増える傾向" or "離職が下がる" as facts/);
assert.match(prompt.system, /Never attribute "約4ヶ月後" to meeting notes unless that exact duration was recorded/);
assert.match(prompt.system, /Never invent a production lead time such as "制作期間（目安8週間）"/);

const fallback = fallbackPreparationBrief("T09検証会社");
assert.equal(fallback.industry_summary, "確認できず");
assert.equal(fallback.hiring_insights.media, "確認できず");
assert.match(fallback.proposal_story ?? "", /# つかみ/);
assert.ok(Array.isArray(fallback.pain_hypotheses));

const searchBlocks = [
  {
    type: "server_tool_use",
    id: "srvtoolu_test",
    name: "web_search",
    input: { query: "サンプル製菓" },
  },
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_test",
    content: [{ type: "web_search_result", url: "https://example.com", title: "example" }],
  },
];
assert.equal(extractAnthropicText(searchBlocks), "");
assert.equal(contentBlockTypes(searchBlocks), "server_tool_use,web_search_tool_result");
assert.equal(
  extractAnthropicText([...searchBlocks, { type: "text", text: '{"industry_summary":"ok"}' }]),
  '{"industry_summary":"ok"}',
);

const cloned = cloneAnthropicContent(searchBlocks);
assert.equal(cloned[0].type, "server_tool_use");
assert.equal(cloned[0].id, "srvtoolu_test");
assert.deepEqual(cloned[0].input, { query: "サンプル製菓" });
assert.notEqual(cloned, searchBlocks);

assert.equal(shouldContinueAnthropicTurn("pause_turn"), true);
assert.equal(shouldContinueAnthropicTurn("max_tokens"), true);
assert.equal(shouldContinueAnthropicTurn("end_turn"), false);
assert.equal(shouldContinueAnthropicTurn("tool_use"), false);

const debug = formatAnthropicDebug({
  text: null,
  stopReason: "pause_turn",
  types: "server_tool_use,web_search_tool_result",
  textLength: 0,
  turns: 2,
  error: "empty_text",
});
assert.match(debug, /stop=pause_turn/);
assert.match(debug, /types=server_tool_use,web_search_tool_result/);
assert.match(debug, /textLen=0/);
assert.match(debug, /turns=2/);
assert.match(debug, /error=empty_text/);

console.log("check:t09-preparation OK");

for (const url of ["javascript:alert('https://example.com')", "https://user:pass@example.com", "prefix https://example.com", "https://example.com/with space"]) {
  const invalid = normalizePreparationOutput({industry_summary: "未検証の断定", sources:[{url}], pain_hypotheses:[{hypothesis:"仮説",source_url:url}]});
  assert.equal(invalid.sources.length,0);
  assert.equal(invalid.industry_summary,"確認できず");
  assert.equal(invalid.pain_hypotheses[0].source_url,"");
}
console.log("T09 unsafe/invalid source URL checks passed");
