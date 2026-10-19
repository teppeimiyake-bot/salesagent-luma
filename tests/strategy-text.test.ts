import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStrategyText } from "../src/lib/ai/strategy-text";

test("plain prose and existing numbered steps remain byte-for-byte unchanged", () => {
  for (const value of [
    "  顧客の課題と条件を確認する。\r\n未確認の内容は仮説として扱う。  ",
    "1. 費用感を整理する。\n2. 提供範囲と見積を確認する。\n3. 確認事項を共有する。",
    "[確認事項] 担当と期限を確認する。",
    '本文に {"action":"確認する"} と記載されている。',
    '"確認する。"',
    "null", "123", "true", "",
  ]) assert.equal(normalizeStrategyText(value), value);
});

test("observed v6 action objects retain actions, reasons, outcomes, risks and winning scenarios", () => {
  const plan = [
    {
      action: "顧客が社内で確認すべき事項を整理し、顧客に共有する。",
      reason: "顧客が社内での確認を進める上で必要な情報を明確にするため。",
      expected_outcome: "顧客が社内確認を進め、次回の面談までに具体的な情報が得られる。",
      risks: "顧客の社内確認に時間がかかり、情報が揃わない可能性。",
      winning_scenario: "顧客が確認事項を理解し、次回の面談で具体的な情報を提供できる。",
    },
    {
      action: "150万円の目安予算内で実現可能な複数の選択肢を検討する。",
      reason: "多様な選択肢を提示するため。",
      expected_outcome: "顧客が適した方法を選択できるようになる。",
      risks: "予算や運用体制に合致しない可能性。",
      winning_scenario: "自社の状況に合った解決策を見つける。",
    },
  ];
  const before = structuredClone(plan);
  const output = normalizeStrategyText(plan);
  for (const record of plan) for (const value of Object.values(record)) assert.ok(output.includes(value));
  for (const label of ["行動：", "理由：", "期待成果：", "リスク：", "勝ち筋："]) assert.ok(output.includes(label));
  assert.ok(output.includes("\n\n行動："), "action groups retain paragraph boundaries");
  assert.doesNotMatch(output, /action|expected_outcome|winning_scenario|[\[\]{}]|^\d+[.)]/mu);
  assert.equal(normalizeStrategyText(JSON.stringify(plan, null, 2)), output);
  assert.equal(normalizeStrategyText(output), output, "normalizing after guards does not add numbering");
  assert.deepEqual(plan, before);
});

test("week-keyed objects preserve source timing and flatten nested values without object coercion", () => {
  const output = normalizeStrategyText({
    week1: { action: "条件を確認する。", reason: "提案の前提を揃えるため。" },
    week2: { action: ["提供範囲を確認する。", "見積を作成する。"], risks: ["追加確認が必要になる可能性。"] },
  });
  assert.equal(output, "1週目：行動：条件を確認する。\n1週目：理由：提案の前提を揃えるため。\n2週目：行動：提供範囲を確認する。\n\n2週目：行動：見積を作成する。\n2週目：リスク：追加確認が必要になる可能性。");
  assert.doesNotMatch(output, /week|\[object Object\]|^\d+\./mu);
});

test("each risk array item and multiline continuation retain the parent labels and blank separators", () => {
  const plan = {
    week1: {
      risks: [
        "社内確認に時間がかかる可能性。費用の見通しは未確認。",
        "次回面談までに情報が揃わない可能性。\r\n \t\r\n追加確認が必要になる可能性。",
        "", null,
      ],
      reason: "顧客が選択肢を比較するため。\n条件を明確にするため。",
    },
  };
  const before = structuredClone(plan);
  const output = normalizeStrategyText(plan);
  assert.equal(output,
    "1週目：リスク：社内確認に時間がかかる可能性。費用の見通しは未確認。\n\n" +
    "1週目：リスク：次回面談までに情報が揃わない可能性。\r\n \t\r\n" +
    "1週目：リスク：追加確認が必要になる可能性。\n" +
    "1週目：理由：顧客が選択肢を比較するため。\n1週目：理由：条件を明確にするため。");
  assert.doesNotMatch(output, /^\d+\./mu);
  assert.equal(normalizeStrategyText(output), output);
  assert.deepEqual(plan, before);
});

test("JSON fences, nested encodings and camelCase field names produce the same prose", () => {
  const plan = { action: "資料の有無を確認する。", expectedOutcome: "資料の有無が分かる。" };
  const encoded = JSON.stringify(plan);
  const expected = normalizeStrategyText(plan);
  for (const variant of [encoded, JSON.stringify(encoded), JSON.stringify(JSON.stringify(encoded)), `\`\`\`json\n${encoded}\n\`\`\``, { details: encoded }]) {
    assert.equal(normalizeStrategyText(variant), typeof variant === "object"
      ? "詳細：行動：資料の有無を確認する。\n詳細：期待成果：資料の有無が分かる。" : expected);
  }
});

test("unknown schema keys do not leak while their values and meaningful headings survive", () => {
  const output = normalizeStrategyText({
    custom_internal_payload: { anotherKey: "元の情報を保持する。" },
    確認事項: "撮影可否は未確認。",
    "2026-10-15": "面談の候補日。",
    step_1: "候補日を確認する。",
    phase2: "条件が合えば提案する。",
  });
  assert.equal(output, "元の情報を保持する。\n確認事項：撮影可否は未確認。\n2026-10-15：面談の候補日。\n手順1：候補日を確認する。\n段階2：条件が合えば提案する。");
});

test("empty containers and primitive values have stable display text", () => {
  for (const empty of [undefined, null, {}, [], { action: null }, "{}", "[]"]) assert.equal(normalizeStrategyText(empty), "");
  assert.equal(normalizeStrategyText([0, false, 150]), "0\n\nfalse\n\n150");
});

test("invalid JSON, expressions, scalar JSON and excessive encoding are not guessed or executed", () => {
  const unsafeInputs = [
    '[{"action": "確認する。",}]',
    '[{"action": "確認する。"}, {\n確認したうえで説明する。", "reason":"理由。"}]',
    '[{"action": (() => { throw new Error("executed"); })()}]',
    '({action: "確認する。"})',
    '{"action":"確認する。"} trailing text',
    '```json\n{"action":"確認する。"\n```',
    JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ action: "確認する。" })))),
    JSON.stringify({ action: "あ".repeat(100_001) }),
  ];
  for (const value of unsafeInputs) assert.equal(normalizeStrategyText(value), value);
});

test("prototype keys remain inert and getters, coercion methods and cycles are not executed", () => {
  const malicious = JSON.parse('{"__proto__":{"strategyTextPolluted":"文字列として保持。"},"constructor":{"prototype":{"polluted":"追加内容。"}},"action":"確認する。"}');
  assert.equal(normalizeStrategyText(malicious), "文字列として保持。\n追加内容。\n行動：確認する。");
  assert.equal(Object.hasOwn(Object.prototype, "strategyTextPolluted"), false);
  const object = { action: "確認する。", get reason(): string { throw new Error("getter executed"); } };
  assert.match(normalizeStrategyText(object), /^行動：確認する。\n理由：内容を読み取れませんでした。$/u);
  assert.equal(normalizeStrategyText({ toString() { throw new Error("toString executed"); }, toJSON() { throw new Error("toJSON executed"); } }), "内容を読み取れませんでした。\n内容を読み取れませんでした。");
  const cyclic: { action: string; risks?: unknown } = { action: "確認する。" };
  cyclic.risks = cyclic;
  assert.equal(normalizeStrategyText(cyclic), "行動：確認する。\nリスク：内容を読み取れませんでした。");
  assert.equal(normalizeStrategyText([object, object]).split("行動：").length, 3, "shared references are not cycles");
});

test("traversal limits signal unreadable content instead of crashing or silently truncating", () => {
  let nested: unknown = "確認する。";
  for (let i = 0; i < 50; i++) nested = { details: nested };
  assert.match(normalizeStrategyText(nested), /内容を読み取れませんでした。$/u);
  const broad = Array.from({ length: 2_100 }, () => "確認する。");
  const output = normalizeStrategyText(broad);
  assert.match(output, /内容を読み取れませんでした。$/u);
  assert.ok(output.length < 20_000);
});
