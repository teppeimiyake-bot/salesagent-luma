import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { offlineModule } from "./helpers/offline-module.mjs";

// The Vertex formatting call embeds the preparation prompt with the search
// result and must fit the 65,536-byte input check of every Vertex call.
const LIMIT = 65536;
const OMISSION = "\n…（中略）…\n";
const UNREGISTERED_OFFER_RULE = "- 商材が未登録のため、# つかみ と # 課題共感 では Luma（弊社）による提案・提供・支援を表明・約束しないでください（例:「ご提案します」「支援いたします」）。提案・提供に関わる内容は # 確認論点 に回してください。";
const registered = "# 商材カタログ\n- 採用動画";
// About the size of the shared Luma context (~7.5KB); only the catalog row is a registration.
const lumaContext = `${registered}\n# 利用ルール\n${"- 商材名・プラン名・企画型は、カタログにある正式名称だけを使ってください。\n".repeat(60)}`;

function fixture() {
  return {
    id: "offline-deal", title: "架空サンプル製菓の採用動画", status: "PROPOSAL",
    bant: {
      budget: "予算80万円を目安にする。",
      authority: "窓口は人事担当。最終的には管理部門を担当する取締役が決裁する。",
      need: "新卒採用への応募数不足", timeline: "2027年3月希望",
      manualFields: { budget: true, authority: true, need: true, timeline: true },
      items: { authority: { value: "古い役員", status: "confirmed", quote: "User edited this BANT field manually." } },
      aiSuggestion: { authority: { value: "OLD_SUGGESTION_MUST_NOT_BE_USED" } },
      confidence: 100, summary: "OLD_SUMMARY_MUST_NOT_BE_USED",
    },
    company: { name: "架空サンプル製菓株式会社", industry: "菓子製造", employeeCount: null, websiteSummary: "社内未検証要約" },
    products: [{ productName: "採用動画", planName: null, planProposals: [], yomiStatus: null, amount: null }],
    meetings: [{
      title: "第6回商談", meetingDate: new Date("2026-09-23T06:30:00Z"),
      transcript: "予算80万円です。最終決裁者は人事部長の山田さんです。新卒採用への応募数不足が課題です。2027年3月希望です。",
      minutes: "旧要約では取締役とされている。",
      bantBudget: "80万円", bantAuthority: "人事部長の山田さん", bantNeed: "新卒採用への応募数不足", bantTimeline: "2027年3月希望",
    }],
  };
}
// A synthetic transcript in the joined-segment shape (about 2.6-2.9 bytes per character).
function transcript(chars, tag, ending = "") {
  let out = "";
  for (let i = 0; out.length < chars; i += 1) {
    out += `［${Math.floor(i / 6)}:${String((i % 6) * 10).padStart(2, "0")}〜］話者${(i % 2) + 1}: ${tag}の${i}件目の発言です。応募数と説明会の参加率について確認しました。\n`;
  }
  return out.slice(0, chars - ending.length) + ending;
}
function meeting(index, transcriptText, minutes = "議事録の要約です。".repeat(200)) {
  return {
    title: `第${index}回商談`, meetingDate: new Date(Date.UTC(2026, 8, 10 + index, 1)),
    transcript: transcriptText, minutes,
    bantBudget: "80万円", bantAuthority: "人事部長の山田さん", bantNeed: "応募数不足", bantTimeline: "2027年3月",
  };
}
const correction = (index) => `話者2: 最終訂正です。第${index}回では予算の上限を120万円に変更します。`;
const longMeeting = (index) => meeting(index, transcript(18000, `長い${index}`, correction(index)));

// SHA-256 of JSON.stringify(buildPreparationResearchPrompt(...)) before the budget change.
const lockedCases = {
  base: { make: () => [fixture(), registered], prompt: "a13b1044361078a8dbf10bcf6d4342e6eeef70e3b46fa83c308bc27f89ff2097" },
  catalogHeading: { make: () => [fixture(), "# Catalog\n- 採用動画"], prompt: "04e9cec961d45f18f26a1855112948e9ed7cfe42d5c22903ae4d6eb41e86fd7e" },
  twoMeetings: {
    make: () => {
      const deal = fixture();
      deal.meetings.push({ ...deal.meetings[0], title: "第7回商談", meetingDate: new Date("2026-09-24T00:00:00Z"), transcript: "日程だけを相談しました。", bantAuthority: "未確認" });
      return [deal, "# Catalog\n- 採用動画"];
    },
    prompt: "93e113f7e6ffacdce0bd4de56e88e687a9eb16e125f46a7580679e329953b70b",
  },
  oneLongMeeting: { make: () => [{ ...fixture(), meetings: [meeting(1, transcript(18000, "単独"))] }, registered], prompt: "53e63feea094780b4afc2054d48e3e1f83da9f3a14fc61196a9b65a40df9772c" },
  threeShortMeetings: {
    make: () => [{ ...fixture(), meetings: [1, 2, 3].map((i) => meeting(i, transcript(1500, `短い${i}`), "議事録の要約です。".repeat(100))) }, registered],
    prompt: "8ed44467f3e22f331acccfbd22e20d6131be0bd458a0dab231512c2eaac9af5a",
  },
};
// The same fixture without any registered product or catalog row, before the change.
const lockedUnregistered = {
  system: "31b26f9eb074eb40a5357df8a899f4dc4dc9b7828d9ac40c8f5267296545ded9",
  user: "05b15498f1c61baf7aa495c200e1781ddcd3a562d6fa153027a014df56488aaa",
};

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value) => Buffer.byteLength(value, "utf8");
const allowed = ["src/lib/ai/preparation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/vertex-grounding.ts", "src/lib/ai/vertex-policy.ts"];

// A search result that uses almost the whole reserve: cited sentences naming the company and long redirect URLs.
// The fixture's own name contains 架空, which the company scope rejects, so the flow test uses another name.
const companyName = "検証製菓株式会社";
function searchResponse(count = 95) {
  const sources = Array.from({ length: 8 }, (_, i) => ({ web: { title: `source${i}.example.test`, uri: `https://vertexaisearch.example.test/grounding-api-redirect/${String(i).repeat(200)}` } }));
  const sentences = Array.from({ length: count }, (_, i) => `${companyName}は第${i}の拠点で菓子の製造と販売を行っています。`);
  return {
    text: sentences.join("\n"), model: "offline-search",
    groundingMetadata: {
      groundingChunks: sources,
      groundingSupports: sentences.map((sentence, i) => ({ segment: { text: sentence }, groundingChunkIndices: [i % sources.length] })),
      searchEntryPoint: { renderedContent: "<div>Google Search suggestions</div>" },
    },
  };
}
const formattedOutput = {
  industry_summary: "確認できず", sources: [],
  hiring_insights: { media: "確認できず", roles: "確認できず", scale: "確認できず", sources: [] },
  pain_hypotheses: [],
  proposal_story: "# つかみ\n社内商談記録を確認します。\n\n# 課題共感\n採用課題を確認します。\n\n# 商材提案\n採用動画を候補にします。\n\n# 効果イメージ\n応募前理解を助ける仮説です。\n\n# 確認論点\n予算の上限を確認します。",
};

async function load(deal = fixture(), contextText = registered) {
  const state = {
    deal, contextText, calls: [], writes: [], logs: [], anthropic: false, anthropicCalls: [],
    respond(options) {
      if (options.search) return searchResponse(state.searchSentences);
      // Same input check as vertexGenerate, which runs before its reservation.
      if (bytes(options.system + options.user) > LIMIT) throw Error("formatting input over the limit");
      return { text: JSON.stringify(formattedOutput), model: "offline-format" };
    },
  };
  const api = await offlineModule("src/lib/ai/preparation.ts", state, {
    "./vertex": "export const vertexGenerate=async(options)=>{mocks.calls.push(options);return mocks.respond(options)};",
    "@/lib/ai/anthropic": "export const callClaudeHeavyJSONWithTools=async(options)=>{if(!mocks.anthropic)throw Error('AI forbidden');mocks.anthropicCalls.push(options);return {parsed:null,debug:{}}};export const formatAnthropicDebug=()=>'';export const getAnthropicModelName=()=>'';",
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=>mocks.anthropic?'anthropic':'vertex';export const hasAnthropicKey=()=>!!mocks.anthropic;",
    "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=x=>x;export const getLumaContextText=async()=>mocks.contextText;",
    "@/lib/db": "export const prisma={deal:{findUnique:async()=>mocks.deal},preparationBrief:{update:async(args)=>{mocks.writes.push(args);return args}},aiLog:{create:async(args)=>{mocks.logs.push(args);return args}}};",
  }, allowed);
  return { api, state };
}
const grounding = await offlineModule("src/lib/ai/vertex-grounding.ts", {}, {
  "./vertex": "export const vertexGenerate=()=>{throw Error('Real AI forbidden')};",
}, ["src/lib/ai/vertex-grounding.ts", "src/lib/ai/vertex-policy.ts"]);
const { api } = await load();

function transcriptsIn(user) {
  return [...user.matchAll(/### Authoritative transcript\n([\s\S]*?)\n### Generated meeting minutes/gu)].map((match) => match[1]);
}

test("T09 prompts that already fit the formatting budget stay byte-identical", () => {
  for (const [name, { make, prompt: expected }] of Object.entries(lockedCases)) {
    const [deal, context] = make();
    const prompt = api.buildPreparationResearchPrompt(deal, context);
    assert.ok(grounding.preparationFormattingWorstCaseBytes(prompt) <= LIMIT, name);
    assert.equal(sha(prompt), expected, name);
    assert.ok(!prompt.system.includes(UNREGISTERED_OFFER_RULE), name);
  }
  const [deal] = lockedCases.oneLongMeeting.make();
  const [only] = transcriptsIn(api.buildPreparationResearchPrompt(deal, registered).user);
  assert.equal(only, deal.meetings[0].transcript.slice(0, 6000));
  // A catalog row alone also counts as a registered offering.
  const catalogOnly = api.buildPreparationResearchPrompt({ ...fixture(), products: [] }, registered);
  assert.ok(!catalogOnly.system.includes(UNREGISTERED_OFFER_RULE));
});

test("T09 without any registered offering the prompt adds exactly one instruction line", () => {
  const prompt = api.buildPreparationResearchPrompt({ ...fixture(), products: [] }, "");
  const lines = prompt.system.split("\n");
  assert.equal(lines.filter((line) => line === UNREGISTERED_OFFER_RULE).length, 1);
  assert.equal(sha(lines.filter((line) => line !== UNREGISTERED_OFFER_RULE).join("\n")), lockedUnregistered.system);
  assert.equal(sha(prompt.user), lockedUnregistered.user);
  // The line sits next to the existing empty-list rule.
  const rule = lines.indexOf(UNREGISTERED_OFFER_RULE);
  assert.match(lines[rule - 1], /If the registered-name list is empty/);
  assert.match(prompt.system, /Registered names for this request are \[\]/);
});

test("T09 long meetings are fitted with the start and the latest part of every transcript", () => {
  const deal = { ...fixture(), meetings: [longMeeting(1), longMeeting(2), longMeeting(3)] };
  const before = structuredClone(deal);
  const prompt = api.buildPreparationResearchPrompt(deal, lumaContext);
  const worstCase = grounding.preparationFormattingWorstCaseBytes(prompt);
  assert.ok(worstCase <= LIMIT, `worst case ${worstCase}`);
  // The budget is used rather than left idle.
  assert.ok(worstCase > LIMIT - 64, `worst case ${worstCase}`);
  const excerpts = transcriptsIn(prompt.user);
  assert.equal(excerpts.length, 3);
  // Newest first, as before.
  assert.ok(prompt.user.indexOf("## 第3回商談") < prompt.user.indexOf("## 第2回商談"));
  assert.ok(prompt.user.indexOf("## 第2回商談") < prompt.user.indexOf("## 第1回商談"));
  const sizes = excerpts.map((excerpt, i) => {
    const index = 3 - i;
    assert.equal(excerpt.split(OMISSION).length, 2, `one omission marker in meeting ${index}`);
    assert.ok(excerpt.startsWith(deal.meetings[index - 1].transcript.slice(0, 200)), `start of meeting ${index}`);
    assert.ok(excerpt.endsWith(correction(index)), `latest part of meeting ${index}`);
    assert.ok(!excerpt.includes(`長い${index}の150件目`), `middle of meeting ${index} omitted`);
    const kept = Array.from(excerpt.replace(OMISSION, "")).length;
    assert.ok(kept >= 1500 && kept <= 6000, `meeting ${index} keeps ${kept} characters`);
    return bytes(excerpt);
  });
  // Equal needs get equal shares.
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < 16, sizes.join(","));
  // The previous head-only 6,000-character cut would not have fit.
  const headOnly = worstCase - sizes.reduce((a, b) => a + b, 0) + deal.meetings.reduce((sum, m) => sum + bytes(m.transcript.slice(0, 6000)), 0);
  assert.ok(headOnly > LIMIT, `head-only ${headOnly}`);
  // Only transcripts are cut: minutes and meeting BANT are unchanged.
  for (const m of deal.meetings) assert.ok(prompt.user.includes(m.minutes.slice(0, 1400)));
  assert.deepEqual(deal, before);
  // A provider without the Vertex input limit (Anthropic) keeps the previous 6,000-character heads.
  const unfitted = api.buildPreparationResearchPrompt(deal, lumaContext, { fitVertexFormatting: false });
  assert.ok(!unfitted.user.includes(OMISSION));
  for (const m of deal.meetings) assert.ok(unfitted.user.includes(m.transcript.slice(0, 6000)));
  assert.ok(grounding.preparationFormattingWorstCaseBytes(unfitted) > LIMIT);
});

test("T09 over the budget a short transcript stays whole and the long ones share the rest", () => {
  const deal = { ...fixture(), meetings: [longMeeting(1), longMeeting(2), meeting(3, transcript(900, "短い3", correction(3)))] };
  const prompt = api.buildPreparationResearchPrompt(deal, lumaContext);
  assert.ok(grounding.preparationFormattingWorstCaseBytes(prompt) <= LIMIT);
  const [newest, second, oldest] = transcriptsIn(prompt.user);
  assert.equal(newest, deal.meetings[2].transcript);
  for (const [excerpt, index] of [[second, 2], [oldest, 1]]) {
    assert.ok(excerpt.includes(OMISSION));
    assert.ok(excerpt.endsWith(correction(index)));
  }
});

test("T09 two long meetings fit through the Vertex flow with a reserve-sized search result", async () => {
  const deal = { ...fixture(), company: { ...fixture().company, name: companyName }, meetings: [longMeeting(1), longMeeting(2)] };
  const { api: flow, state } = await load(deal, lumaContext);
  // The previous two 6,000-character heads would not have left room for the search result.
  const prompt = flow.buildPreparationResearchPrompt(deal, lumaContext);
  const excerptBytes = transcriptsIn(prompt.user).reduce((sum, excerpt) => sum + bytes(excerpt), 0);
  const headOnly = grounding.preparationFormattingWorstCaseBytes(prompt) - excerptBytes + deal.meetings.reduce((sum, m) => sum + bytes(m.transcript.slice(0, 6000)), 0);
  assert.ok(headOnly > LIMIT, `head-only ${headOnly}`);
  const result = await flow.generatePreparationResearch(deal.id);
  assert.equal(result.fallback, false);
  assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].search, true);
  const formatting = state.calls[1];
  assert.equal(formatting.search, undefined);
  const size = bytes(formatting.system + formatting.user);
  assert.ok(size <= LIMIT, `formatting input ${size}`);
  // The search result used nearly all of its reserve, so the check was not vacuous.
  const reserved = bytes(result.brief.talking_points.vertexGrounding.text) + bytes(JSON.stringify(result.brief.talking_points.vertexGrounding.sources));
  assert.ok(reserved > 11 * 1024 && reserved <= grounding.PREPARATION_SEARCH_RESULT_RESERVE_BYTES, `search result ${reserved}`);
  assert.ok(size > LIMIT - 1024, `formatting input ${size}`);
  assert.equal(result.brief.talking_points.vertexGrounding.companyMatch, "supported");
  for (const index of [1, 2]) assert.ok(formatting.user.includes(correction(index)));
  assert.equal(state.writes.length, 0);
});

test("T09 a search result larger than its reserve is trimmed from the end so the formatting call still fits", async () => {
  const deal = { ...fixture(), company: { ...fixture().company, name: companyName }, meetings: [longMeeting(1), longMeeting(2)] };
  const { api: flow, state } = await load(deal, lumaContext);
  // About 20KB of cited sentences: more than the 12KB reserve (the search output cap allows up to ~16KB of Japanese and more with sources).
  state.searchSentences = 160;
  const result = await flow.generatePreparationResearch(deal.id);
  assert.equal(state.calls.length, 2);
  const formatting = state.calls[1];
  assert.ok(bytes(formatting.system + formatting.user) <= LIMIT);
  const kept = result.brief.talking_points.vertexGrounding;
  assert.equal(kept.companyMatch, "supported");
  assert.ok(kept.supports.length > 0 && kept.supports.length < 160, `kept ${kept.supports.length}`);
  // The earliest sentences are kept in order, and every citation still points at its own source.
  kept.supports.forEach((support, i) => {
    assert.equal(support.text, `${companyName}は第${i}の拠点で菓子の製造と販売を行っています。`);
    for (const index of support.sourceIndices) assert.ok(kept.sources[index]?.url.includes(String(i % 8).repeat(200)));
  });
  assert.equal(kept.text, kept.supports.map((support) => support.text).join("\n\n"));
  assert.ok(formatting.user.includes(kept.text));
  // As many sentences as fit are kept: the input is within one sentence (about 110 B, all sources already cited) of the limit.
  assert.ok(kept.supports.length >= 100, `kept ${kept.supports.length}`);
  assert.ok(bytes(formatting.system + formatting.user) > LIMIT - 200, `formatting input ${bytes(formatting.system + formatting.user)}`);
  // A result that already fits is passed through unchanged.
  const small = grounding.fitGroundingToFormattingLimit({ system: "s", user: "u" }, kept);
  assert.equal(small, kept);
});

test("T09 the size check refuses before the 100 JPY search call when the formatting call cannot fit", async () => {
  const oversized = [
    // Fixed internal text alone exceeds the limit.
    { ...fixture(), company: { ...fixture().company, websiteSummary: "会社概要の未検証メモです。".repeat(3000) } },
    // Minimum transcript excerpts no longer fit next to long meeting BANT.
    { ...fixture(), meetings: [1, 2, 3].map((i) => ({ ...longMeeting(i), bantTimeline: "導入時期の補足です。".repeat(1200) })) },
  ];
  for (const deal of oversized) {
    const { api: flow, state } = await load(deal);
    const prompt = flow.buildPreparationResearchPrompt(deal, registered);
    assert.ok(grounding.preparationFormattingWorstCaseBytes(prompt) > LIMIT);
    await assert.rejects(flow.generatePreparationResearch(deal.id), (error) =>
      error.code === "input_limit" && error.message === flow.PREPARATION_INPUT_LIMIT_MESSAGE);
    assert.equal(state.calls.length, 0);

    // The existing brief error path records the message; still no AI call.
    await flow.runPreparationBrief("brief-1", deal.id);
    assert.equal(state.calls.length, 0);
    assert.equal(state.writes.at(-1).data.status, "error");
    assert.equal(state.writes.at(-1).data.error, flow.PREPARATION_INPUT_LIMIT_MESSAGE);
    assert.equal(state.logs.length, 0);
  }
  assert.match(api.PREPARATION_INPUT_LIMIT_MESSAGE, /公開情報の検索を行わずに停止しました/);
});

test("T09 the Anthropic path (no Vertex input limit) receives the previous unfitted prompt for long meetings", async () => {
  const deal = { ...fixture(), meetings: [longMeeting(1), longMeeting(2), longMeeting(3)] };
  const { api: flow, state } = await load(deal, lumaContext);
  state.anthropic = true;
  await flow.generatePreparationResearch(deal.id);
  assert.equal(state.anthropicCalls.length, 1);
  const expected = flow.buildPreparationResearchPrompt(deal, lumaContext, { fitVertexFormatting: false });
  assert.equal(state.anthropicCalls[0].user, expected.user);
  assert.ok(!state.anthropicCalls[0].user.includes(OMISSION));
  assert.equal(state.calls.length, 0, "no Vertex call");
});
