// Offline report. No database or provider connections. No model prices are assumed.
import fs from "node:fs/promises";
import {createRequire} from "node:module";
import type {AiMeasurement, TokenRates} from "../src/lib/ai/usage";
const {estimateTextCost,forecastMonthly}=createRequire(import.meta.url)("../src/lib/ai/usage.ts") as typeof import("../src/lib/ai/usage");
const [logFile, configFile] = process.argv.slice(2);
if (!logFile || !configFile) throw Error("Usage: node --import tsx scripts/report-ai-cost.mts LOG CONFIG.json");
// No default budget: the old 2,000 JPY was historical, and the current 30,000 JPY total / 25,000 JPY AI
// allowance are reservations, not billing. Set a comparison budget explicitly when one is wanted.
const budgetEnv = process.env.LUMA_AI_COST_REPORT_BUDGET_JPY?.trim();
const budgetJpy = budgetEnv ? Number(budgetEnv) : null;
if (budgetJpy !== null && !(Number.isFinite(budgetJpy) && budgetJpy >= 0)) throw Error("Invalid LUMA_AI_COST_REPORT_BUDGET_JPY");
const config = JSON.parse(await fs.readFile(configFile, "utf8")) as {
  rates: Record<string, { values: TokenRates; source: string; verifiedAt: string }>;
  samples: Record<string, number>; monthlyCount: number; fixedMonthlyJpy: number | null;
};
const records: AiMeasurement[] = (await fs.readFile(logFile, "utf8")).split(/\r?\n/)
  .filter(line => line.includes("[ai-usage] "))
  .map(line => JSON.parse(line.slice(line.indexOf("[ai-usage] ") + 11)));
const seen = new Set<string>();
const unique = records.filter(r => {if (seen.has(r.id)) return false; seen.add(r.id); return true});
const features = ["brief", "minutes", "bant", "context", "transcription", "meeting_extract", "other"];
// 月次見込みは毎回使う機能だけ。meeting_extract は長い記録だけで使うため（割合が未計測）、見込みに含めず個別に示す。
const forecastFeatures = ["brief", "minutes", "bant", "context", "transcription"];
const report = features.map(feature => {
  const calls = unique.filter(r => r.feature === feature);
  const costs = calls.map(r => {
    const key = `${r.provider}/${r.model}`, rate = config.rates[key];
    if (!rate?.source || !rate.verifiedAt) return null;
    // Stop on a missing/invalid rate key rather than printing a partial report; name the entry to fix.
    try { return estimateTextCost(r, rate.values); } catch { throw Error(`Invalid rates: ${key}`); }
  });
  const totalJpy = calls.length && costs.every(c => c !== null) ? costs.reduce<number>((sum,c)=>sum+c!,0) : null;
  const samples = config.samples[feature];
  const unitJpy = totalJpy !== null && Number.isSafeInteger(samples) && samples > 0 ? totalJpy / samples : null;
  return {feature,calls:calls.length,elapsedMs:calls.reduce((sum,c)=>sum+c.elapsedMs,0),samples:samples??null,totalJpy,unitJpy,
    monthlyVariableJpy:forecastMonthly([unitJpy],[config.monthlyCount],0)};
});
const measured = report.filter(r=>r.calls>0);
const knownCost = measured.length && measured.every(r=>r.totalJpy!==null) ? measured.reduce((s,r)=>s+r.totalJpy!,0) : null;
console.log(JSON.stringify({
  kind:"usage_based_estimate_not_invoice", generatedAt:new Date().toISOString(),
  verificationBudgetJpy:budgetJpy, calls:unique.length, estimatedJpy:unique.length===0?0:knownCost,
  remainingJpy:budgetJpy===null?null:unique.length===0?budgetJpy:knownCost===null?null:budgetJpy-knownCost,
  features:report,
  monthlyJpy:forecastMonthly(report.filter(r=>forecastFeatures.includes(r.feature)).map(r=>r.unitJpy),Array(forecastFeatures.length).fill(config.monthlyCount),config.fixedMonthlyJpy),
  notes:["未計測・不明な費用はnull。予算の自動停止機能ではない。","samplesには独立した機能実行回数を指定。複数ステップ・リトライは同じ1実行として集計。",
    "verificationBudgetJpyはLUMA_AI_COST_REPORT_BUDGET_JPY指定時のみ。総予算30,000円・AI予約枠25,000円は予約額で請求額ではないため、既定では残額を出さない。",
    "Vertexのsearchは、gemini-2.x は検索付き1リクエストあたり円、gemini-3 以降は実行された検索クエリ1件あたり円（件数の記録がなければnull）。無料枠は見込まない上限側。gemini-3 以降は検索結果の入力tokenを課金しない。音声はaudioInput（100万tokenあたり円）設定時のみ計算し、未設定ならnull。",
    "Workspace・保存容量・課金済み失敗/SDK内部リトライ・Vertex以外の音声は別途確認。",
    "meeting_extract（長い記録の原文抜粋の抽出）は長い記録でだけ発生するため、monthlyJpyに含めない。features内の値を長い記録の件数で別途見積もる。"],
},null,2));
