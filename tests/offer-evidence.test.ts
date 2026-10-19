import assert from "node:assert/strict";
import test from "node:test";
import { constrainOfferEvidence } from "../src/lib/ai/offer-evidence";

const transcript = "営業：現在の予算と導入希望時期を教えてください。\n顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。新卒採用の応募数不足という課題は引き続きあります。";
const safe = "各商材の提供範囲と見積を社内で確認し、顧客の目安予算に収まる場合に説明する。";
const safeReason = "各商材の提供範囲と見積が未確認のため、顧客の目安予算に収まるか確認が必要。";
const safeOutcome = "提供範囲と見積を確認できれば、顧客の目安予算に収まるか判断できる。";
const safeRisk = "各商材の提供範囲と見積が未確認のまま進めると、顧客の目安予算に収まらない可能性がある。";
const unsafe = "120万円の目安予算内で提供可能な採用動画やSNS運用代行サービスの内容を提案する。";
const fields = (text: string) => ({ topSales: { winning_scenario: text }, strategy: { strategy: "課題を確認する。" }, nextActions: { next_actions: [] } });

test("observed unquoted budget offering is corrected in both winning scenario and closing plan", () => {
  const original = { topSales: { winning_scenario: `応募数を確認する。${unsafe}` },
    strategy: { closing_plan: unsafe }, nextActions: { next_actions: [] },
    analysis: { bant: { need: "応募数不足", budget: "120万円目安・未承認" } } };
  const before = structuredClone(original);
  const result = constrainOfferEvidence(transcript, original);
  assert.equal(result.applied, true);
  assert.deepEqual(result.changedPaths, ["topSales.winning_scenario", "strategy.closing_plan"]);
  assert.equal(result.value.topSales.winning_scenario, `応募数を確認する。${safe}`);
  assert.equal(result.value.strategy.closing_plan, safe);
  assert.deepEqual(original, before, "raw provider values must remain unchanged");
  assert.equal(result.value.nextActions, original.nextActions);
  assert.equal(result.value.analysis, original.analysis);
  assert.equal(constrainOfferEvidence(transcript, result.value).value, result.value);
});

test("detected claims in reasons, outcomes and risks receive the same rule", () => {
  const original = { topSales: { risks: ["顧客の予算内で提供できるため、価格上の問題はない。", "導入するなら6月希望。"] },
    strategy: {}, nextActions: { next_actions: [{ action: "条件を確認する。", reason: unsafe, expected_outcome: "120万円でサービスを提供できると説明する。" }] },
    analysis: { risks: ["予算内で実現可能なので費用面の不安はない。"] } };
  const result = constrainOfferEvidence(transcript, original);
  assert.deepEqual(result.changedPaths, ["topSales.risks[0]", "nextActions.next_actions[0].reason", "nextActions.next_actions[0].expected_outcome", "analysis.risks[0]"]);
  assert.equal(result.value.topSales.risks[1], original.topSales.risks[1]);
  assert.equal(result.value.nextActions.next_actions[0].action, original.nextActions.next_actions[0].action);
  assert.equal(result.value.topSales.risks[0], safeRisk);
  assert.equal(result.value.nextActions.next_actions[0].reason, safeReason);
  assert.equal(result.value.nextActions.next_actions[0].expected_outcome, safeOutcome);
  assert.equal(result.value.analysis.risks[0], safeRisk);
});

test("v7 closing-plan replacement keeps step 2 and surrounding steps intact", () => {
  const lines = [
    "1. 顧客が述べた課題と説明方法の選択肢を整理する。",
    "2. 予算150万円の範囲内で実現可能な提案内容と、その費用の内訳を明確に提示する。",
    "3. 現場の撮影可否と承認経路を確認する。",
  ];
  const original = { ...fields("未確認"), strategy: { closing_plan: lines.join("\n") } };
  const result = constrainOfferEvidence("顧客：予算は150万円が目安です。", original);
  assert.equal(result.value.strategy.closing_plan, [lines[0], `2. ${safe}`, lines[2]].join("\n"));
  assert.deepEqual(result.changedPaths, ["strategy.closing_plan"]);
  assert.equal(original.strategy.closing_plan, lines.join("\n"));
});

test("v7 action and reason replacements express their different roles", () => {
  const original = { ...fields("未確認"), nextActions: { next_actions: [{ action: unsafe, reason: unsafe, expected_outcome: unsafe }] } };
  const result = constrainOfferEvidence(transcript, original);
  assert.deepEqual(result.value.nextActions.next_actions[0], { action: safe, reason: safeReason, expected_outcome: safeOutcome });
  assert.equal(constrainOfferEvidence(transcript, result.value).value, result.value);
});

test("decoded v6 structured closing-plan lines keep nested labels and use neutral field text", () => {
  const lines = [
    `1週目：行動：${unsafe}別の情報源も確認する。`,
    `手順2：理由：${unsafe}`,
    `段階3：期待成果：${unsafe}`,
    `  - 成果：${unsafe}`,
    `（4）リスク：${unsafe}`,
  ];
  const original = { ...fields("未確認"), strategy: { closing_plan: lines.join("\r\n") } };
  const result = constrainOfferEvidence(transcript, original);
  assert.equal(result.value.strategy.closing_plan, [
    `1週目：行動：${safe}別の情報源も確認する。`,
    `手順2：理由：${safeReason}`,
    `段階3：期待成果：${safeOutcome}`,
    `  - 成果：${safeOutcome}`,
    `（4）リスク：${safeRisk}`,
  ].join("\r\n"));
  assert.deepEqual(result.changedPaths, ["strategy.closing_plan"]);
  assert.equal(constrainOfferEvidence(transcript, result.value).value, result.value);
});

test("nested decoded labels govern every sentence on their line without repeating prefixes", () => {
  const safeBefore = "顧客が選択肢を比較するため。";
  const qualified = "120万円で提供可能か確認する。";
  const safeAfter = "担当者も確認する。";
  for (const [label, replacement] of [["理由", safeReason], ["期待成果", safeOutcome], ["リスク", safeRisk]]) {
    const prefix = `1週目：${label}：`;
    const lines = [
      `${prefix}${safeBefore}${unsafe}${safeAfter}`,
      "",
      `${prefix}${qualified}${unsafe}${unsafe}`,
    ];
    const original = { ...fields("未確認"), strategy: { closing_plan: lines.join("\r\n") } };
    const result = constrainOfferEvidence(transcript, original);
    assert.equal(result.value.strategy.closing_plan, [
      `${prefix}${safeBefore}${replacement}${safeAfter}`,
      "",
      `${prefix}${qualified}${replacement}${replacement}`,
    ].join("\r\n"), label);
    assert.deepEqual(result.changedPaths, ["strategy.closing_plan"]);
    assert.equal(original.strategy.closing_plan, lines.join("\r\n"));
    assert.equal(constrainOfferEvidence(transcript, result.value).value, result.value);
  }
});

test("decoded line roles reset at line boundaries and retain the enclosing path fallback", () => {
  const original = { ...fields("未確認"), nextActions: { next_actions: [{
    reason: [
      `理由：比較するため。${unsafe}`,
      `期待成果：選択肢を整理する。${unsafe}`,
      `リスク：確認事項が残る。${unsafe}`,
      `行動：資料を確認する。${unsafe}`,
      `補足事項を残す。${unsafe}`,
    ].join("\n"),
  }] } };
  const result = constrainOfferEvidence(transcript, original);
  assert.equal(result.value.nextActions.next_actions[0].reason, [
    `理由：比較するため。${safeReason}`,
    `期待成果：選択肢を整理する。${safeOutcome}`,
    `リスク：確認事項が残る。${safeRisk}`,
    `行動：資料を確認する。${safe}`,
    `補足事項を残す。${safeReason}`,
  ].join("\n"));
  assert.deepEqual(result.changedPaths, ["nextActions.next_actions[0].reason"]);
});

test("bounded presentation prefixes survive without treating decimal prices as numbering", () => {
  for (const prefix of ["　２． ", "3) ", "４、", "* ", "・", "2. 理由： ", "見出し：内容：", "クロージング計画：補足："]) {
    const original = fields(`${prefix}${unsafe}`);
    const expected = prefix.includes("理由") ? safeReason : safe;
    assert.equal(constrainOfferEvidence(transcript, original).value.topSales.winning_scenario, `${prefix}${expected}`, prefix);
  }
  assert.equal(constrainOfferEvidence(transcript, fields("1.2万円で採用動画を提供できる。")).value.topSales.winning_scenario, safe);
});

test("presentation prefixes preserve qualified claims and known priced offers", () => {
  const source = `${transcript}\n営業：120万円で採用動画とSNS運用代行を提供できます。`;
  for (const text of [
    "2. 行動：120万円で採用動画とSNS運用代行を提供できると説明する。",
    "手順2：内容：120万円の予算内で提供可能な採用動画やSNS運用代行の内容を説明する。",
    "理由：120万円で提供できるかどうかは未確認です。",
    "期待成果：120万円で提供可能なサービスの有無を確認できる。",
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(source, original).value, original, text);
  }
  assert.equal(constrainOfferEvidence(`${transcript}\n営業：120万円で別の商品を提供できます。`, fields(`2. 行動：${unsafe}`)).applied, true);
});

test("questions, conditional feasibility checks, unknowns and negatives remain unchanged", () => {
  for (const text of [
    "120万円で提供可能か確認する。",
    "120万円で提供できますか？",
    "予算内で提供可能なのかを社内で確認する。",
    "120万円で提供できるかどうかは未確認です。",
    "120万円で提供可能な範囲は未確認です。",
    "120万円で提供可能なサービスの有無を社内で確認する。",
    "120万円で提供できると確認できた場合に、顧客へ説明する。",
    "120万円で提供できるなら、顧客へ説明する。",
    "120万円で提供可能とは限らない。",
    "120万円で提供できると断定しない。",
    "資料の存在や、顧客の予算内で提供できる範囲を前提にしないため。",
    "予算が正式に承認されていないため、承認プロセスを理解し、必要な情報を提供することで、顧客の社内での承認を支援できる。",
    "120万円で提供できる内容を断定しない。",
    "120万円で提供できない。",
    "120万円で提供可能ではありません。",
    "120万円で提供できるかもしれないため、社内で確認する。",
    safe,
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(transcript, original).value, original, text);
  }
});

test("an unrelated confirmation or unknown cannot excuse the price assertion", () => {
  for (const text of [
    "予算承認は未確認だが、120万円で採用動画を提供できる。",
    "120万円で提供可能なサービスの内容を顧客に説明し、導入日は確認する。",
    "120万円なら採用動画を提供できる。",
    "120万円で採用動画を提供できるから提案する。",
    "120万円で提供可能かつ高品質なサービスを説明する。",
  ]) assert.equal(constrainOfferEvidence(transcript, fields(text)).applied, true, text);
});

test("actual seller provision statements survive polite-form and offer-order paraphrases", () => {
  const source = `${transcript}\n営業：120万円で採用動画とSNS運用代行を提供できます。`;
  for (const text of [
    "120万円で採用動画とSNS運用代行を提供できると説明する。",
    "120万円の予算内で提供可能な採用動画やSNS運用代行の内容を説明する。",
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(source, original).value, original, text);
  }
});

test("a quote for another price or offer cannot ground this offering", () => {
  for (const quote of [
    "営業：150万円で採用動画とSNS運用代行を提供できます。",
    "営業：120万円で採用動画を提供できます。",
    "営業：120万円で別の商品を提供できます。",
  ]) assert.equal(constrainOfferEvidence(`${transcript}\n${quote}`, fields(unsafe)).applied, true, quote);
  const source = `${transcript}\n営業：120万円で採用動画を提供できます。`;
  assert.equal(constrainOfferEvidence(source, fields("120万円で採用動画を提供できますが、予算内で提供可能なSNS運用代行も説明する。")).applied, true);
  assert.equal(constrainOfferEvidence(`${transcript}\n営業：120万円で提供できます。`, fields("120万円で提供できるSNS運用代行を説明する。")).applied, true);
});

test("seller questions, uncertainty, denial and conditions are not affirmative price evidence", () => {
  for (const quote of [
    "営業：120万円で採用動画とSNS運用代行を提供できますか？",
    "営業：120万円で採用動画とSNS運用代行を提供できるか確認します。",
    "営業：120万円で採用動画とSNS運用代行を提供可能とは断定できません。",
    "営業：120万円で採用動画とSNS運用代行を提供できません。",
    "営業：もし120万円で採用動画とSNS運用代行を提供できるなら提案します。",
    "顧客：120万円で採用動画とSNS運用代行を提供できます。",
    "営業：120万円で採用動画とSNS運用代行を提供できます。 顧客：本当ですか？",
  ]) assert.equal(constrainOfferEvidence(`${transcript}\n${quote}`, fields(unsafe)).applied, true, quote);
});

test("concrete Need alone and unlabeled or hypothetical budgets do not activate this bounded guard", () => {
  for (const source of [
    "顧客：新卒採用の応募数不足が課題です。",
    "予算は120万円目安です。",
    "営業：予算は120万円ですか？\n顧客：未確認です。",
    "顧客：もし予算が120万円なら検討します。",
  ]) {
    const original = fields(unsafe);
    assert.equal(constrainOfferEvidence(source, original).value, original, source);
  }
});

test("fullwidth amounts and renamed field paths are audited without changing unrelated content", () => {
  const original = fields("１２０万円で採用動画を提供可能です。");
  const result = constrainOfferEvidence("先方：予算は１２０万円が目安です。", original);
  assert.equal(result.applied, true);
  assert.deepEqual(result.changedPaths, ["topSales.winning_scenario"]);
  assert.equal(result.value.topSales.winning_scenario, safe);
});

test("v14 within-budget options and outcomes require a scoped quote before presentation", () => {
  const source = "顧客：現在の予算は150万円を仮の目安として社内で話しています。正式な予算承認はまだ取れていません。\n顧客：費用にどこまで含めるかは、まだ細かく整理できていません。見積を検討する際には内訳を知りたいです。";
  const reason = "顧客発言（原文）: 顧客：現在の予算は150万円を仮の目安として社内で話しています。正式な予算承認はまだ取れていません。";
  const original = {
    topSales: { winning_scenario: "1. 課題を整理する。\n2. 予算150万円（目安）の範囲内で、どのような解決策が実現可能か、複数の選択肢（動画制作、資料作成、説明会構成の見直しなど）を提示し、それぞれの費用内訳と期待される効果を説明する。\n3. 現場の撮影可否を確認する。" },
    strategy: { closing_plan: "3. 予算目安150万円の範囲内で、課題解決に資する具体的な選択肢（映像制作、資料作成、説明会構成見直し、SNS運用代行など）を複数提示し、それぞれの費用内訳と期待される効果を説明する。" },
    nextActions: { next_actions: [{ action: "見積もり項目を確認する。", reason,
      expected_outcome: "顧客が費用内訳について抱える懸念を解消し、目安予算150万円内でどのようなサービスが提供可能か、具体的なイメージを持ってもらうことができる。" }] },
    analysis: { bant: { budget: "150万円を仮の目安としているが、正式な予算承認はまだ取れていない。" } },
  };
  const before = structuredClone(original);
  const result = constrainOfferEvidence(source, original);
  assert.deepEqual(result.changedPaths, ["topSales.winning_scenario", "strategy.closing_plan", "nextActions.next_actions[0].expected_outcome"]);
  assert.equal(result.value.topSales.winning_scenario, `1. 課題を整理する。\n2. ${safe}\n3. 現場の撮影可否を確認する。`);
  assert.equal(result.value.strategy.closing_plan, `3. ${safe}`);
  assert.equal(result.value.nextActions.next_actions[0].expected_outcome, safeOutcome);
  assert.equal(result.value.nextActions.next_actions[0].reason, reason);
  assert.equal(result.value.analysis, original.analysis);
  assert.deepEqual(original, before);
  assert.equal(constrainOfferEvidence(source, result.value).value, result.value);
});

test("annotated budget questions and internally verified conditional explanations stay qualified", () => {
  const source = "顧客：予算は150万円を目安にしています。";
  for (const text of [
    "予算150万円（目安）の範囲内でどのような解決策が実現可能か、社内で見積と提供範囲を確認する。",
    "目安予算150万円内でどのようなサービスが提供可能か、まだ未確認です。",
    "目安予算150万円内で採用動画を提供可能か、顧客に質問する。",
    "目安予算150万円内で提供できるか社内で確認する。",
    "目安予算150万円内で採用動画を提供できると確認できた場合に、費用内訳を説明する。",
    "予算150万円（目安）の範囲内で採用動画を提供できる場合に、費用内訳を説明する。",
    "提供範囲と見積を社内で確認し、顧客の目安予算に収まる場合に、具体的な選択肢と費用内訳を説明する。",
    "顧客は「現在は150万円を仮の目安として社内で話しています。正式な予算承認はまだ取れていません」と述べている。",
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(source, original).value, original, text);
  }
});

test("new within-budget presentations preserve actual same-offer prices, never unrelated prices", () => {
  const customer = "顧客：予算は150万円を目安にしています。";
  const pricedSource = `${customer}\n営業：120万円で採用動画とSNS運用代行を提供できます。`;
  for (const text of [
    "予算150万円（目安）の範囲内で採用動画とSNS運用代行を提供できると説明する。",
    "目安予算150万円内で採用動画とSNS運用代行を提供できると説明する。",
    "予算目安150万円の範囲内で、選択肢（採用動画、SNS運用代行）を複数提示し、それぞれの費用内訳を説明する。",
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(pricedSource, original).value, original, text);
    assert.equal(constrainOfferEvidence(`${customer}\n営業：160万円で採用動画とSNS運用代行を提供できます。`, original).applied, true, text);
    assert.equal(constrainOfferEvidence(`${customer}\n営業：120万円で別の商品を提供できます。`, original).applied, true, text);
  }
});

test("v15 parenthesized budget claims are corrected without changing raw drafts or source conditions", () => {
  const source = "顧客：現在の予算目安は150万円です。正式な社内承認はまだ取れていません。";
  const winning = "その上で、現場の撮影可否や出演者の調整、承認経路の確認を顧客に促し、それらの情報が得られた段階で、予算（150万円）内で実現可能な具体的な提案（例：採用動画、よくある質問の文章化、説明会の構成変更など、動画以外の選択肢も含む）を複数提示する。";
  const closing = "4. 次回面談（2026年10月15日候補）にて、上記1,2のヒアリング結果を踏まえ、3で準備した具体的な案を提示し、顧客の予算（150万円）内で実現可能な範囲と、導入後の運用負担軽減策について議論する。";
  const actionStart = "次回面談（2026年10月15日候補）にて、顧客の社内確認状況と、学生からの質問内容の詳細をヒアリングする。";
  const actionEnd = "その後、準備した具体的な提案案を提示し、顧客の予算（150万円）内で実現可能な範囲と、導入後の運用負担軽減策について議論する。";
  const reason = `原文: ${source}`;
  const original = {
    topSales: { winning_scenario: `課題を確認する。${winning}運用についても検討する。` },
    strategy: { closing_plan: `3. 具体案を社内で検討する。\n${closing}\n5. 必要な情報をヒアリングする。` },
    nextActions: { next_actions: [{ action: actionStart + actionEnd, reason, expected_outcome: "課題と条件を整理する。" }] },
    analysis: { bant: { budget: "150万円（仮の目安、正式な社内承認は未了）" } },
  };
  const before = structuredClone(original);
  const result = constrainOfferEvidence(source, original);
  assert.deepEqual(result.changedPaths, ["topSales.winning_scenario", "strategy.closing_plan", "nextActions.next_actions[0].action"]);
  assert.equal(result.value.topSales.winning_scenario, `課題を確認する。${safe}運用についても検討する。`);
  assert.equal(result.value.strategy.closing_plan, `3. 具体案を社内で検討する。\n4. ${safe}\n5. 必要な情報をヒアリングする。`);
  assert.deepEqual(result.value.nextActions.next_actions[0], { action: actionStart + safe, reason, expected_outcome: "課題と条件を整理する。" });
  assert.equal(result.value.analysis, original.analysis);
  assert.deepEqual(original, before);
  assert.equal(constrainOfferEvidence(source, result.value).value, result.value);
});

test("paired amount parentheses preserve numeric values and same-offer price grounding", () => {
  const customer = "顧客：予算は150.5万円を目安にしています。";
  for (const amount of ["150.5万円", "1,505,000円", "１５０．５万円", "１，５０５，０００円"]) {
    for (const [opening, closing] of [["(", ")"], ["（", "）"]]) {
      const original = fields(`予算${opening}${amount}${closing}内で採用動画を提供できると説明する。`);
      assert.equal(constrainOfferEvidence(customer, original).value.topSales.winning_scenario, safe);
      assert.equal(constrainOfferEvidence(`${customer}\n営業：(1,200,000円)で採用動画を提供できます。`, original).value, original);
      assert.equal(constrainOfferEvidence(`${customer}\n営業：（１５０．６万円）で採用動画を提供できます。`, original).applied, true);
      assert.equal(constrainOfferEvidence(`${customer}\n営業：120万円で別の商品を提供できます。`, original).applied, true);
    }
  }
});

test("parenthesized questions, conditions and non-amount annotations stay unchanged", () => {
  const customer = "顧客：予算は150万円を目安にしています。";
  for (const text of [
    "予算（150万円）内で採用動画を提供可能か、社内で見積を確認する。",
    "予算(150万円)内で採用動画を提供できるかは未確認です。",
    "予算（150万円）内で採用動画を提供できると確認できた場合に、顧客に説明する。",
    "予算（150万円）内で提供可能なサービスの有無を社内で確認する。",
    "予算（未確認）内で実現可能な範囲を説明する。",
    "予算（目安は150万円）内で実現可能な範囲を説明する。",
    "予算（150万円は未承認）内で実現可能な範囲を説明する。",
    "顧客発言（原文）: 顧客：現在の予算目安は150万円です。正式な社内承認はまだ取れていません。",
  ]) {
    const original = fields(text);
    assert.equal(constrainOfferEvidence(customer, original).value, original, text);
  }
  for (const source of ["顧客：仕事内容の伝わりにくさが課題です。", "予算は150万円です。", "顧客：もし予算が150万円なら検討します。"]) {
    const original = fields("予算（150万円）内で採用動画を提供できると説明する。");
    assert.equal(constrainOfferEvidence(source, original).value, original, source);
  }
});
