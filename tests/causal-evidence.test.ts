import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { constrainUnverifiedCausalRecommendations } from "../src/lib/ai/causal-evidence";

const source = "顧客：説明会後に一次面接へ進む学生が少ないことが課題です。原因は調べていません。";
const claim = "一次面接へ進む学生が少ない点に焦点を当て、その原因となっている「仕事内容が伝わりにくい」点を確認する。";
const repaired = claim.replace("その原因となっている", "課題との因果関係を確認すべき");

test("observed v13 opening becomes a causal verification task without changing quoted issues or later steps", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const opening = "まず、顧客の課題である「説明会後に一次面接に進む学生が少ない」「仕事内容の説明が伝わりにくい」という点に焦点を当て、その原因となっている「学生が配属後の仕事内容を想像できない」「担当者によって説明内容が異なる」「実際の仕事の様子が伝わっていない」といった点を解決するための具体的な情報収集と提案を行う。";
  const ending = "\n1. 学生からの質問内容を整理する。\n2. 社内調整の支援を行う。";
  const original = Object.freeze({ topSales: Object.freeze({ winning_scenario: opening + ending }), strategy: Object.freeze({ strategy: "未確認事項を確認する。" }) });
  const before = JSON.stringify(original);
  const result = constrainUnverifiedCausalRecommendations(transcript, original);
  assert.equal(result.value.topSales.winning_scenario, opening.replace("その原因となっている", "課題との因果関係を確認すべき") + ending);
  assert.deepEqual(result.changedPaths, ["topSales.winning_scenario"]);
  assert.match(result.sourceQuote!, /学生が辞退した理由の集計まではまだできていません/u);
  assert.ok(transcript.includes(result.sourceQuote!));
  assert.equal(result.value.strategy, original.strategy);
  assert.equal(JSON.stringify(original), before);
  assert.equal(constrainUnverifiedCausalRecommendations(transcript, result.value).value, result.value);
});

test("independent explicit unknown cause statements qualify only the matching recruitment outcome", () => {
  for (const transcript of [source, "顧客：選考への移行率が低い理由は未確認です。", "佐藤（顧客）：学生が辞退した理由は未集計です。"])
    assert.equal(constrainUnverifiedCausalRecommendations(transcript, { action: claim }).value.action, repaired);
  const original = { strategy: "売上が減った原因となっている価格差を確認する。", risks: ["予算承認が遅れた原因となっている社内調整を確認する。"],
    action: "面接へ進む学生が少ない件を確認しつつ、予算承認が遅れた原因となっている社内調整を確認する。",
    reason: "面接へ進む学生が少ない件と予算承認の遅れを分けて考え、予算の遅れに焦点を当て、その原因となっている社内調整を確認する。" };
  assert.equal(constrainUnverifiedCausalRecommendations(source, original).value, original);
});

test("unrelated, seller, unknown-speaker, quoted, questioned and negated uncertainty do not activate the guard", () => {
  for (const transcript of [
    "顧客：SNSが原因で応募が減っているかも分かりません。",
    "顧客：面接に進む学生が少ないです。予算不足の原因は未調査です。",
    "顧客：面接に進む学生が少ないです。予算が不足しています。原因は未調査です。",
    source.replace("顧客", "営業"), source.replace("顧客", "話者1"),
    "顧客：『面接へ進む学生が少ない原因は未調査です』と他社から聞きました。",
    "顧客：面接へ進む学生が少ない原因は未調査ですか？",
    "顧客：面接へ進む学生が少ない原因は未調査ではありません。",
    "顧客：もし面接へ進む学生が少ない原因が未調査なら、確認したいです。",
  ]) {
    const original = { winning_scenario: claim };
    assert.equal(constrainUnverifiedCausalRecommendations(transcript, original).value, original, transcript);
  }
});

test("verified causes remain unchanged, including a later actual customer confirmation", () => {
  const proof = "顧客：調査の結果、面接に進む学生が少ない原因は説明不足だと確認しました。";
  for (const transcript of [proof, `${source}\n${proof}`]) {
    const original = { winning_scenario: claim };
    assert.equal(constrainUnverifiedCausalRecommendations(transcript, original).value, original);
  }
  assert.equal(constrainUnverifiedCausalRecommendations(`${proof}\n${source}`, { action: claim }).value.action, repaired);
});

test("literal source fields and quoted spans are immutable while adjacent generated assertions can be repaired", () => {
  const original = { quote: claim, source_quote: { text: claim }, sourceText: claim, transcript: claim,
    reasons: [`原文: ${claim}`, `顧客発言（原文）: ${claim}`, `文字起こし記載: ${claim}`,
      `原文: 顧客：面接へ進む学生が少ないです。\n  面接へ進む学生が少ない原因となっている点を確認する。`,
      `文字起こし記載: 顧客：面接へ進む学生が少ないです。\r\n${claim}`],
    strategy: `『${claim}』\r\n${claim}` };
  const result = constrainUnverifiedCausalRecommendations(source, original);
  assert.equal(result.value.quote, claim);
  assert.equal(result.value.source_quote, original.source_quote);
  assert.equal(result.value.sourceText, claim);
  assert.equal(result.value.transcript, claim);
  assert.equal(result.value.reasons, original.reasons);
  assert.equal(result.value.strategy, `『${claim}』\r\n${repaired}`);
  assert.equal(constrainUnverifiedCausalRecommendations(`${source}\n顧客：${claim}`, { action: claim }).value.action, claim);
  const rawPassage = "営業：こちらの仮説について確認します。\n  面接へ進む学生が少ない原因となっている点を確認する。";
  const quoted = { reason: `原文: ${rawPassage}` };
  assert.equal(constrainUnverifiedCausalRecommendations(`${source}\n${rawPassage}`, quoted).value, quoted);
  for (const text of [`「${claim}`, `“${claim}”`, `"${claim}"`, `『前提「${claim}」です。』`])
    assert.equal(constrainUnverifiedCausalRecommendations(source, { action: text }).value.action, text);
});

test("questions, hypotheses, denials and other causal wording are not rewritten", () => {
  for (const text of [
    "面接へ進む学生が少ない原因となっているか確認する。",
    "面接へ進む学生が少ない原因となっている可能性を調べる。",
    "面接へ進む学生が少ない原因となっているとは断定できない。",
    "面接へ進む学生が少ない原因を確認する。",
    "面接へ進む学生が少ない理由は説明不足だ。",
  ]) assert.equal(constrainUnverifiedCausalRecommendations(source, { action: text }).value.action, text);
});

test("bounded traversal preserves raw objects, cycles, oversized text and getters", () => {
  let accessed = false;
  const original = { action: claim, get quote() { accessed = true; throw Error("getter"); } };
  const result = constrainUnverifiedCausalRecommendations(source, original);
  assert.equal(result.value.action, repaired);
  assert.equal(accessed, false);
  const cycle: Record<string, unknown> = { action: claim }; cycle.self = cycle;
  assert.deepEqual(constrainUnverifiedCausalRecommendations(source, cycle).skippedPaths, ["self"]);
  const oversized = "x".repeat(100_001) + claim;
  assert.equal(constrainUnverifiedCausalRecommendations(source, { action: oversized }).value.action, oversized);
  assert.equal(original.action, claim);
});
