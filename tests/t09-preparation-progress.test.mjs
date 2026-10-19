import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

// T09 §3-4 生成中は進捗（リサーチ中→生成中）が表示される。
// The panel only shows the saved status, so runPreparationBrief must save
// 生成中 while the Vertex formatting call runs: after the search call has
// returned and before the formatting call starts. Saving it after both calls
// (the previous behavior) made the panel jump from リサーチ中 to 完了.
function fixture() {
  return {
    id: "offline-deal", title: "検証製菓の採用動画", status: "PROPOSAL",
    bant: { budget: "80万円", authority: "人事部長", need: "応募数不足", timeline: "2027年3月" },
    company: { name: "検証製菓株式会社", industry: "菓子製造", employeeCount: null, websiteSummary: null },
    products: [{ productName: "採用動画", planName: null, planProposals: [], yomiStatus: null, amount: null }],
    meetings: [{
      title: "第1回商談", meetingDate: new Date("2026-09-23T06:30:00Z"),
      transcript: "予算80万円です。新卒採用への応募数不足が課題です。", minutes: "要約",
      bantBudget: "80万円", bantAuthority: "人事部長", bantNeed: "応募数不足", bantTimeline: "2027年3月",
    }],
  };
}
const formattedOutput = {
  industry_summary: "確認できず", sources: [],
  hiring_insights: { media: "確認できず", roles: "確認できず", scale: "確認できず", sources: [] },
  pain_hypotheses: [],
  proposal_story: "# つかみ\n社内商談記録を確認します。\n\n# 課題共感\n採用課題を確認します。\n\n# 商材提案\n採用動画を候補にします。\n\n# 効果イメージ\n応募前理解を助ける仮説です。\n\n# 確認論点\n予算の上限を確認します。",
};

// One ordered log of AI calls and DB writes. A write is logged when it has been
// saved (after an asynchronous turn), so a write the flow does not wait for
// shows up after the call that follows it.
async function load({ provider = "vertex" } = {}) {
  const state = {
    deal: fixture(), provider, events: [],
    search: () => ({ text: "検証製菓株式会社は菓子を製造しています。", model: "offline-search", groundingMetadata: {} }),
    format: () => ({ text: JSON.stringify(formattedOutput), model: "offline-format" }),
    anthropic: () => ({ parsed: formattedOutput, debug: {} }),
  };
  const api = await offlineModule("src/lib/ai/preparation.ts", state, {
    "./vertex": "export const vertexGenerate=async(options)=>{mocks.events.push(options.search?'call:search':'call:format');return options.search?mocks.search(options):mocks.format(options)};",
    "@/lib/ai/anthropic": "export const callClaudeHeavyJSONWithTools=async()=>{mocks.events.push('call:anthropic');return mocks.anthropic()};export const formatAnthropicDebug=()=>'debug';export const getAnthropicModelName=()=>'offline-claude';",
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=>mocks.provider;export const hasAnthropicKey=()=>mocks.provider==='anthropic';",
    "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=x=>x;export const getLumaContextText=async()=>'# 商材カタログ\\n- 採用動画';",
    "@/lib/db": "export const prisma={deal:{findUnique:async()=>mocks.deal},preparationBrief:{update:async(args)=>{await new Promise(r=>setTimeout(r,1));mocks.events.push('saved:'+args.data.status);return args}},aiLog:{create:async(args)=>args}};",
  }, ["src/lib/ai/preparation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/vertex-grounding.ts", "src/lib/ai/vertex-policy.ts"]);
  return { api, state };
}

test("T09 Vertex: 生成中 is saved after the search call returns and before the formatting call", async () => {
  const { api, state } = await load();
  await api.runPreparationBrief("brief-1", "offline-deal");
  assert.deepEqual(state.events, [
    "saved:researching",
    "call:search",
    "saved:generating",
    "call:format",
    "saved:done",
  ]);
});

test("T09 Vertex: no 生成中 when the search call fails; a failed formatting call ends 生成中 as 失敗", async () => {
  const searchFails = await load();
  searchFails.state.search = () => { throw new Error("search failed"); };
  await searchFails.api.runPreparationBrief("brief-1", "offline-deal");
  assert.deepEqual(searchFails.state.events, ["saved:researching", "call:search", "saved:error"]);

  const formatFails = await load();
  formatFails.state.format = () => { throw new Error("format failed"); };
  await formatFails.api.runPreparationBrief("brief-1", "offline-deal");
  assert.deepEqual(formatFails.state.events, ["saved:researching", "call:search", "saved:generating", "call:format", "saved:error"]);
});

test("T09 Anthropic: one call searches and generates, so 生成中 is written only after it (known limit: リサーチ中→完了)", async () => {
  const { api, state } = await load({ provider: "anthropic" });
  await api.runPreparationBrief("brief-1", "offline-deal");
  assert.deepEqual(state.events, ["saved:researching", "call:anthropic", "saved:generating", "saved:done"]);
});

test("T09 generatePreparationResearch without a progress callback saves no status", async () => {
  const { api, state } = await load();
  const result = await api.generatePreparationResearch("offline-deal");
  assert.equal(result.fallback, false);
  assert.deepEqual(state.events, ["call:search", "call:format"]);
});
