import assert from "node:assert/strict";
import test from "node:test";
import { countBantCardStatuses, resolveBantCardView, type BantStatus, type BantValue } from "../src/components/deals/bant-summary-utils";

const bantKeys = ["budget", "authority", "need", "timeline"] as const;

test("confirmation counts follow displayed statuses, including the manual override, without changing stored confidence", () => {
  const input: BantValue = Object.freeze({
    confidence: 0,
    budget: "120万円目安・未承認",
    authority: "未確定: 決裁者を確認する必要あり",
    need: "新卒採用の応募数不足",
    timeline: "2027年6月",
    manualFields: Object.freeze({ timeline: true }),
    items: Object.freeze({
      budget: Object.freeze({ status: "estimated" as const }),
      authority: Object.freeze({ status: "unknown" as const }),
      need: Object.freeze({ status: "confirmed" as const }),
      timeline: Object.freeze({ status: "confirmed" as const }),
    }),
  });
  const before = JSON.stringify(input);
  const cards = bantKeys.map((key) => Object.freeze(resolveBantCardView(input, key)));
  assert.deepEqual(countBantCardStatuses(cards), { confirmed: 1, estimated: 1, unknown: 1, unreviewed: 1 });
  assert.equal(cards[3].status, "unreviewed");
  assert.equal(JSON.stringify(input), before);
  assert.equal(input.confidence, 0);
});

test("confirmation counts treat unknown manual entries as unknown and do not infer certainty from legacy percentage", () => {
  const input: BantValue = {
    confidence: 100,
    budget: "未定",
    authority: "未確認",
    need: "",
    timeline: "未確定: 日程を確認する必要あり",
    manualFields: { timeline: true },
    items: { timeline: { status: "confirmed" } },
  };
  assert.deepEqual(countBantCardStatuses(bantKeys.map((key) => resolveBantCardView(input, key))), {
    confirmed: 0, estimated: 0, unknown: 4, unreviewed: 0,
  });
  assert.equal(input.confidence, 100);
});

test("manual text has no reviewed certainty, including historically auto-confirmed fields", () => {
  for (const value of [
    "80万円",
    "予算80万円を想定。社内承認はまだ取れていない。",
    "予算80万円で確定した。",
    "予算80万円。\n決裁会議で確認する。\n追加費用は別途相談。",
  ]) {
    for (const status of [undefined, "confirmed", "estimated", "unknown"] as const) {
      const card = resolveBantCardView({
        budget: value,
        manualFields: { budget: true },
        items: { budget: { value, status } },
      }, "budget");
      assert.equal(card.value, value);
      assert.equal(card.status, "unreviewed");
      assert.equal(card.isManual, true);
    }
  }
});

test("manual empty or unknown placeholders remain unknown rather than confirmed", () => {
  for (const value of ["", "未定", "未確認", "未確定：日程を確認する必要あり"]) {
    const card = resolveBantCardView({
      timeline: value,
      manualFields: { timeline: true },
      items: { timeline: { value, status: "confirmed" } },
    }, "timeline");
    assert.equal(card.value, value);
    assert.equal(card.status, "unknown");
    assert.equal(card.isManual, true);
  }
});

test("nonmanual certainty and evidence are retained even when another field was edited", () => {
  const meetings = [{ id: "source", title: "予算確認", meetingDate: "2026-09-22T00:00:00Z" }];
  for (const status of ["confirmed", "estimated", "unknown"] as BantStatus[]) {
    const card = resolveBantCardView({
      budget: "80万円",
      updatedBy: "manual",
      manualFields: { need: true },
      items: { budget: { value: "80万円", status, source_meeting_id: "source", quote: "予算は80万円です" } },
    }, "budget", meetings);
    assert.equal(card.status, status);
    assert.equal(card.isManual, false);
    assert.equal(card.source?.href, "#meeting-source");
    assert.equal(card.source?.quote, "予算は80万円です");
  }
});

test("nonmanual values without a status remain estimated, with no inference from prose", () => {
  const value = "予算80万円で確定した。\n追加施策の日程は未定。";
  const card = resolveBantCardView({ budget: value }, "budget");
  assert.equal(card.value, value);
  assert.equal(card.status, "estimated");
});

test("past uncertainty in prose does not override current reviewed certainty", () => {
  const value = "未定だったが、9月15日で合意した。";
  assert.equal(resolveBantCardView({
    timeline: value,
    items: { timeline: { value, status: "confirmed" } },
  }, "timeline").status, "confirmed");
  assert.equal(resolveBantCardView({
    timeline: value,
    manualFields: { timeline: true },
  }, "timeline").status, "unreviewed");
});

test("a proposal identical to the displayed manual value is not shown as a new change", () => {
  const input = {
    budget: "80万円\n正式承認待ち。\n",
    manualFields: { budget: true },
    aiSuggestion: { budget: { value: " 80万円\n正式承認待ち。 " } },
  };
  assert.equal(resolveBantCardView(input, "budget").aiSuggestion, "");
  assert.equal(input.budget, "80万円\n正式承認待ち。\n");
  input.aiSuggestion.budget.value = "80万円で正式承認済み。";
  assert.equal(resolveBantCardView(input, "budget").aiSuggestion, "80万円で正式承認済み。");
});
