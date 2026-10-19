import assert from "node:assert/strict";
import test from "node:test";
import { constrainActionOutcomes } from "../src/lib/ai/action-outcome";

const safeOutcome = "事例・資料の有無と内容、顧客への提供可否を判断するための確認結果が整理される。";
const action = "顧客の課題解決に役立つ具体的な事例や利用可能な資料の有無と内容を社内で確認し、次回の面談で顧客へ提示できるか検討する";
const outcome = "顧客の課題解決に役立つ具体的な事例やデータが提供できるようになり、提案の信頼性が向上する。これにより、顧客がサービス導入を検討する際の判断材料が増える。";
const entry = (actionText = action, expected = outcome) => ({
  action: actionText, expected_outcome: expected, reason: "利用できる事例は未確認であるため。", priority: "medium", impact: "medium",
});

test("v8 existence-check action cannot establish positive availability in its outcome", () => {
  const unchanged = entry("確認済みの見積書を送付する", "顧客が費用内訳を確認できる。");
  const input = { next_actions: [unchanged, entry()], source: "model" };
  const before = structuredClone(input);
  const result = constrainActionOutcomes(input);
  assert.equal(result.applied, true);
  assert.deepEqual(result.changedIndexes, [1]);
  assert.equal(result.value.next_actions[1].expected_outcome, safeOutcome);
  assert.doesNotMatch(result.value.next_actions[1].expected_outcome, /データ|信頼性が向上|判断材料が増える|これにより/);
  assert.equal(result.value.next_actions[1].action, action);
  assert.equal(result.value.next_actions[1].reason, input.next_actions[1].reason);
  assert.equal(result.value.next_actions[1].priority, "medium");
  assert.equal(result.value.next_actions[0], unchanged);
  assert.equal(result.value.source, "model");
  assert.deepEqual(input, before);
  const again = constrainActionOutcomes(result.value);
  assert.equal(again.value, result.value);
  assert.equal(again.applied, false);
});

test("explicit availability and existence checks cover direct presentation claims", () => {
  for (const actionText of [
    "資料の有無を社内で確認する。",
    "資料の利用可否を確認する。",
    "資料の提供可否を確認する。",
    "資料の存在を確認する。",
    "資料が存在するかどうか確認する。",
    "資料の有無を調べる。",
  ]) {
    for (const expected of ["資料を顧客へ提示できる。", "資料が提供できるようになる。", "資料を提供できます。", "資料は提示可能です。"]) {
      const result = constrainActionOutcomes({ next_actions: [entry(actionText, expected)] });
      assert.equal(result.applied, true, `${actionText} / ${expected}`);
      assert.equal(result.value.next_actions[0].expected_outcome, "資料の有無と内容、顧客への提供可否を判断するための確認結果が整理される。");
    }
  }
});

test("known materials, content checks and temporal checks are not existence checks", () => {
  for (const actionText of [
    "確認済みの事例資料を顧客に送付する。",
    "利用できる資料の内容を確認する。",
    "資料を提示する日時の候補の有無を確認する。",
    "資料の有無を確認する日時を調整する。",
    "資料の有無を確認した。既存資料を送付する。",
    "資料の有無を確認する予定はありません。",
    "資料の有無は確認しない。",
    "資料の有無を確認しますか？",
    "「資料の有無を確認する」という依頼の背景を聞く。",
    "事例の公開日と資料の提出期限を確認する。",
  ]) {
    const input = { next_actions: [entry(actionText, "資料が提供できるようになる。")] };
    assert.equal(constrainActionOutcomes(input).value, input, actionText);
  }
});

test("conditional outcomes keep their qualifications and do not become canned outcomes", () => {
  for (const expected of [
    "利用可能な資料が確認できた場合に、資料を提供できる。",
    "資料があれば、資料を提供できるようになる。",
    "提供が認められるなら、資料を顧客に提示できる。",
    "資料が提供できる場合に顧客へ説明する。",
    "資料が提供できると確認できれば、説明の候補となる。",
    "資料を提供できるか判断できる。",
    "資料を提供できるようになるか判断できる。",
    "資料を提供可能かどうかが分かる。",
    "資料を提示できるかもしれない。",
    "資料を提供できる範囲を判断できる。",
    "資料を提示できるものの有無が分かる。",
  ]) {
    const input = { next_actions: [entry(action, expected)] };
    assert.equal(constrainActionOutcomes(input).value, input, expected);
  }
});

test("negative, quoted and interrogative availability claims remain untouched", () => {
  for (const expected of [
    "資料を提供できない可能性も含め、可否を整理できる。",
    "資料が提供できるとは限らない。",
    "資料が提供可能ではないと分かる場合もある。",
    "資料が提供できるようになるとは断定できない。",
    "資料が提供できる根拠はまだない。",
    "資料が提供できるようにならない場合もある。",
    "資料を提示できるようにはなりません。",
    "「資料が提供できるようになる」という約束はしない。",
    "資料を提供できますか？",
  ]) {
    const input = { next_actions: [entry(action, expected)] };
    assert.equal(constrainActionOutcomes(input).value, input, expected);
  }
});

test("unrelated nouns, dates and ordinary decision outcomes cannot activate the guard", () => {
  for (const [actionText, expected] of [
    ["資料の有無を確認する。", "資料の提出日を提示できる。"],
    ["資料の有無を確認する。", "データが提供できる。"],
    ["撮影場所の有無を確認する。", "資料を提供できる。"],
    [action, "次回面談の日程の候補を提示できる。"],
    [action, "資料の有無と内容、提供可否を判断できる。"],
    [action, "判断材料が増える。"],
  ]) {
    const input = { next_actions: [entry(actionText, expected)] };
    assert.equal(constrainActionOutcomes(input).value, input, `${actionText} / ${expected}`);
  }
  const empty = { next_actions: [] };
  assert.equal(constrainActionOutcomes(empty).value, empty);
});
