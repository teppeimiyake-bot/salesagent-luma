import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripRecommendationSourceReferences } from "../src/lib/ai/recommendation-source-references";

const transcript = "営業：課題を教えてください。\n\n顧客：説明が伝わりにくいです。\n顧客：運用負担を抑えたいです。\n営業：条件を確認します。";

test("observed v12 inline source ID is removed without changing the action or source wording", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const action = "顧客が「採用実務の中で続けられる形」を重視している点（id: 39）を踏まえ、提案する解決策の運用負担や更新頻度について、具体的な説明ができるよう準備する。";
  const original = { nextActions: { next_actions: [{ action, reason_source_ids: [39], expected_outcome: "運用負担を確認できる。" }] } };
  const before = structuredClone(original);
  const result = stripRecommendationSourceReferences(source, original);
  assert.equal(result.value.nextActions.next_actions[0].action, action.replace("（id: 39）", ""));
  assert.deepEqual(result.value.nextActions.next_actions[0].reason_source_ids, [39]);
  assert.equal(result.value.nextActions.next_actions[0].expected_outcome, original.nextActions.next_actions[0].expected_outcome);
  assert.deepEqual(result.changedPaths, ["nextActions.next_actions[0].action"]);
  assert.deepEqual(original, before);
  assert.equal(stripRecommendationSourceReferences(source, result.value).value, result.value);
});

test("observed v14 bare source numbers are removed only beside their exact matching quotations", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const quotes: Array<[number, string]> = [
    [15, "採用サイトと、説明会後に送る案内メールはあります。メールには応募手続きの案内を載せていますが、仕事内容を詳しく説明する文章はあまり入っていません"],
    [25, "現場を撮影できるかは未確認ですし、誰に出演してもらえるかも決まっていません"],
    [35, "費用にどこまで含めるかは、まだ細かく整理できていません。公開後に仕事内容が変わったとき、少し直したいだけなのに大きな費用がかかると困ります。税や交通費なども含め、見積を検討する際には内訳を知りたいです"],
    [37, "私は採用実務の担当で、今回の費用を最終決裁する人はまだ確認できていません。誰が最終決裁者か、正式な承認経路は未確認です"],
    [43, "次にお話しする面談は、2026年10月15日を候補として考えています。ただし、社内の予定を確認する前なので、まだ確定していません"],
  ];
  const original = Object.freeze({ next_actions: Object.freeze(quotes.map(([id, quote]) => Object.freeze({ action: `顧客が「${quote}」(${id})と述べた点を確認する。`, reason_source_ids: Object.freeze([id]) }))) });
  const before = JSON.stringify(original);
  const result = stripRecommendationSourceReferences(source, original);
  assert.deepEqual(result.value.next_actions.map(row => row.action), quotes.map(([, quote]) => `顧客が「${quote}」と述べた点を確認する。`));
  assert.equal(result.changedPaths.length, 5);
  assert.equal(JSON.stringify(original), before);
  assert.equal(stripRecommendationSourceReferences(source, result.value).value, result.value);
});

test("bare numeric references require quote correspondence, paired brackets and a real source block", () => {
  const quote = "説明が伝わりにくいです";
  for (const [opening, closing] of [["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]) {
    const text = `${opening}${quote}${closing} （２）を確認する。`;
    assert.equal(stripRecommendationSourceReferences(transcript, text).value, `${opening}${quote}${closing}を確認する。`);
  }
  for (const text of [
    `「${quote}」(1)を確認する。`, `「${quote}」(99)`, `「${quote}」(0)`, `「${quote}」(2、3)`,
    `「${quote}」(2）`, `「${quote}』(2)`, `「${quote}」\n(2)`, `「${quote}」という点(2)`,
    "「生成された別の発言」(2)", `${quote}(2)`, "説明(2)を確認する。", "日付（2026年10月15日）", "予算（150万円）",
    `「${quote}」(2)万円`, `「${quote}」(2)月`, `『引用「${quote}」(2)の記載』`,
  ]) assert.equal(stripRecommendationSourceReferences(transcript, text).value, text, text);
});

test("literal numeric business identifiers and original quoted source passages remain unchanged", () => {
  const quote = "説明が伝わりにくいです";
  const source = `${transcript}\n顧客：資料の版番号は（２）です。\n営業：「${quote}」(2)という記載を確認します。`;
  for (const text of [`「${quote}」(2)を確認する。`, `原文: 営業：「${quote}」(2)という記載を確認します。`, "版番号（２）を確認する。"])
    assert.equal(stripRecommendationSourceReferences(source, text).value, text);
  const continued = "顧客：社内で確認します。\r\n必要な資料はまだ分かりません。";
  assert.equal(stripRecommendationSourceReferences(continued, "「必要な資料はまだ分かりません」(2)と述べた。").value, "「必要な資料はまだ分かりません」と述べた。");
});

test("generated nested fields lose inline and trailing numeric ID markers while untouched branches keep identity", () => {
  const untouched = { priority: "high", expected_outcome: "条件を確認できる。" };
  const original = Object.freeze({
    topSales: Object.freeze({ real_intent: "説明不足 (id: 2)を解消したい。", risks: Object.freeze(["条件に合わない可能性（ids: 2、3）。"]) }),
    strategy: Object.freeze({ closing_plan: "1. 条件を確認する (id: 4)\n2. 説明を揃える（ID：２）。" }),
    nextActions: Object.freeze({ next_actions: Object.freeze([Object.freeze({ ...untouched, action: "原文（ｉｄ：２）を確認する。", reason: "条件の確認 (ids: 3, 2)", expected_outcome: "条件が分かる（ＩＤＳ：２，３）。" })]) }),
    untouched,
  });
  const before = JSON.stringify(original);
  const result = stripRecommendationSourceReferences(transcript, original);
  assert.equal(result.value.topSales.real_intent, "説明不足を解消したい。");
  assert.deepEqual(result.value.topSales.risks, ["条件に合わない可能性。"]);
  assert.equal(result.value.strategy.closing_plan, "1. 条件を確認する\n2. 説明を揃える。");
  assert.equal(result.value.nextActions.next_actions[0].action, "原文を確認する。");
  assert.equal(result.value.nextActions.next_actions[0].reason, "条件の確認");
  assert.equal(result.value.nextActions.next_actions[0].expected_outcome, "条件が分かる。");
  assert.equal(result.value.untouched, untouched);
  assert.equal(result.changedPaths.length, 6);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(result.skippedPaths, []);
});

test("literal source markers and business IDs survive case, width and equivalent-list variants", () => {
  const source = "顧客：製品（ＩＤ：４）を検討しています。\n顧客：候補 (ids: 2, 1) は未定です。\n営業：確認します。\n顧客：お願いします。";
  for (const text of [
    "製品（ＩＤ：４）を確認する。", "製品 (id: 4) を確認する。",
    "候補（IDS：１、２）を確認する。", "候補 (ids: 2, 1) は未定です。",
    `原文: ${source.split("\n")[0]}`,
  ]) {
    const original = { text };
    assert.equal(stripRecommendationSourceReferences(source, original).value, original, text);
  }
});

test("out-of-range, mixed-invalid and noncitation parentheses are never partially removed", () => {
  for (const text of [
    "条件 (id: 0)", "条件 (id: 5)", "条件 (ids: 2, 99)", "条件 (ids: 2, -1)",
    "条件 (id: 1.5)", "条件 (id: A39)", "条件 (id: 1234567890)", "条件（id: 2)",
    "顧客ID: 2", "製品（ID: ABC-39）", "面談（2026年10月15日候補）", "予算（150万円目安）",
    "条件（未承認）", "条件 [id: 2]", "条件 (id: 2を確認)",
  ]) {
    const original = { text };
    const result = stripRecommendationSourceReferences(transcript, original);
    assert.equal(result.value, original, text);
    assert.equal(result.applied, false, text);
  }
  assert.equal(stripRecommendationSourceReferences("", "条件 (id: 1)").value, "条件 (id: 1)");
});

test("a literal source ID list remains intact beside a generated single-ID citation", () => {
  const source = `${transcript}\n顧客：候補 (ids: 2, 3) は業務上の識別子です。`;
  const original = { text: "条件 (ids: 3, 2)を確認し、追加事項（id: 4）を尋ねる。" };
  assert.equal(stripRecommendationSourceReferences(source, original).value.text, "条件 (ids: 3, 2)を確認し、追加事項を尋ねる。");
});

test("getter and custom-object values are not executed or coerced", () => {
  const original = { text: "条件（id: 2）を確認する。", get sensitive(): string { throw new Error("getter executed"); } };
  const result = stripRecommendationSourceReferences(transcript, original);
  assert.equal(result.value.text, "条件を確認する。");
  assert.equal(Object.getOwnPropertyDescriptor(result.value, "sensitive")?.get, Object.getOwnPropertyDescriptor(original, "sensitive")?.get);
  const custom = new Date("2026-09-24T00:00:00Z");
  assert.equal(stripRecommendationSourceReferences(transcript, custom).value, custom);
});

test("deep, cyclic, broad and oversized branches stay intact with explicit skipped paths", () => {
  const cycle: { self?: unknown; text: string } = { text: "条件（id: 2）を確認する。" };
  cycle.self = cycle;
  const cyclic = stripRecommendationSourceReferences(transcript, cycle);
  assert.deepEqual(cyclic.skippedPaths, ["self"]);
  assert.equal(cyclic.value.text, "条件を確認する。");
  assert.equal(cycle.text, "条件（id: 2）を確認する。");
  let deep: unknown = "条件 (id: 2)";
  for (let index = 0; index < 30; index++) deep = { child: deep };
  const nested = stripRecommendationSourceReferences(transcript, deep);
  assert.equal(nested.value, deep);
  assert.equal(nested.skippedPaths.length, 1);
  const broad = Array.from({ length: 2_010 }, () => "原文を確認する。");
  assert.equal(stripRecommendationSourceReferences(transcript, broad).skippedPaths.length, 1);
  const oversized = `${"あ".repeat(100_001)} (id: 2)`;
  const large = stripRecommendationSourceReferences(transcript, { text: oversized });
  assert.equal(large.value.text, oversized);
  assert.deepEqual(large.skippedPaths, ["text"]);
});
