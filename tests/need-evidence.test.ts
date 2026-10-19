import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BANT_UNKNOWN_VALUES } from "../src/lib/ai/bant-definitions";
import { constrainBantStatus, findMeetingBantEvidence, isUnknownBantValue } from "../src/lib/ai/bant-reconciliation";
import { groundNeedEvidence } from "../src/lib/ai/need-evidence";
import { timelineSourceTurns } from "../src/lib/ai/timeline-evidence";

test("Need projection preserves the actual recipient and media-specific predicate from primary source", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const turns = timelineSourceTurns(transcript);
  for (const id of [4, 15, 17]) {
    const result = groundNeedEvidence(transcript, [id]);
    assert.equal(result.value, `文字起こし記載: ${turns[id - 1].text}`);
    assert.equal(result.basis, "literal_source");
    assert.doesNotMatch(result.value, /学生が会社をよく見せる|採用サイトや案内メールに仕事内容/);
  }
});

test("missing or invalid references never trust a generated Need paraphrase", () => {
  const transcript = "顧客：仕事内容が伝わりにくいことが課題です。";
  for (const refs of [undefined, null, [], [0], ["1"], [2], { need: "原文にはない困りごと" }]) {
    const result = groundNeedEvidence(transcript, refs);
    assert.equal(result.value, BANT_UNKNOWN_VALUES.need);
    assert.equal(result.basis, "no_valid_source");
    assert.equal(isUnknownBantValue(result.value), true);
  }
});

test("one primary turn is kept with immutable requested order and all other references audited", () => {
  const transcript = "顧客：情報を揃えたいです。\n顧客：通常の働き方を伝えたいです。";
  const refs = [2, 1, 2];
  const result = groundNeedEvidence(transcript, refs);
  assert.equal(result.value, "文字起こし記載: 顧客：通常の働き方を伝えたいです。");
  assert.deepEqual(result.audit.accepted.map(entry => entry.sourceId), [2]);
  assert.deepEqual(result.audit.requestedSourceIds, [2, 1, 2]);
  assert.deepEqual(refs, [2, 1, 2]);
  assert.deepEqual(result.audit.rejected.map(entry => entry.reason), ["duplicate_source_id", "turn_limit_exceeded"]);
});

test("seller and question-only selections stay unknown and an unknown speaker is never relabelled as customer", () => {
  const transcript = "営業：説明不足が課題ですね。\n顧客：資料はありませんか？\n話者1：説明を統一したいです。";
  for (const id of [1, 2]) assert.equal(groundNeedEvidence(transcript, [id]).value, BANT_UNKNOWN_VALUES.need);
  const neutral = groundNeedEvidence(transcript, [3]);
  assert.equal(neutral.value, "文字起こし記載: 話者1：説明を統一したいです。");
  assert.equal(neutral.audit.accepted[0].sourceRole, "unspecified");
});

test("whole continuation and later qualifiers remain literal through existing BANT reconciliation", () => {
  const source = "顧客：選考途中の辞退が課題になっている可能性があります。\r\n  ただし数字は未集計です。";
  const transcript = `${source}\r\n営業：具体的に教えてください。\r\n顧客：面接前の説明を改善したいです。`;
  const result = groundNeedEvidence(transcript, [2]);
  assert.equal(result.value, `文字起こし記載: ${source}`);
  assert.deepEqual(result.audit.accepted[0].sourceIds, [1, 2]);
  const meeting = { id: "primary", meetingDate: "2026-09-24T00:00:00Z", sourceType: "manual_text", transcript, bantNeed: result.value };
  const evidence = findMeetingBantEvidence([meeting], "need");
  assert.equal(evidence?.value, result.value);
});

test("oversized whole turns are skipped and never truncated at a late qualifier", () => {
  const large = `顧客：${"あ".repeat(1200)}。ただし、以前の状況です。`;
  const small = "顧客：説明を統一したいです。";
  const result = groundNeedEvidence(`${large}\n${small}`, [1, 2]);
  assert.equal(result.value, `文字起こし記載: ${small}`);
  assert.equal(result.audit.rejected[0].reason, "source_character_budget_exceeded");
  assert.equal(groundNeedEvidence(large, [1]).value, BANT_UNKNOWN_VALUES.need);
});

test("source unknown and stage-only statements remain unknown before attribution or unrelated amounts", () => {
  for (const body of [
    "情報交換です。",
    "今回は情報収集段階です。",
    "応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。",
    "予算は150万円が目安です。応募数の不足は未集計のため分かりません。",
    "予算は150万円を目安にしたいです。応募数の不足は未集計のため分かりません。",
    "課題は未確認です。2027年9月に導入したいです。",
    "応募者40人が十分なのかは分かりません。",
    "課題は未確認です。導入するなら2027年9月を希望します。",
  ]) {
    const transcript = `顧客：${body}`;
    const result = groundNeedEvidence(transcript, [1]);
    assert.equal(result.value, BANT_UNKNOWN_VALUES.need, body);
    assert.equal(result.basis, "unknown_source", body);
    assert.equal(result.audit.accepted[0].sourceText, transcript);
    assert.equal(constrainBantStatus("need", result.value, "confirmed"), "unknown");
    assert.equal(isUnknownBantValue(result.value), true);
  }
});

test("concrete Need survives unrelated unknown budget, approval and timing context", () => {
  for (const body of [
    "予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。新卒採用の応募数不足という課題は引き続きあります。",
    "前回の80万円という予算と2027年4月の導入希望は撤回します。現在、予算と導入時期は未定です。新卒採用の応募数不足という課題は引き続きあります。",
    "説明内容が伝わりにくいです。予算は未確認です。",
    "普通の働き方も伝えたいです。動画の有無は分かりません。",
    "情報収集ツールを統一したいです。費用は未確認です。",
    "仮説検証の時間を減らしたいです。予算は未確認です。",
    "情報漏洩の可能性を下げたいです。導入時期は未定です。",
  ]) {
    const transcript = `顧客：${body}`;
    const result = groundNeedEvidence(transcript, [1]);
    assert.equal(result.value, `文字起こし記載: ${transcript}`, body);
    assert.equal(result.basis, "literal_source");
    assert.equal(isUnknownBantValue(result.value), false);
  }
});

test("explicitly denied shortages or problems do not establish a concrete Need", () => {
  for (const body of [
    "応募数は不足していません。課題は未確認です。",
    "現在の運用に問題はありません。課題は未確認です。",
  ]) {
    const result = groundNeedEvidence(`顧客：${body}`, [1]);
    assert.equal(result.value, BANT_UNKNOWN_VALUES.need, body);
    assert.equal(result.basis, "unknown_source");
    assert.equal(isUnknownBantValue(result.value), true);
  }
  for (const body of [
    "応募数は不足しています。予算は未確認です。",
    "現在の運用に問題はあります。決裁者は未確認です。",
  ]) {
    const transcript = `顧客：${body}`;
    const result = groundNeedEvidence(transcript, [1]);
    assert.equal(result.value, `文字起こし記載: ${transcript}`);
    assert.equal(result.basis, "literal_source");
  }
});

test("cost and implementation-time reduction wishes survive unrelated unknown BANT conditions", () => {
  for (const body of [
    "毎月の運用費用を減らしたいです。決裁者は未確認です。",
    "導入作業にかかる時間を減らしたいです。予算は未確認です。",
  ]) {
    const transcript = `顧客：${body}`;
    const result = groundNeedEvidence(transcript, [1]);
    assert.equal(result.value, `文字起こし記載: ${transcript}`);
    assert.equal(result.basis, "literal_source");
    assert.equal(isUnknownBantValue(result.value), false);
  }
  for (const body of [
    "予算は150万円を目安にしたいです。課題は未確認です。",
    "2027年9月に導入したいです。課題は未確認です。",
  ]) {
    assert.equal(groundNeedEvidence(`顧客：${body}`, [1]).value, BANT_UNKNOWN_VALUES.need);
  }
});
