import assert from "node:assert/strict";
import test from "node:test";
import { findBantWithdrawal } from "../src/lib/ai/bant-withdrawal";
import { BANT_UNKNOWN_VALUES } from "../src/lib/ai/bant-definitions";
import { findMeetingBantEvidence, reconcileBantFromMeetings } from "../src/lib/ai/bant-reconciliation";
import { groundTimeline } from "../src/lib/ai/timeline-evidence";

const withdrawal = "顧客：前回の80万円という予算と2027年4月の導入希望は撤回します。\n顧客：現在、予算と導入時期は未定です。";
const old = { id: "old", meetingDate: "2026-09-21T01:00:00Z", transcript: "顧客：予算は80万円目安。導入は2027年4月希望です。", bantBudget: "80万円目安", bantTimeline: "2027年4月希望" };
const latest = { id: "latest", meetingDate: "2026-09-23T01:00:00Z", transcript: withdrawal, bantBudget: "未確認", bantTimeline: "未確認" };

test("explicit withdrawal has an unknown current value and the literal full customer context", () => {
  for (const original of [withdrawal, withdrawal.replaceAll("\n", "\r\n"), withdrawal.replace("\n顧客：", "")]) {
    for (const key of ["budget", "timeline"] as const) {
      const found = findBantWithdrawal(original, key);
      assert.equal(found?.value, BANT_UNKNOWN_VALUES[key]);
      assert.equal(found?.quote, original);
    }
  }
  assert.equal(findBantWithdrawal(withdrawal, "need"), null);
  const grounded = groundTimeline(withdrawal, [1]);
  assert.equal(grounded.value, BANT_UNKNOWN_VALUES.timeline);
  assert.equal(grounded.withdrawal?.quote, withdrawal);
  assert.deepEqual(grounded.sourceIds, []);
});

test("sales suggestions, questions, negatives, hypotheses and generated summaries do not withdraw evidence", () => {
  for (const original of [
    "営業：予算は撤回します。現在予算は未定です。",
    "顧客：予算を撤回しますか？現在予算は未定です。",
    "顧客：予算は撤回しません。現在予算は未定です。",
    "顧客：もし予算を撤回するなら、再検討します。現在予算は未定です。",
    "顧客：予算は撤回するかもしれません。現在予算は未定です。",
    "予算は撤回します。現在予算は未定です。",
    "営業：予算を撤回しますか？ 顧客：まだ決めていません。",
    "顧客：予算を撤回します。山田：現在予算は未定です。",
  ]) assert.equal(findBantWithdrawal(original, "budget"), null, original);
  const source = { ...latest, transcript: "顧客：本日は挨拶だけです。", minutes: withdrawal, minutesJson: { summary: withdrawal }, sourceType: "manual_text" };
  assert.equal(findMeetingBantEvidence([source, old], "budget")?.source_meeting_id, "old");
});

test("field-specific withdrawal does not reset a different field", () => {
  const budgetOnly = "顧客：前回の予算は撤回します。現在予算は未定です。導入は2027年4月希望です。";
  assert.ok(findBantWithdrawal(budgetOnly, "budget"));
  assert.equal(findBantWithdrawal(budgetOnly, "timeline"), null);
  const timelineOnly = "顧客：導入希望は撤回します。現在導入時期は未定です。予算は80万円目安です。";
  assert.ok(findBantWithdrawal(timelineOnly, "timeline"));
  assert.equal(findBantWithdrawal(timelineOnly, "budget"), null);
});

test("replacement terms after withdrawal within or across customer turns end the unknown event", () => {
  const replacement = "顧客：新たな予算は120万円を目安に検討しています。導入するなら2027年6月希望です。";
  for (const separator of ["\n", "\n営業：最新の条件を教えてください。\n"]) {
    for (const key of ["budget", "timeline"] as const) assert.equal(findBantWithdrawal(withdrawal + separator + replacement, key), null);
  }
});

test("a hypothetical mention after a withdrawal is not a new concrete replacement", () => {
  const source = withdrawal + "\n顧客：もし予算80万円を撤回するならという話です。";
  assert.equal(findBantWithdrawal(source, "budget")?.value, BANT_UNKNOWN_VALUES.budget);
});

test("later negated figures and hypothetical resources cannot reopen withdrawn conditions", () => {
  for (const [key, followup] of [
    ["budget", "予算80万円ではありません。"],
    ["budget", "予算80万円の確保はできません。"],
    ["budget", "もし予算120万円を確保できれば進めたいです。"],
    ["budget", "予算120万円を確保できる可能性があります。"],
    ["budget", "予算120万円があれば進めたいです。"],
    ["timeline", "導入は2027年4月ではありません。"],
    ["timeline", "導入は2027年6月になるかもしれません。"],
  ] as const) {
    for (const separator of ["\n", "\n営業：条件を再確認します。\n"]) {
      const source = `${withdrawal}${separator}顧客：${followup}`;
      assert.equal(findBantWithdrawal(source, key)?.value, BANT_UNKNOWN_VALUES[key], source);
    }
  }
});

test("the withdrawal and unknown predicates must target the field rather than a related person", () => {
  const source = "顧客：導入時期は変更しませんが、予算80万円は撤回します。導入時期の社内承認者は未確認です。現在の予算は未定です。";
  assert.equal(findBantWithdrawal(source, "timeline"), null);
  assert.equal(findBantWithdrawal(source, "budget")?.value, BANT_UNKNOWN_VALUES.budget);
  assert.equal(findBantWithdrawal("顧客：予算の決裁者の依頼は撤回します。現在予算は未定です。", "budget"), null);
  assert.equal(findBantWithdrawal("顧客：導入時期の確認依頼は撤回します。現在導入時期は未定です。", "timeline"), null);
  assert.equal(findBantWithdrawal("顧客：予算80万円は撤回します。予算の決裁者は未確認です。", "budget"), null);
  assert.equal(findBantWithdrawal("顧客：導入希望は撤回します。導入時期の社内承認者は未確認です。", "timeline"), null);
});

test("later numbers for approval meetings or other fields do not act as replacement terms", () => {
  const source = `${withdrawal}\n顧客：導入時期の承認会議は2027年6月予定です。予算の決裁者は2027年6月に決定予定です。`;
  assert.equal(findBantWithdrawal(source, "budget")?.value, BANT_UNKNOWN_VALUES.budget);
  assert.equal(findBantWithdrawal(source, "timeline")?.value, BANT_UNKNOWN_VALUES.timeline);
});

test("direct newer provisional amounts and conditional hopes still reopen their own field", () => {
  for (const [key, followup] of [
    ["budget", "新たな予算は120万円を目安に検討しています。"],
    ["budget", "予算は120万円です。"],
    ["timeline", "導入するなら2027年6月希望です。"],
    ["timeline", "導入時期は2027年6月を希望します。"],
    ["timeline", "2027年6月の導入を希望します。"],
  ] as const) {
    const source = `${withdrawal}\n顧客：${followup}`;
    assert.equal(findBantWithdrawal(source, key), null, source);
    const other = key === "budget" ? "timeline" : "budget";
    assert.equal(findBantWithdrawal(source, other)?.value, BANT_UNKNOWN_VALUES[other], source);
  }
});

test("comma-separated withdrawal then current uncertainty retains the same literal source", () => {
  for (const source of [
    "顧客：予算80万円を撤回し、現在の予算は未定です。",
    "顧客：予算80万円を撤回します、現在の予算は未定です。",
  ]) {
    assert.equal(findBantWithdrawal(source, "budget")?.quote, source);
  }
});

test("a withdrawal and uncertainty separated by a blank line or another speaker do not form one update", () => {
  for (const separator of ["\n\n", "\n営業：現在の条件はどうですか？\n", "\n先方：別件を話します。\n"]) {
    assert.equal(findBantWithdrawal(`顧客：予算80万円は撤回します。${separator}顧客：現在の予算は未定です。`, "budget"), null);
  }
});

test("later no-mention meetings cannot cross the withdrawal barrier to revive older values", () => {
  const noMention = { ...latest, id: "later", meetingDate: "2026-09-24T01:00:00Z", transcript: "顧客：本日は挨拶だけです。" };
  const source = Object.freeze([old, noMention, latest]);
  for (const key of ["budget", "timeline"] as const) {
    const result = findMeetingBantEvidence(source, key);
    assert.equal(result?.status, "unknown");
    assert.equal(result?.source_meeting_id, "latest");
    assert.equal(reconcileBantFromMeetings({ [key]: "旧条件", summary: "旧条件" }, source)[key], BANT_UNKNOWN_VALUES[key]);
  }
  assert.deepEqual(source.map((m) => m.id), ["old", "later", "latest"]);
});

test("withdrawal checks the complete primary source beyond the prompt excerpt", () => {
  const source = "営業：" + "導入のお話です。".repeat(150) + "\n" + withdrawal;
  assert.ok(source.indexOf("撤回") > 800);
  assert.equal(findBantWithdrawal(source, "timeline")?.quote, withdrawal);
});

test("a read preserves manual values, items and summary and creates no new proposal", () => {
  const item = { value: "手動80万円", quote: "手動の補足", status: "confirmed" };
  const saved = Object.freeze({ budget: item.value, items: Object.freeze({ budget: item }), manualFields: { budget: true }, updatedBy: "manual", summary: "手動サマリー" });
  const result = reconcileBantFromMeetings(saved, [latest, old]);
  assert.equal(result.budget, saved.budget);
  assert.equal((result.items as { budget: unknown }).budget, item);
  assert.equal(result.summary, saved.summary);
  assert.equal(result.aiSuggestion, undefined);
});
