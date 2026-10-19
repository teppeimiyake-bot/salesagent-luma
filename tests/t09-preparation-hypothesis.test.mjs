// T09: the model's own confidence written into a pain-hypothesis text must not contradict the app's confidence badge.
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

const allowed = ["src/lib/ai/preparation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/vertex-policy.ts"];
const api = await offlineModule("src/lib/ai/preparation.ts", {}, {
  "./vertex-grounding": "export const vertexPreparation=async()=>{throw Error('AI forbidden')};export const preparationFormattingWorstCaseBytes=()=>0;",
  "@/lib/ai/anthropic": "export const callClaudeHeavyJSONWithTools=()=>{throw Error('AI forbidden')};export const formatAnthropicDebug=()=>'';export const getAnthropicModelName=()=>'';",
  "@/lib/ai/provider": "export const getHeavyTextProvider=()=> 'vertex';export const hasAnthropicKey=()=>false;",
  "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=x=>x;export const getLumaContextText=async()=>'';",
  "@/lib/db": "export const prisma={};",
}, allowed);
const { withoutEmbeddedConfidence: strip, normalizePreparationOutput } = api;

test("T09 the model's embedded confidence is removed from the hypothesis text; the rest of the note stays in place", () => {
  // Recorded on the live site (gemini-3.5-flash-lite, 2026-09-29).
  const quote = "『採用説明会の動画を毎回外注していて、1本あたりの費用と納期がかかりすぎています。』";
  const recorded = `採用説明会の動画制作を外注しており、費用と納期が負担になっている可能性（信頼度: high, 社内商談記録: 2026-09-29 ${quote}）`;
  assert.equal(strip(recorded), `採用説明会の動画制作を外注しており、費用と納期が負担になっている可能性（社内商談記録: 2026-09-29 ${quote}）`);
  const [pain] = normalizePreparationOutput({ pain_hypotheses: [{ hypothesis: recorded, confidence: "high", evidence: "2026-09-29の商談記録における顧客の発言", source_url: "" }] }).pain_hypotheses;
  assert.ok(!pain.hypothesis.includes("信頼度"));
  assert.equal(pain.confidence, "high", "confidence handling is unchanged here (Vertex grounding lowers unsourced ones later)");
  assert.equal(pain.evidence, "出典なしの仮説: 2026-09-29の商談記録における顧客の発言", "evidence and its prefix are unchanged");
  for (const [input, expected] of [
    ["費用負担の可能性（信頼度: high）", "費用負担の可能性"],
    ["費用負担の可能性（信頼度：高）。", "費用負担の可能性。"],
    ["費用負担の可能性(confidence: Medium)", "費用負担の可能性"],
    ["費用負担の可能性（確度: 低）", "費用負担の可能性"],
    ["費用負担の可能性（社内商談記録より、信頼度: 中程度）", "費用負担の可能性（社内商談記録より）"],
    ["費用負担の可能性 - （信頼度: 高）", "費用負担の可能性"],
    ["費用負担の可能性（信頼度: high, 確度: low）", "費用負担の可能性"],
    ["費用負担の可能性です。（信頼度: 高）。", "費用負担の可能性です。"],
    ["費用負担の可能性？（信頼度: 高）。", "費用負担の可能性？"],
  ]) assert.equal(strip(input), expected, input);
  // Long separator runs stay fast (the trailing trim is linear).
  const started = Date.now();
  assert.equal(strip("a" + "-".repeat(100_000) + "x（信頼度: 高）"), "a" + "-".repeat(100_000) + "x");
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test("T09 anything that is not clearly an embedded confidence item is left unchanged", () => {
  for (const input of [
    "費用負担の可能性（採用動画の本数が多いため）",
    "費用負担の可能性（確度:高い人材の確保）",
    "費用負担の可能性（信頼度: highly uncertain）",
    "費用負担の可能性（Confidence: High (80%)）",
    "費用負担の可能性（信頼度: high / 80%）",
    "費用負担の可能性（社内で信頼度: high と判断、根拠あり）",
    "（信頼度: high）",
    "費用負担の可能性【信頼度: 高】",
    "費用負担の（信頼度: 高）可能性",
    "費用負担の可能性",
    "",
  ]) assert.equal(strip(input), input, input);
});

// Recorded on the cloud recheck (トヨタ自動車株式会社, 2026-10-01): the model wrote the redirect URL into the
// evidence text and left source_url empty, so the panel showed 「出典なしの仮説: …（出典: https://…）」.
test("T09 a URL written into the evidence is a source only when it is a verified source; otherwise it is removed", () => {
  const verified = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHUA7l44prNmM8C3FIuX4jre4JW8sAFur2AcRhgjqqf_upSlTqv8gwNp4P0DP03_QobQvVXu2Wne6PuCCT1CDT9vA0Vy3AjrjS7LZa40yOUjkt_Y6LPEKWvveC0ygk=";
  const unverified = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/NOT-IN-THE-SOURCE-LIST=";
  const fact = "トヨタ自動車株式会社は、「事務職」「技術職」「業務職」などのコース別に新卒採用を実施しています";
  const sources = [{ title: "recruit.toyota", url: verified }];
  const hypothesis = "コース別新卒採用で仕事内容を応募前に伝える必要がある可能性";
  const one = (evidence, source_url = "", extra = {}) => normalizePreparationOutput({ sources, hiring_insights: { roles: fact, sources }, ...extra,
    pain_hypotheses: [{ hypothesis, confidence: "low", evidence, source_url }] }).pain_hypotheses[0];

  // Verified URL in the text: it becomes the source, the label is not 出典なし and the text has no raw URL.
  const recorded = one(`${fact}（出典: ${verified}）`);
  assert.equal(recorded.source_url, verified);
  assert.equal(recorded.evidence, fact);
  assert.doesNotMatch(recorded.evidence, /出典なし|https?:|出典:/);
  // Also as a hiring source only, and with the half-width form.
  assert.equal(one(`${fact} (出典：${verified})`, "", { sources: [] }).source_url, verified);

  // Unverified URL: not a source, removed from the text, still labeled 出典なし.
  for (const evidence of [`${fact}（出典: ${unverified}）`, `${fact} 出典: ${unverified}`, `${fact} ${unverified}`, `${fact}（参照: ${unverified}、${verified}x）`]) {
    const pain = one(evidence);
    assert.equal(pain.source_url, "", evidence);
    assert.equal(pain.evidence, `出典なしの仮説: ${fact}`, evidence);
  }
  // A URL-only evidence falls back to the unconfirmed note rather than an empty label.
  assert.equal(one(`（出典: ${unverified}）`).evidence, "出典なしの仮説: 根拠は公開情報では確認できず。");
  // With source_url already set, a URL in the text is removed and the given source is kept.
  const given = one(`${fact}（出典: ${unverified}）`, verified);
  assert.equal(given.source_url, verified);
  assert.equal(given.evidence, fact);
  // Without any URL nothing changes.
  assert.equal(one("2026-09-29の商談記録における顧客の発言").evidence, "出典なしの仮説: 2026-09-29の商談記録における顧客の発言");
});
