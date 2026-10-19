import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildEvidenceSafeFallback } = require("../src/lib/ai/pipeline.ts") as typeof import("../src/lib/ai/pipeline");
const { buildPreparationResearchPrompt } = require("../src/lib/ai/preparation.ts") as typeof import("../src/lib/ai/preparation");

const factualTranscript = [
  "顧客: 予算は250万円以内です。",
  "営業: 撮影素材は媒体別に編集します。",
  "営業: 撮影と本編制作を提案します。",
  "営業: 追加撮影の費用は別途です。",
  "顧客: 最終決裁者は代表取締役で、9月15日の経営会議に出します。",
  "顧客: 面接前辞退が35％あり、改善が課題です。",
  "顧客: 導入するなら2027年4月を希望します。正式な時期は未確定です。",
  "営業: 9月3日までに見積を送付します。",
].join("\n");

const factual = buildEvidenceSafeFallback(factualTranscript);
assert.match(factual.analysis.bant.budget, /250万円/u);
assert.match(factual.analysis.bant.authority, /代表取締役/u);
assert.match(factual.analysis.bant.timeline, /2027年4月/u);
assert.match(factual.analysis.bant.timeline, /導入するなら.*希望.*未確定/u);
// The same speaker's surrounding sentences remain verbatim so qualifiers in
// separate lines cannot be lost. The meeting date keeps its actual subject.
assert.match(factual.analysis.bant.timeline, /9月15日の経営会議に出します/u);
assert.doesNotMatch(factual.analysis.bant.timeline, /9月3日|9月15日(?:に|の)?導入/u);
const meetingDateOnly = buildEvidenceSafeFallback("顧客: 9月15日の経営会議に出します。導入はまだ決めていません。");
assert.match(meetingDateOnly.analysis.bant.timeline, /^未確定:/u);
assert.doesNotMatch(factual.analysis.bant.timeline, /3か月の短尺運用/u);
assert.match(factual.analysis.bant.need, /35％/u);
assert.match(factual.nextActions.next_actions[0]?.action ?? "", /9月3日までに見積を送付/u);

const sparseTranscript = "顧客: 今日は情報交換をお願いします。";
const sparse = buildEvidenceSafeFallback(sparseTranscript);
const sparseJson = JSON.stringify(sparse);
assert.match(sparse.analysis.bant.budget, /^未確認:/u);
assert.match(sparse.analysis.bant.authority, /^未確認:/u);
assert.match(sparse.analysis.bant.timeline, /^未確認:|^未確定:/u);
assert.match(sparse.topSales.real_intent, /^未確認:/u);
assert.match(sparse.topSales.winning_scenario, /^仮説:/u);
for (const forbidden of ["48時間", "24時間", "Week1", "競合が並行", "ROI 1枚", "3段階"]) {
  assert.equal(sparseJson.includes(forbidden), false, `未言及の固定文を出さない: ${forbidden}`);
}

const preparationPrompt = buildPreparationResearchPrompt(
  {
    id: "t18-preparation",
    title: "採用広報",
    status: "PROPOSAL",
    bant: null,
    company: { name: "架空食品", industry: "食品", employeeCount: null, websiteSummary: null },
    products: [],
    meetings: [
      {
        title: "採用ヒアリング",
        meetingDate: new Date("2026-08-30T00:00:00.000Z"),
        transcript: "顧客: はい。面接前辞退が約35パーセントあります。",
        minutes: "営業: 選考途中の離脱にも課題がありますか。",
        bantBudget: null,
        bantAuthority: null,
        bantNeed: null,
        bantTimeline: null,
      },
    ],
  },
  "Luma商材コンテキスト",
);
assert.match(preparationPrompt.user, /Authoritative transcript[\s\S]*面接前辞退が約35パーセント/u);
assert.match(preparationPrompt.system, /follow the transcript and do not claim that a response or fact was absent/u);

console.log("T18 quality checks passed: evidence-backed BANT / transcript-first brief / no legacy fixed hallucinations");
