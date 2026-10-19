import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { customerAdoptionConditions, retainAdoptionConditions, constrainUnagreedSubmissionDeadline } from "../src/lib/ai/customer-conditions";

test("an explicitly unagreed submission deadline cannot become next-meeting preparation deadlines", () => {
  const source="顧客：次回面談の日程も、資料の提出期限も未合意です。";
  const value={strategy:{closing_plan:"1. 次回面談までに、具体案を複数検討する。\n2. 日程候補を確認する。"},nextActions:{next_actions:[{action:"次回の商談の前に資料を整理する",reason:"次回面談に向けて確認する",expected_outcome:"期限は未定。"}]}};
  const original=structuredClone(value);
  const result=constrainUnagreedSubmissionDeadline(source,value);
  assert.equal(result.applied,true);
  assert.equal(result.value.strategy.closing_plan,"1. 期限を確認したうえで、具体案を複数検討する。\n2. 日程候補を確認する。");
  assert.equal(result.value.nextActions.next_actions[0].action,"期限を確認したうえで、資料を整理する");
  assert.equal(result.value.nextActions.next_actions[0].reason,value.nextActions.next_actions[0].reason);
  assert.deepEqual(value,original);
  assert.equal(constrainUnagreedSubmissionDeadline(source,result.value).applied,false);
  for(const text of ["",source.replace("顧客","営業"),source+"\n顧客：資料は次回面談までに送ってください。",source.replace("未合意です","未合意ですか？"),source.replace("次回面談", "他社の次回面談")]){
    assert.equal(constrainUnagreedSubmissionDeadline(text,value).value,value);
  }
  const reported={text:"次回面談までに資料を送るとは合意していません。"};
  assert.equal(constrainUnagreedSubmissionDeadline(source,reported).value,reported);
});

test("unagreed deadline repair keeps risk and outcome predicates readable", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  const value = { risks: ["確認に時間がかかり、次回面談までに情報が揃わない可能性。"], nextActions: [{
    action: "次回面談までに資料を確認する。", reason: "次回面談までに情報を整理するため。",
    expected_outcome: "顧客が確認を進め、次回面談までに具体的な情報が得られる。",
  }], closing_plan: "リスク：確認に時間がかかり、次回面談までに情報が揃わない可能性。\n行動：次回面談までに資料を確認する。" };
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.value.risks[0], "確認に時間がかかり、情報が揃わない可能性。");
  assert.equal(result.value.nextActions[0].expected_outcome, "顧客が確認を進め、具体的な情報が得られる。");
  assert.equal(result.value.nextActions[0].reason, "情報を整理するため。");
  assert.equal(result.value.nextActions[0].action, "期限を確認したうえで、資料を確認する。");
  assert.equal(result.value.closing_plan, "リスク：確認に時間がかかり、情報が揃わない可能性。\n行動：期限を確認したうえで、資料を確認する。");
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
  assert.ok(value.risks[0].includes("次回面談までに"));
});

test("quoted item names do not shield an unquoted mid-sentence deadline from the screenshot", () => {
  const source = "顧客：本日は発注やサービス導入には合意していません。次回面談の日程も、資料の提出期限も未合意です。";
  const action = "顧客が社内確認を進める上で必要となる、「現場の撮影可否」「出演者の調整」「最終決裁者と承認経路の特定」について、確認すべき事項を整理した質問案を作成し、次回の面談までに顧客へ共有する。";
  const value = { next_actions: [{ action, reason: "「未合意事項」を確認し、次回の面談までに条件を整理するため。", expected_outcome: "「撮影可否」が明確になり、次回面談までに判断材料が得られる。" }] };
  const original = structuredClone(value);
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.applied, true);
  assert.equal(result.value.next_actions[0].action, action.replace("次回の面談までに", "期限を確認したうえで、"));
  assert.equal(result.value.next_actions[0].reason, "「未合意事項」を確認し、条件を整理するため。");
  assert.equal(result.value.next_actions[0].expected_outcome, "「撮影可否」が明確になり、判断材料が得られる。");
  assert.deepEqual(value, original);
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
});

test("v13 anaphoric deadline follows an explicit next-meeting candidate on the same line only", () => {
  const source = "顧客：次回面談の日程も、資料の提出期限も未合意です。";
  const line = "6. **次回の面談設定:** 顧客の社内調整状況を確認しつつ、次回の面談候補日である2026年10月15日を確定させ、その面談までに顧客が社内で確認できる事項を整理し、必要な情報提供を行う。";
  const value = { winning_scenario: line };
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.value.winning_scenario, line.replace("その面談までに", "期限を確認したうえで、"));
  assert.equal(value.winning_scenario, line);
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
  for (const [antecedent, alias] of [
    ["次回面談候補日である10月15日", "当該面談までに"],
    ["次回の商談候補日", "その商談の前に"],
    ["次回打ち合わせ（10月15日候補）", "当該打ち合わせ前に"],
    ["次回面談（候補日調整中）", "その面談までに"],
  ]) {
    const value = { action: `${antecedent}を確認する。${alias}「確認事項」を共有する。`, expected_outcome: `${antecedent}を確認し、${alias}判断材料が得られる。` };
    const result = constrainUnagreedSubmissionDeadline(source, value);
    assert.equal(result.value.action, `${antecedent}を確認する。期限を確認したうえで、「確認事項」を共有する。`);
    assert.equal(result.value.expected_outcome, `${antecedent}を確認し、判断材料が得られる。`);
  }
});

test("v14 presentation preparation does not set the unagreed next meeting as its deadline", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const actions = [
    "顧客が「現場を撮影できるかは未確認ですし、誰に出演してもらえるかも決まっていません」(25)と述べた、現場撮影の可否と出演者の調整について、顧客が社内で確認を進めるために必要な情報（撮影内容の具体例、調整の進め方、想定される撮影期間など）を整理し、次回面談時に提示できるよう資料を準備する",
    "顧客が「私は採用実務の担当で、今回の費用を最終決裁する人はまだ確認できていません。誰が最終決裁者か、正式な承認経路は未確認です」(37)と述べた最終決裁者と承認経路について、顧客が社内で確認を進めるための質問項目（確認すべき部署、役職、承認に必要な情報など）を作成し、次回面談時に提示できるよう準備する",
  ];
  const value = { next_actions: actions.map(action => ({ action, reason: "原文: 顧客：資料の提出期限は未合意です。", expected_outcome: "判断材料を整理できる。" })) };
  const before = structuredClone(value);
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.applied, true);
  for (let index = 0; index < actions.length; index++) {
    assert.equal(result.value.next_actions[index].action, actions[index].replace("次回面談時に", "期限を確認したうえで、"));
    assert.equal(result.value.next_actions[index].reason, value.next_actions[index].reason);
    assert.equal(result.value.next_actions[index].expected_outcome, value.next_actions[index].expected_outcome);
  }
  assert.deepEqual(value, before);
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
  for (const action of [
    "次回面談時に顧客の検討状況を確認する。",
    "前回面談時に提示できるよう資料を準備した。",
    "別の面談時に提示できるよう資料を準備する。",
    "次回面談の日程が確定したら、次回面談時に提示できるよう資料を準備する。",
    "「次回面談時に提示できるよう資料を準備する」との記載を確認する。",
    "原文: 営業：次回面談時に提示できるよう資料を準備する。",
    "次回面談時に提示できるよう準備するかは未定。",
  ]) {
    const candidate = { action };
    assert.equal(constrainUnagreedSubmissionDeadline(source, candidate).value, candidate, action);
  }
  for (const transcript of [
    "顧客：次回面談の日程は未合意です。",
    "営業：次回面談の日程も、資料の提出期限も未合意です。",
    `${source}\n顧客：次回面談時に資料を提示してください。`,
  ]) assert.equal(constrainUnagreedSubmissionDeadline(transcript, value).value, value);
});

test("v14 internal availability check leads to mutual scheduling rather than unilateral confirmation", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const action = "顧客が「次にお話しする面談は、2026年10月15日を候補として考えています。ただし、社内の予定を確認する前なので、まだ確定していません」(43)と述べた次回面談の候補日である2026年10月15日について、社内スケジュールを確認し、顧客へ確定の連絡を行う";
  const value = { action, reason: "原文: 顧客：次回面談の日程も、資料の提出期限も未合意です。", expected_outcome: "次回面談の日程を確定させ、継続的な商談の機会を確保できる。" };
  const before = structuredClone(value);
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.applied, true);
  assert.equal(result.value.action, action.replace("確定の連絡を行う", "双方の日程調整に向けた連絡を行う"));
  assert.equal(result.value.reason, value.reason);
  assert.equal(result.value.expected_outcome, value.expected_outcome);
  assert.deepEqual(value, before);
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
  const simple = "次回面談候補日である10月15日について、社内スケジュールを確認し、顧客へ確定の連絡を行う。";
  for (const text of [
    simple.replace("次回面談", "別の面談"),
    simple.replace("社内スケジュール", "双方のスケジュール"),
    simple.replace("顧客へ", "双方の都合が合えば、顧客へ"),
    simple.replace("行う。", "行うか確認する。"),
    simple.replace("行う。", "行うとは合意していません。"),
    `「${simple}」との記載を確認する。`,
    `原文: 営業：${simple}`,
  ]) {
    const candidate = { action: text };
    assert.equal(constrainUnagreedSubmissionDeadline(source, candidate).value, candidate, text);
  }
  for (const transcript of [
    "顧客：資料の提出期限は未合意です。",
    `${source}\n顧客：次回面談は2026年10月15日で確定です。`,
    `${source}\n顧客：${simple}`,
  ]) {
    const candidate = { action: simple };
    assert.equal(constrainUnagreedSubmissionDeadline(transcript, candidate).value, candidate);
  }
});

test("anaphoric deadlines without an unambiguous same-line candidate keep their original scope", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  for (const text of [
    "その面談までに資料を送る。",
    "当該面談までに資料を送る。",
    "別の面談候補日である10月15日を確認し、その面談までに資料を送る。",
    "次回面談候補日である10月15日を確認し、別の面談について相談し、その面談までに資料を送る。",
    "次回商談候補日を確認し、その面談までに資料を送る。",
    "次回面談候補日を確認する。\nその面談までに資料を送る。",
    "「次回面談候補日は10月15日」との記載を確認し、その面談までに資料を送る。",
    "次回面談候補日を確認し、「その面談までに資料を送る」との記載を確認する。",
    "次回面談候補日を確認したが、その面談までに送るとは合意していません。",
    "原文: 営業：次回面談候補日を確認し、その面談までに資料を送ります。",
    "次回面談候補日を確認し、その面談の日程を調整する。",
  ]) {
    const value = { action: text };
    assert.equal(constrainUnagreedSubmissionDeadline(source, value).value, value, text);
  }
  const value = { action: "次回面談候補日を確認し、その面談までに資料を送る。" };
  assert.equal(constrainUnagreedSubmissionDeadline("顧客：次回面談は10月15日が候補です。", value).value, value);
  assert.equal(constrainUnagreedSubmissionDeadline(`${source}\n顧客：資料は次回面談までに送ってください。`, value).value, value);
});

test("only deadline occurrences outside quoted spans are repaired", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  for (const [opening, closing] of [["「", "」"], ["『", "』"], ['"', '"'], ["“", "”"]]) {
    const quoted = `${opening}次回面談までに資料を送る${closing}`;
    const value = { action: `${quoted}という記載を確認し、次回の面談までに${opening}確認結果${closing}を共有する。` };
    const result = constrainUnagreedSubmissionDeadline(source, value);
    assert.equal(result.value.action, `${quoted}という記載を確認し、期限を確認したうえで、${opening}確認結果${closing}を共有する。`);
  }
  for (const quoted of [
    "「営業は『次回面談までに資料を送る』と説明した」との記載を確認する。",
    "「資料を確認します。次回面談までに送ります」との記載を確認する。",
    "「資料を確認します。\r\n次回面談までに送ります」との記載を確認する。",
    "「未完の引用では、次回面談までに資料を送ると書かれている。",
    "「次回面談」までに資料を送るとの記載を確認する。",
    "次回面談までに資料を送るとは合意していません。",
  ]) {
    const value = { action: quoted };
    assert.equal(constrainUnagreedSubmissionDeadline(source, value).value, value, quoted);
  }
});

test("literal source fields and source-labelled passages are not recommendation prose", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  const passage = "顧客：次回面談までに資料を送ってください。\r\n  というのは以前の条件です。";
  const value = {
    reason: `原文: ${passage}`,
    real_intent: `顧客が明示した内容（原文）: ${passage}`,
    quote: passage, source_quote: passage, sourceText: passage,
  };
  assert.equal(constrainUnagreedSubmissionDeadline(source, value).value, value);
});

test("observed v8 candidate dates cannot become deadlines while scheduling references remain intact", () => {
  const source = "顧客：次回の面談は2026年10月15日が候補です。資料の提出期限は未合意です。";
  const schedule = "次回の面談候補日である2026年10月15日について、営業担当の空き状況を確認する。";
  const value = {
    topSales: { winning_scenario: `${schedule}次回の面談候補日である2026年10月15日までに、顧客が社内確認を進められるよう、具体的な検討材料を準備する。` },
    strategy: { closing_plan: "4. 各選択肢を整理する。\n5. 次回面談（2026年10月15日候補）までに、上記資料を準備する。" },
  };
  const before = structuredClone(value);
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.applied, true);
  assert.equal(result.value.topSales.winning_scenario, `${schedule}期限を確認したうえで、顧客が社内確認を進められるよう、具体的な検討材料を準備する。`);
  assert.equal(result.value.strategy.closing_plan, "4. 各選択肢を整理する。\n5. 期限を確認したうえで、上記資料を準備する。");
  assert.deepEqual(value, before);
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
});

test("bounded next-meeting annotations preserve descriptive roles across sentences and nested labels", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  for (const deadline of [
    "次回の面談候補日までに", "次回面談の候補日までに", "次回面談（候補）までに",
    "次回面談（候補日調整中）までに", "次回面談（日程調整中）までに",
    "次回面談（候補日：2026年10月15日）までに", "次回面談(10月15日候補)の前に",
    "次回の商談候補日である10月15日までに", "次回商談の予定日である2026/10/15までに",
    "次回打ち合わせ（2026年10月15日（木）候補）までに", "次回打合せ（１０月１５日候補）前に",
    "次回面談（10/15候補）までに",
  ]) {
    const value = { closing_plan: [
      `1週目：リスク：確認に時間がかかる。${deadline}情報が揃わない可能性。`,
      `2週目：理由：顧客が比較するため。${deadline}判断材料を整理するため。`,
      `2週目：期待成果：比較が進む。${deadline}材料が得られる。`,
      `3週目：行動：対象を確認する。${deadline}資料を準備する。`,
    ].join("\r\n\r\n") };
    const result = constrainUnagreedSubmissionDeadline(source, value);
    assert.equal(result.value.closing_plan, [
      "1週目：リスク：確認に時間がかかる。情報が揃わない可能性。",
      "2週目：理由：顧客が比較するため。判断材料を整理するため。",
      "2週目：期待成果：比較が進む。材料が得られる。",
      "3週目：行動：対象を確認する。期限を確認したうえで、資料を準備する。",
    ].join("\r\n\r\n"), deadline);
    assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value, deadline);
  }
});

test("unrelated dates, scheduling, quotes, denials and arbitrary parenthetical prose are unchanged", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  for (const text of [
    "2026年10月15日までに資料を送付する。",
    "次回面談（2026年10月15日候補）の日程を確認する。",
    "次回面談（2026年10月15日候補）に向けて日程を調整する。",
    "次回の面談候補日である2026年10月15日について連絡する。",
    "次回面談（2026年10月15日候補）で社内確認の進捗を聞く。",
    "導入するなら2027年9月を希望する。",
    "別の面談（2026年10月15日候補）までに資料を準備する。",
    "前回面談（2026年10月15日）までに資料を準備した。",
    "次回面談（提出条件については個別に合意済み）までに資料を準備する。",
    `次回面談（${"候補".repeat(30)}）までに資料を準備する。`,
    "次回面談（2026年10月15日候補）までに提出するとは合意していません。",
    "次回の面談候補日である2026年10月15日までに提出するかは未定。",
    "「次回面談（2026年10月15日候補）までに資料を送る」との合意はない。",
    '"次回面談（2026年10月15日候補）までに資料を送る"という記載を確認する。',
  ]) {
    const value = { closing_plan: text };
    const result = constrainUnagreedSubmissionDeadline(source, value);
    assert.equal(result.value, value, text);
    assert.equal(result.applied, false, text);
  }
  const value = { closing_plan: "次回面談（2026年10月15日候補）までに資料を送付する。" };
  for (const laterAgreement of [
    "顧客：資料は次回面談（2026年10月15日候補）までに送ってください。",
    "顧客：資料の提出期限は2026年10月15日で合意します。",
  ]) assert.equal(constrainUnagreedSubmissionDeadline(`${source}\n${laterAgreement}`, value).value, value);
  assert.equal(constrainUnagreedSubmissionDeadline("顧客：次回面談は2026年10月15日が候補です。", value).value, value);
});

test("nested plan labels apply to every sentence without carrying roles to the next line", () => {
  const source = "顧客：資料の提出期限は未合意です。";
  const value = { closing_plan: [
    "1週目：リスク：確認に時間がかかる。次回面談までに情報が揃わない可能性。",
    "1週目：リスク：次回面談までに比較できない可能性。",
    "2週目：理由：顧客が比較するため。次回面談までに判断材料を整理するため。",
    "2週目：期待成果：比較が進む。次回面談までに材料が得られる。",
    "3週目：行動：対象を確認する。次回面談までに資料を確認する。",
  ].join("\r\n\r\n") };
  const result = constrainUnagreedSubmissionDeadline(source, value);
  assert.equal(result.value.closing_plan, [
    "1週目：リスク：確認に時間がかかる。情報が揃わない可能性。",
    "1週目：リスク：比較できない可能性。",
    "2週目：理由：顧客が比較するため。判断材料を整理するため。",
    "2週目：期待成果：比較が進む。材料が得られる。",
    "3週目：行動：対象を確認する。期限を確認したうえで、資料を確認する。",
  ].join("\r\n\r\n"));
  assert.equal(constrainUnagreedSubmissionDeadline(source, result.value).value, result.value);
  assert.ok(value.closing_plan.includes("次回面談までに"));
});

test("conditional adoption retains its literal wording and original customer turn", () => {
  const quote = "導入するなら2027年6月を希望します。";
  const turn = `顧客：予算は120万円目安です。${quote}正式な導入時期は未確定です。`;
  assert.deepEqual(customerAdoptionConditions(`営業：希望時期を教えてください。\n${turn}`), [{ quote, turn }]);
  const summary = retainAdoptionConditions("導入は2027年6月を希望。正式時期は未確定。", turn);
  assert.ok(summary.endsWith(`顧客発言（原文）: ${quote}`));
  assert.equal(retainAdoptionConditions(summary, turn), summary);
  assert.ok(retainAdoptionConditions("希望時期は6月", turn, quote).includes(quote));
  assert.equal(retainAdoptionConditions("希望時期は6月", quote), "希望時期は6月");
  assert.equal(retainAdoptionConditions("希望時期は6月", `営業：${quote}`, quote), "希望時期は6月");
  assert.equal(retainAdoptionConditions("希望時期は6月", turn, "別の引用"), "希望時期は6月");
});

test("sales suggestions, questions, negation, and mixed speaker lines do not become customer conditions", () => {
  for (const source of [
    "営業：導入するなら2027年6月を希望します。",
    "顧客：導入するなら2027年6月を希望しますか？",
    "顧客：導入するなら2027年6月を希望しません。",
    "顧客：導入するなら2027年6月を希望していました。",
    "顧客：面談は2027年6月を希望します。",
    "顧客：希望は未定。営業：導入するなら2027年6月を希望します。",
    "顧客：2027年6月に導入すると決めました。",
  ]) assert.deepEqual(customerAdoptionConditions(source), [], source);
});
