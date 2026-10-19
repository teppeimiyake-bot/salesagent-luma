import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groundActionReasons, UNGROUNDED_ACTION_REASON } from "../src/lib/ai/action-reason-evidence";
import { timelineSourceTurns } from "../src/lib/ai/timeline-evidence";

const action = (reason: string, refs?: unknown) => ({
  action: "営業担当は既存の情報と確認が必要な事項を確認する。",
  priority: "high", impact: "medium", reason,
  expected_outcome: "利用できる情報と、さらに確認が必要な事項が分かる。",
  ...(refs === undefined ? {} : { reason_source_ids: refs }),
});

test("v11 historical-data overclaim becomes the complete source with its narrower comparison caveat", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const source = timelineSourceTurns(transcript)[5].text;
  const original = action("顧客は直近のデータしか確認しておらず、施策の良し悪しを判断する材料として過去データも必要と認識しているため、課題の傾向や変化を把握する手がかりを得られる可能性がある。", [6]);
  const candidates = { next_actions: [original], retained: "metadata" };
  const before = JSON.stringify(candidates);
  const result = groundActionReasons(transcript, candidates);
  assert.equal(result.value.next_actions[0].reason, `原文: ${source}`);
  assert.match(result.value.next_actions[0].reason, /以前の回との厳密な比較/);
  assert.doesNotMatch(result.value.next_actions[0].reason, /直近のデータしか確認/);
  assert.equal(result.value.retained, "metadata");
  assert.equal(JSON.stringify(candidates), before);
  for (const field of ["action", "priority", "impact", "expected_outcome"] as const) {
    assert.equal(result.value.next_actions[0][field], original[field]);
  }
  assert.equal(Object.hasOwn(result.value.next_actions[0], "reason_source_ids"), false);
  assert.equal(result.audit[0].requestedSourceIds, original.reason_source_ids);
});

test("v11 seller quote is displayed with its actual speaker and the customer's separate response", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const turns = timelineSourceTurns(transcript);
  const original = action("顧客は「採用サイトで説明できている部分と、職種別に補った方がよい部分を見比べられるとよさそう」と発言しており、提案に繋がるため。", [17, 16]);
  const result = groundActionReasons(transcript, { next_actions: [original] });
  assert.equal(result.value.next_actions[0].reason, `原文: ${turns[15].text}\n原文: ${turns[16].text}`);
  assert.deepEqual(result.audit[0].accepted.map(entry => entry.sourceRole), ["seller", "customer"]);
  assert.deepEqual(result.audit[0].requestedSourceIds, [17, 16]);
  assert.match(result.value.next_actions[0].reason, /原文: 営業：/);
  assert.match(result.value.next_actions[0].reason, /学生に会社をよく見せる/);
  assert.doesNotMatch(result.value.next_actions[0].reason, /顧客は「採用サイト/);
});

test("missing, empty or invalid source refs never publish the generated reason", () => {
  const transcript = "顧客：仕事内容の説明が伝わりにくいことが課題です。";
  for (const refs of [undefined, null, [], [0], [2], ["1"], [true], "1", { sourceId: 1 }]) {
    const candidates = { next_actions: [action("顧客が期限を約束したため。", refs)] };
    const result = groundActionReasons(transcript, candidates);
    assert.equal(result.value.next_actions[0].reason, UNGROUNDED_ACTION_REASON);
    assert.equal(Object.hasOwn(result.value.next_actions[0], "reason_source_ids"), false);
    assert.equal(candidates.next_actions[0].reason, "顧客が期限を約束したため。");
  }
});

test("seller questions and unknown speaker text remain literal without new attribution", () => {
  const transcript = "営業：資料はありますか？\n\n田中：資料の有無は分かりません。";
  const result = groundActionReasons(transcript, { next_actions: [action("資料がないため。", [1, 2])] });
  assert.equal(result.value.next_actions[0].reason, "原文: 営業：資料はありますか？\n原文: 田中：資料の有無は分かりません。");
  assert.deepEqual(result.audit[0].accepted.map(entry => entry.sourceRole), ["seller", "unspecified"]);
});

test("whole CRLF continuation stays with its labelled source and duplicate references are audited", () => {
  const source = "営業：150万円で提供できるか確認します。\r\n  ただし、資料の有無と対応できる範囲は未確認です。";
  const result = groundActionReasons(source, { next_actions: [action("必ず資料を提供できるため。", [2, 1, 2])] });
  assert.equal(result.value.next_actions[0].reason, `原文: ${source}`);
  assert.deepEqual(result.audit[0].accepted[0].sourceIds, [1, 2]);
  assert.deepEqual(result.audit[0].accepted[0].contextSourceIds, [1]);
  assert.equal(result.audit[0].accepted[0].sourceRole, "seller");
  assert.deepEqual(result.audit[0].rejected.map(entry => entry.reason), ["duplicate_source_turn", "duplicate_source_id"]);
});

test("mixed speakers, empty turns and invalid IDs are rejected independently of valid source blocks", () => {
  const transcript = "顧客：はい。話者2：必要です。\n営業：\n顧客：現場の撮影可否は未確認です。";
  const result = groundActionReasons(transcript, { next_actions: [action("撮影できるため。", [1, 2, -1, 0.5, 3])] });
  assert.equal(result.value.next_actions[0].reason, "原文: 顧客：現場の撮影可否は未確認です。");
  assert.deepEqual(result.audit[0].rejected.map(entry => entry.reason), ["ambiguous_speakers", "empty_turn", "invalid_source_id", "invalid_source_id"]);
});

test("two whole source blocks are capped per action and emitted in source chronology", () => {
  const transcript = "顧客：以前の条件です。\n顧客：現在の条件です。\n営業：補足です。";
  const candidates = { next_actions: [action("生成文", [2, 1, 3]), action("別の生成文", [3])] };
  const result = groundActionReasons(transcript, candidates);
  assert.deepEqual(result.audit[0].accepted.map(entry => entry.sourceId), [1, 2]);
  assert.equal(result.audit[0].rejected[0].reason, "turn_limit_exceeded");
  assert.deepEqual(result.audit[1].accepted.map(entry => entry.sourceId), [3]);
  assert.equal(result.value.next_actions[0].reason, "原文: 顧客：以前の条件です。\n原文: 顧客：現在の条件です。");
});

test("1200-character source budget skips complete oversized blocks without truncating caveats", () => {
  const large = `顧客：${"あ".repeat(1196)}。ただし、現時点では未確定です。`;
  const small = "営業：資料はありますか？";
  const result = groundActionReasons(`${large}\n${small}`, { next_actions: [action("生成文", [1, 2])] });
  assert.equal(result.value.next_actions[0].reason, `原文: ${small}`);
  assert.equal(result.audit[0].rejected[0].reason, "source_character_budget_exceeded");
  const medium = `顧客：${"あ".repeat(600)}`;
  const aggregate = groundActionReasons(`${medium}\n${medium}`, { next_actions: [action("生成文", [1, 2])] });
  assert.equal(aggregate.value.next_actions[0].reason, `原文: ${medium}`);
  assert.equal(aggregate.audit[0].rejected[0].reason, "source_character_budget_exceeded");
});

test("immutable provider objects and extra public fields survive projection without mutation", () => {
  const original = Object.freeze({ ...action("生成された理由", Object.freeze([1])), custom: Object.freeze({ marker: "unchanged" }) });
  const candidates = Object.freeze({ next_actions: [original] });
  const result = groundActionReasons("顧客：課題は未確認です。", candidates);
  assert.equal(result.value.next_actions[0].custom, original.custom);
  assert.equal(original.reason, "生成された理由");
  assert.deepEqual(original.reason_source_ids, [1]);
  assert.equal(result.applied, true);
});
