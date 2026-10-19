import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groundMinutesActions } from "../src/lib/ai/minutes-action-evidence";

const candidate = (source_quote: string, overrides: Record<string, unknown> = {}) => ({ action: "生成された対応予定", owner: "生成された担当", due: "未確認", source_quote, ...overrides });

test("actual wish-only opportunity does not become the generated assigned meeting action", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const wish = "こちらで考える案が課題に合っているか、またお話しできればと思います。";
  const opportunity = "ありがとうございます。今日だけでは細かな使い方までは伺い切れないので、話の続きをする機会も検討できればと思います。";
  const intended = "仕事内容を学生にどう伝えるか、改めて社内でも話してみたいと思います。";
  const drafts = [
    candidate(wish, { action: "社内での検討内容を話す機会を設ける", owner: "営業" }),
    candidate(opportunity, { action: "次回の面談日程を調整する", owner: "営業" }),
    candidate(intended, { action: "社内で仕事内容を学生にどう伝えるか話す", owner: "営業", due: "明日" }),
  ];
  const before = structuredClone(drafts);
  const result = groundMinutesActions(source, drafts);
  assert.deepEqual(result.next_actions, [{ action: intended, owner: "顧客", due: "未確認" }]);
  assert.deepEqual(result.audit.rejected.map(({ reason }) => reason), ["no_explicit_self_intention", "no_explicit_self_intention"]);
  assert.equal(result.audit.candidates, drafts);
  assert.deepEqual(drafts, before);
  assert.equal(result.audit.accepted[0].source_speaker, "顧客");
});

test("actual confirmations and contact plans survive with literal wording and source owners", () => {
  const customer = "社内で確認してから連絡します。";
  const seller = "空き状況を確認します。";
  const named = "私が資料を整理しておきます。";
  const unknown = "確認してから連絡します。";
  const transcript = `顧客：${customer}\n営業：${seller}\n田中：${named}\n\n${unknown}`;
  const result = groundMinutesActions(transcript, [customer, seller, named, unknown].map(quote => candidate(quote, { owner: "取締役", due: "24時間以内" })));
  assert.deepEqual(result.next_actions, [
    { action: customer, owner: "顧客", due: "未確認" },
    { action: seller, owner: "営業", due: "未確認" },
    { action: named, owner: "田中", due: "未確認" },
    { action: unknown, owner: "未確認", due: "未確認" },
  ]);
});

test("questions, necessity-only statements, negation and another person's plan do not assign an action", () => {
  for (const quote of [
    "空き状況を確認する必要があります。",
    "こちらもその日の空き状況を確認する必要があります。",
    "確認してから連絡できますか？",
    "空き状況を確認しますか。",
    "資料を送付しません。",
    "資料を送付する予定はありません。",
    "資料を送付しますという意味ではありません。",
    "確認したいのですが、まだ何も決めていません。",
    "上長が確認します。",
    "先方が連絡します。",
    "田中さんが資料を送付します。",
    "『確認してから連絡します』と顧客が述べました。",
    "またお話しできればと思います。",
    "話す機会も検討できればと思います。",
  ]) {
    const result = groundMinutesActions(`営業：${quote}`, [candidate(quote)]);
    assert.deepEqual(result.next_actions, [], quote);
  }
  const quote = "『撮影可否』を私が確認します。";
  assert.deepEqual(groundMinutesActions(`営業：${quote}`, [candidate(quote)]).next_actions, [{ action: quote, owner: "営業", due: "未確認" }]);
});

test("quotes must be complete literal sentences from one unambiguous source block", () => {
  const complete = "許可が出たら、確認してから連絡します。";
  for (const quote of ["確認してから連絡します。", "許可が出たら、確認してから連絡いたします。", complete.slice(0, -1)]) {
    const result = groundMinutesActions(`顧客：${complete}`, [candidate(quote)]);
    assert.deepEqual(result.next_actions, [], quote);
    assert.equal(result.audit.rejected[0].reason, "source_not_literal_complete_sentences");
  }
  assert.deepEqual(groundMinutesActions(`顧客：${complete}`, [candidate(complete)]).next_actions, [{ action: complete, owner: "顧客", due: "未確認" }]);
  const quote = "資料を確認します。";
  const mixed = groundMinutesActions(`顧客：${quote} 営業：はい。`, [candidate(quote)]);
  assert.equal(mixed.audit.rejected[0].reason, "ambiguous_speakers");
  const repeated = groundMinutesActions(`営業：${quote}\n顧客：${quote}`, [candidate(quote)]);
  assert.equal(repeated.audit.rejected[0].reason, "ambiguous_source_owner");
  const crossed = groundMinutesActions(`営業：${quote}\n顧客：連絡します。`, [candidate(`${quote}\n連絡します。`)]);
  assert.equal(crossed.audit.rejected[0].reason, "source_not_literal_complete_sentences");
});

test("continuation lines and adjacent caveats remain literal rather than losing conditions", () => {
  const first = "確認してから連絡します。";
  const condition = "ただし、社内の許可が出た場合に限ります。";
  const quote = `${first}\r\n  ${condition}`;
  const source = `顧客：${quote}`;
  const incomplete = groundMinutesActions(source, [candidate(first)]);
  assert.equal(incomplete.audit.rejected[0].reason, "omitted_adjacent_qualifier");
  const result = groundMinutesActions(source, [candidate(quote)]);
  assert.deepEqual(result.next_actions, [{ action: quote, owner: "顧客", due: "未確認" }]);
  assert.deepEqual(result.audit.accepted[0].sourceIds, [1, 2]);
  const withdrawn = `顧客：${first}ただし、その予定は取り下げます。`;
  assert.deepEqual(groundMinutesActions(withdrawn, [candidate(first)]).next_actions, []);
  assert.deepEqual(groundMinutesActions(withdrawn, [candidate(withdrawn.slice(3))]).next_actions, []);
});

test("due requires a literal explicit deadline on the action sentence, never the candidate meeting date", () => {
  const agreed = "9月30日までに資料を送付します。";
  const result = groundMinutesActions(`営業：${agreed}`, [candidate(agreed, { due: "9月30日", owner: "顧客" })]);
  assert.deepEqual(result.next_actions, [{ action: agreed, owner: "営業", due: "9月30日" }]);
  const tomorrow = "明日までに連絡します。";
  assert.equal(groundMinutesActions(`顧客：${tomorrow}`, [candidate(tomorrow, { due: "明日までに" })]).next_actions[0].due, "明日までに");
  for (const [quote, due] of [
    ["次回面談の候補日は2026年10月15日です。空き状況を確認します。", "2026年10月15日"],
    ["候補日である10月15日までに資料を送付します。", "10月15日"],
    ["資料を送付します。", "明日"],
    ["9月30日までに資料を送付します。", "10月1日"],
    ["もし9月30日までに承認されたら、資料を送付します。", "9月30日"],
    ["『9月30日までに』という記載を確認します。", "9月30日"],
  ]) {
    assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due })]).next_actions[0].due, "未確認", quote);
  }
});

test("adjacent bare cancellation and following conditions cannot be omitted from action evidence", () => {
  const action = "9月30日までに資料を送付します。";
  for (const context of ["いえ、資料は送付しません。", "社内承認が得られればの話です。"]) {
    const result = groundMinutesActions(`営業：${action}${context}`, [candidate(action, { due: "9月30日" })]);
    assert.deepEqual(result.next_actions, [], context);
    assert.equal(result.audit.rejected[0].reason, "omitted_adjacent_qualifier");
  }
  const conditional = `${action}社内承認が得られればの話です。`;
  assert.deepEqual(groundMinutesActions(`営業：${conditional}`, [candidate(conditional, { due: "9月30日" })]).next_actions,
    [{ action: conditional, owner: "営業", due: "未確認" }]);
  const negated = `${action}いえ、資料は送付しません。`;
  assert.deepEqual(groundMinutesActions(`営業：${negated}`, [candidate(negated, { due: "9月30日" })]).next_actions, []);
  // An unrelated negative statement does not cancel a different commitment.
  assert.equal(groundMinutesActions(`営業：${action}現場は撮影しません。`, [candidate(action)]).next_actions[0].action, action);
});

test("an earlier reported desired date cannot become the deadline for the actual committing clause", () => {
  const quote = "ご希望は9月30日までにと伺いましたが、10月3日までに資料を送付します。";
  assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due: "9月30日" })]).next_actions[0].due, "未確認");
  assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due: "10月3日" })]).next_actions[0].due, "10月3日");
  const compound = "9月30日までに確認してから連絡します。";
  assert.equal(groundMinutesActions(`営業：${compound}`, [candidate(compound, { due: "9月30日" })]).next_actions[0].due, "未確認");
});

test("legacy and missing evidence cannot bypass grounding and drafts are retained unchanged", () => {
  const quote = "確認してから連絡します。";
  const drafts = Object.freeze([Object.freeze({ action: "連絡する", owner: "顧客", due: "未確認" }), quote, null, Object.freeze(candidate(quote))]);
  const result = groundMinutesActions(`顧客：${quote}`, drafts);
  assert.deepEqual(result.next_actions, [{ action: quote, owner: "顧客", due: "未確認" }]);
  assert.equal(result.audit.candidates, drafts);
  assert.deepEqual(result.audit.rejected.map(({ reason }) => reason), ["missing_source_quote", "invalid_candidate", "invalid_candidate"]);
  assert.equal(groundMinutesActions(`顧客：${quote}`, undefined).audit.rejected[0].reason, "invalid_candidates");
});

test("six candidates and 1200 total quote characters bound publication without truncation", () => {
  const quote = "確認してから連絡します。";
  const duplicate = groundMinutesActions(`顧客：${quote}`, Array.from({ length: 7 }, () => candidate(quote)));
  assert.equal(duplicate.next_actions.length, 1);
  assert.equal(duplicate.audit.rejected[0].reason, "duplicate_source_quote");
  assert.equal(duplicate.audit.rejected.at(-1)!.reason, "candidate_limit_exceeded");
  const first = `${"資料の状況を伺いました。".repeat(60)}資料を確認します。`;
  const second = first.replace("資料を確認します。", "内容を確認します。");
  const result = groundMinutesActions(`営業：${first}\n営業：${second}`, [candidate(first), candidate(second)]);
  assert.deepEqual(result.next_actions.map(({ action }) => action), [first]);
  assert.equal(result.audit.rejected[0].reason, "source_quote_budget_exceeded");
});

test("agreed fixture preserves the self-apposed sender and the literal submission date with clock", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt", import.meta.url), "utf8");
  const quote = "私、田中が2026年9月30日17時までに、今回合意した内容を記載した企画書と正式見積書を、佐伯様へメールで送付します。";
  const drafts = [candidate(quote, { action: "企画書と見積書を送る", owner: "佐伯", due: "2026年9月30日17時" })];
  const before = structuredClone(drafts);
  const result = groundMinutesActions(source, drafts);
  assert.deepEqual(result.next_actions, [{ action: quote, owner: "営業", due: "2026年9月30日17時" }]);
  assert.equal(result.audit.accepted[0].source_speaker, "営業");
  assert.equal(result.audit.candidates, drafts);
  assert.deepEqual(result.audit.rejected, []);
  assert.deepEqual(drafts, before);
});

test("self-apposition allows only an explicit self actor and preserves denial, question and condition controls", () => {
  for (const quote of [
    "私、田中が9月30日までに資料を送付します。",
    "私,田中が9月30日までに、資料を送付します。",
  ]) {
    assert.deepEqual(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due: "9月30日" })]).next_actions,
      [{ action: quote, owner: "営業", due: "9月30日" }]);
  }
  for (const quote of [
    "田中が9月30日までに資料を送付します。",
    "田中さんが9月30日までに資料を送付します。",
    "私、田中が聞いたところ、佐伯様が9月30日までに資料を送付します。",
    "私、田中が確認してから、佐伯様が9月30日までに資料を送付します。",
    "『私、田中が9月30日までに資料を送付します』と聞きました。",
    "私、田中が9月30日までに資料を送付しますか。",
    "私、田中が9月30日までに資料を送付しません。",
  ]) {
    const source = `営業：営業担当の田中です。\n営業：${quote}`;
    assert.deepEqual(groundMinutesActions(source, [candidate(quote, { due: "9月30日" })]).next_actions, [], quote);
  }
  const conditional = "私、田中が承認を得られれば9月30日17時までに資料を送付します。";
  assert.deepEqual(groundMinutesActions(`営業：${conditional}`, [candidate(conditional, { due: "9月30日17時" })]).next_actions,
    [{ action: conditional, owner: "営業", due: "未確認" }]);
  const committed = "私、田中が9月30日17時までに資料を送付します。";
  assert.deepEqual(groundMinutesActions(`営業：${committed}ただし、その予定は取り下げます。`, [candidate(committed, { due: "9月30日17時" })]).next_actions, []);
});

test("clock deadlines must be exact literal dates on the committing clause", () => {
  for (const due of ["2026年9月30日17時", "9月30日17時30分", "２０２６年９月３０日１７時３０分", "2026-09-30 17:30", "明日17時"]) {
    const quote = `${due}までに資料を送付します。`;
    assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due })]).next_actions[0].due, due);
  }
  const quote = "2026年9月30日17時までに資料を送付します。";
  for (const due of ["2026年9月30日", "2026年9月30日18時", "2026年9月30日17時30分", "2026年10月5日17時"]) {
    assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote, { due })]).next_actions[0].due, "未確認", due);
  }
  for (const due of ["9月30日25時", "9月30日17時60分"]) {
    const invalidClock = `${due}までに資料を送付します。`;
    assert.equal(groundMinutesActions(`営業：${invalidClock}`, [candidate(invalidClock, { due })]).next_actions[0].due, "未確認", due);
  }
  const reported = "ご希望は9月30日17時までにと伺いましたが、10月3日18時までに資料を送付します。";
  assert.equal(groundMinutesActions(`営業：${reported}`, [candidate(reported, { due: "9月30日17時" })]).next_actions[0].due, "未確認");
  assert.equal(groundMinutesActions(`営業：${reported}`, [candidate(reported, { due: "10月3日18時" })]).next_actions[0].due, "10月3日18時");
  for (const earlier of ["私、田中が9月30日17時までにと伺いましたので、", "私、田中が9月30日17時までに確認してから、", "私、田中が9月30日17時までにと伺いましたが、"]) {
    const selfReported = `${earlier}10月3日18時までに資料を送付します。`;
    assert.equal(groundMinutesActions(`営業：${selfReported}`, [candidate(selfReported, { due: "9月30日17時" })]).next_actions[0].due, "未確認", earlier);
    assert.equal(groundMinutesActions(`営業：${selfReported}`, [candidate(selfReported, { due: "10月3日18時" })]).next_actions[0].due, "10月3日18時", earlier);
  }
  const quoted = "『9月30日17時までに』という記載を確認します。";
  assert.equal(groundMinutesActions(`営業：${quoted}`, [candidate(quoted, { due: "9月30日17時" })]).next_actions[0].due, "未確認");
  const candidateMeeting = "次回面談の候補日は2026年10月5日17時です。空き状況を確認します。";
  assert.equal(groundMinutesActions(`営業：${candidateMeeting}`, [candidate(candidateMeeting, { due: "2026年10月5日17時" })]).next_actions[0].due, "未確認");
  assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote.replace("17時", "18時"), { due: "2026年9月30日18時" })]).audit.rejected[0].reason, "source_not_literal_complete_sentences");
});

test("actual full sender quote is retained as an action after the next customer explicitly accepts that submission", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt", import.meta.url), "utf8");
  const action = "私、田中が2026年9月30日17時までに、今回合意した内容を記載した企画書と正式見積書を、佐伯様へメールで送付します。";
  const quote = `${action}この提出期限でよろしいでしょうか。`;
  const drafts = [
    { due: "2026年9月30日17時", owner: "営業: 田中", action: "今回合意した内容を記載した企画書と正式見積書をメールで送付", source_quote: quote },
    { due: "未確認", owner: "未確認", action: "次回の面談日程を調整", source_quote: "資料の提出期限とは別に、双方の予定を確認して日程を調整します。" },
  ];
  const before = structuredClone(drafts);
  const result = groundMinutesActions(source, drafts);
  assert.deepEqual(result.next_actions, [{ action, owner: "営業", due: "2026年9月30日17時" }]);
  assert.equal(result.audit.candidates, drafts);
  assert.deepEqual(drafts, before);
  assert.equal(result.audit.accepted[0].source_quote, quote, "the complete submitted quote stays in the audit");
  assert.equal(result.audit.accepted[0].confirmation_source_quote, "顧客：はい。企画書と正式見積書を2026年9月30日17時までにメールで送っていただくことで合意します。宛先は私です。");
  assert.ok(result.audit.accepted[0].confirmation_source_ids!.length > 0);
  assert.deepEqual(result.audit.rejected, [{ index: 1, reason: "omitted_adjacent_qualifier" }]);
});

test("a confirmation question requires immediate unqualified acceptance of the same object and literal deadline", () => {
  const action = "私、田中が2026年9月30日17時までに、企画書と正式見積書を、佐伯様へメールで送付します。";
  const quote = `${action}この提出期限でよろしいでしょうか。`;
  const acceptance = "企画書と正式見積書を2026年9月30日17時までにメールで送っていただくことで合意します。";
  const draft = candidate(quote, { due: "2026年9月30日17時" });
  for (const following of [
    "",
    "顧客：はい。",
    "顧客：その期限には合意しません。",
    `顧客：${acceptance.replace("9月30日17時", "10月1日17時")}`,
    `顧客：${acceptance.replace("企画書と正式見積書", "契約書")}`,
    `顧客：${acceptance.replace("企画書と正式見積書", "正式見積書")}`,
    "顧客：2026年9月30日17時までに社内で確認することで合意します。",
    `顧客：『${acceptance}』と上長が言ったそうです。`,
    `顧客：${acceptance}ただし、社内承認が得られればの話です。`,
    `顧客：${acceptance}社内承認の取得を条件とします。`,
    `顧客：${acceptance}その合意を撤回します。`,
    `顧客：${acceptance} 営業：ありがとうございます。`,
    `営業：いったん他の話題に移ります。\n顧客：${acceptance}`,
    `田中：${acceptance}`,
  ]) {
    assert.deepEqual(groundMinutesActions(`営業：${quote}\n${following}`, [draft]).next_actions, [], following);
  }
  const acceptedSource = `営業：${quote}\n顧客：${acceptance}`;
  assert.equal(groundMinutesActions(acceptedSource, [draft]).next_actions[0].due, "2026年9月30日17時");
  for (const due of ["2026年9月30日", "2026年9月30日18時", "2026-09-30 17:00", "未確認"]) {
    assert.deepEqual(groundMinutesActions(acceptedSource, [candidate(quote, { due })]).next_actions, [], due);
  }
});

test("confirmation handling never drops another question, action condition, withdrawal or other-person subject", () => {
  const action = "私、田中が2026年9月30日17時までに、企画書と正式見積書を、佐伯様へメールで送付します。";
  const question = "この提出期限でよろしいでしょうか。";
  const acceptance = "顧客：企画書と正式見積書を2026年9月30日17時までにメールで送っていただくことで合意します。";
  for (const quote of [
    `${action}掲載場所はこちらでよろしいでしょうか。`,
    question,
    `${action.replace("私、田中が", "佐伯様が")}${question}`,
    `${action.replace("私、田中が", "私、田中が許可を得られれば")}${question}`,
    `${action}${question}社内承認が得られればの話です。`,
    `${action}ただし、この予定は撤回します。${question}`,
  ]) {
    assert.deepEqual(groundMinutesActions(`営業：${quote}\n${acceptance}`, [candidate(quote, { due: "2026年9月30日17時" })]).next_actions, [], quote);
  }
  for (const extra of ["ただし、社内承認が得られればの話です。", "資料の送付は撤回します。", "補足があります。社内承認が得られればの話です。"]) {
    const quote = action + question;
    assert.deepEqual(groundMinutesActions(`営業：${quote}${extra}\n${acceptance}`, [candidate(quote, { due: "2026年9月30日17時" })]).next_actions, [], extra);
  }
});

test("a quote prefixed with its own speaker label is matched without the label; another speaker's label is not", () => {
  // gemini-3.5-flash-lite returned the source quote with the label although the prompt asks for the body only (2026-09-29).
  const source = "顧客：はい、見積もりをお願いします。\n営業：本日はありがとうございました。\n営業：では、11月20日までに見積書を送付します。\n顧客：はい、それでお願いします。";
  const own = groundMinutesActions(source, [candidate("営業：では、11月20日までに見積書を送付します。", { due: "11月20日まで" })]);
  assert.deepEqual(own.next_actions, [{ action: "では、11月20日までに見積書を送付します。", owner: "営業", due: "11月20日まで" }]);
  assert.equal(own.audit.accepted[0].source_quote, "では、11月20日までに見積書を送付します。");
  for (const quote of ["顧客：では、11月20日までに見積書を送付します。", "営業（田中）：では、11月20日までに見積書を送付します。", "営業：11月20日までに見積書を送付します。"]) {
    const other = groundMinutesActions(source, [candidate(quote)]);
    assert.deepEqual(other.next_actions, [], quote);
    assert.deepEqual(other.audit.rejected, [{ index: 0, reason: "source_not_literal_complete_sentences" }], quote);
  }
  // The same sentence said by two speakers stays ambiguous even with a label.
  const both = "営業：資料を共有します。\n顧客：資料を共有します。";
  assert.deepEqual(groundMinutesActions(both, [candidate("営業：資料を共有します。")]).audit.rejected, [{ index: 0, reason: "source_not_literal_complete_sentences" }]);
  // Other checks still apply to the unlabelled quote.
  assert.deepEqual(groundMinutesActions("営業：では、見積書を送付するかは未定です。", [candidate("営業：では、見積書を送付するかは未定です。")]).audit.rejected.map(({ reason }) => reason), ["negated_action"]);
});

test("a clause-initial では・それでは without its comma is not read as another person's topic", () => {
  // The transcription dropped the comma after では and the action was rejected as another person's (2026-09-29).
  const quote = "では11月20日までに見積書を送付します。";
  const source = `話者1: 本日はたくさんのお話を伺えてありがとうございました。\n話者1: ${quote}\n話者2: はい、それでお願いします。`;
  const result = groundMinutesActions(source, [candidate(quote, { due: "11月20日" })]);
  assert.deepEqual(result.next_actions, [{ action: quote, owner: "話者1", due: "11月20日" }]);
  for (const sentence of ["それでは資料を送付します。", "はい、では資料を送付します。", "はい、 では資料を送付します。", "ではまず私が資料を送付します。", "ではなるべく早く資料を送付します。"]) {
    assert.equal(groundMinutesActions(`営業：${sentence}`, [candidate(sentence)]).next_actions.length, 1, sentence);
  }
  // Only a conjunction at the sentence start or after a comma is skipped. Another person's subject, では as a particle
  // (話では), a では left by the clause split (ならでは・からでは) and ではなく are declined exactly as before.
  for (const sentence of [
    "では田中さんが資料を送付します。", "それでは先方が確認します。", "会議では先方が確認します。", "ではなく先方が送付します。", "では資料は先方が送付します。",
    "田中さんの話では資料を送付します。", "代理店が御社ならではの導入プランを作成します。", "代理店が来週からでは無く11月20日までに見積書を送付します。", "ではなく資料を送付します。",
  ]) {
    assert.deepEqual(groundMinutesActions(`営業：${sentence}`, [candidate(sentence)]).audit.rejected.map(({ reason }) => reason), ["no_explicit_self_intention"], sentence);
  }
  // Parity: a leading では gives the same outcome as the same turn without it (and as では、). The sentences of a
  // context are one turn so that adjacent qualifiers and withdrawals are checked too.
  const contexts: string[][] = [
    ["資料を送付します。"], ["資料を送付しますか？"], ["資料は送付しません。"], ["資料を送付します。ただ、送付するかは未定です。"],
    ["資料を送付します。", "ただし、送付は来月です。"], ["資料を送付します。", "社内承認が得られればの話です。"], ["先方が資料を送付します。"],
    ["「資料を送付します」とのことでした。"], ["ご希望でしたら、資料を送付します。"], ["何かあれば連絡します。"], ["資料の送付は撤回します。"],
    ["資料をお送りします。", "やはりお送りしません。"], ["明日までに資料を送付します。"], ["私が資料を送付します。"],
  ];
  const outcome = (sentences: string[]) => {
    const result = groundMinutesActions(`営業：${sentences.join("")}`, [candidate(sentences[0], { due: "明日" })]);
    return { actions: result.next_actions.map(({ owner, due }) => ({ owner, due })), reasons: result.audit.rejected.map(({ reason }) => reason) };
  };
  assert.deepEqual(outcome(["資料を送付します。", "ただし、送付は来月です。"]).reasons, ["omitted_adjacent_qualifier"]);
  for (const sentences of contexts) {
    for (const prefix of ["では", "それでは", "では、"]) {
      assert.deepEqual(outcome([prefix + sentences[0], ...sentences.slice(1)]), outcome(sentences), prefix + sentences.join(""));
    }
  }
});

test("the same speaker's following line is adjacent context, as if the lines were one turn", () => {
  // The timed transcription writes one utterance per labelled line; a caveat on the next line was not checked (2026-09-30).
  const action = "11月20日までに見積書を送付します。";
  const reasons = (transcript: string, quote = action) => groundMinutesActions(transcript, [candidate(quote, { due: "11月20日" })]).audit.rejected.map(({ reason }) => reason);
  for (const next of ["ただし、社内の承認が得られた場合に限ります。", "いえ、やはり見積書は送付しません。", "その予定は撤回します。", "社内承認が得られればの話です。", "但し、先方の了承が前提です。"]) {
    const transcript = `話者2: お願いします。\n話者1: ${action}\n話者1: ${next}\n話者2: はい。`;
    assert.deepEqual(reasons(transcript), ["omitted_adjacent_qualifier"], transcript);
    assert.deepEqual(reasons(transcript.replaceAll("\n", "\r\n")), ["omitted_adjacent_qualifier"], `CRLF ${next}`);
  }
  // A repeated identical line is located at its own position (the later occurrence is the one checked).
  assert.deepEqual(reasons(`話者1: ${action}\n話者2: はい。\n話者1: ${action}\n話者1: ただし、社内の承認が得られた場合に限ります。`), ["omitted_adjacent_qualifier"]);
  // A caveat on the preceding line qualifies that earlier statement, not the promise after it.
  const afterCondition = groundMinutesActions(`話者1: 値引きは年間契約の場合に限ります。\n話者1: ${action}`, [candidate(action, { due: "11月20日" })]);
  assert.deepEqual(afterCondition.next_actions, [{ action, owner: "話者1", due: "11月20日" }]);
  assert.deepEqual(reasons(`話者1: 社内承認が得られればの話です。\n話者1: ${action}\n話者1: よろしくお願いします。`), []);
  // Only the directly following sentence: a caveat two sentences away is not adjacent, in one line or across lines.
  assert.deepEqual(reasons(`話者1: ${action}\n話者1: よろしくお願いいたします。\n話者1: ただし、次回の日程は未定です。`), []);
  assert.deepEqual(reasons(`話者1: ${action}よろしくお願いいたします。ただし、次回の日程は未定です。`), []);
  assert.deepEqual(reasons(`話者1: ${action}よろしくお願いいたします。\n話者1: ただし、次回の日程は未定です。`), []);
  assert.deepEqual(reasons(`話者1: ${action}\n話者1: よろしくお願いいたします。ただし、次回の日程は未定です。`), []);
  assert.deepEqual(reasons(`話者1: よろしくお願いします。${action}\n話者1: ただし、社内の承認が得られた場合に限ります。`), ["omitted_adjacent_qualifier"]);
  // Another speaker's line, a blank line or a mixed-speaker line delimits the turn (as for the Timeline context).
  for (const transcript of [
    `話者1: ${action}\n話者2: ただし、社内の承認が得られた場合に限ります。`,
    `話者1: ${action}\n話者2: はい。\n話者1: ただし、社内の承認が得られた場合に限ります。`,
    `話者1: ${action}\n\n話者1: ただし、社内の承認が得られた場合に限ります。`,
    `話者1: ${action}\n話者1: ただし、社内の承認が得られた場合に限ります。話者2: はい。`,
  ]) assert.deepEqual(reasons(transcript), [], transcript);
  // An unrelated next line of the same speaker does not reject; the owner and due are unchanged.
  const accepted = groundMinutesActions(`話者1: 本日はありがとうございました。\n話者1: では${action}\n話者1: よろしくお願いいたします。`, [candidate(`では${action}`, { due: "11月20日" })]);
  assert.deepEqual(accepted.next_actions, [{ action: `では${action}`, owner: "話者1", due: "11月20日" }]);
  // Parity for what follows the quote: splitting the turn into one line per sentence gives the single-line outcome.
  const contexts: string[][] = [
    [action], [action, "ただし、送付は来月です。"], [action, "社内承認が得られればの話です。"], [action, "やはり送付しません。"],
    [action, "請求書は送付しません。"], [action, "よろしくお願いします。"], [action, "以上です。", "ただし、送付は来月です。"],
    [action, "やはり見積書は送付しません。"], [action, "何かあれば連絡します。"],
  ];
  const outcome = (transcript: string) => {
    const result = groundMinutesActions(transcript, [candidate(action, { due: "11月20日" })]);
    return { actions: result.next_actions.map(({ owner, due }) => ({ owner, due })), reasons: result.audit.rejected.map(({ reason }) => reason) };
  };
  for (const sentences of contexts) {
    const joined = outcome(`話者2: どうぞ。\n話者1: ${sentences.join("")}\n話者2: はい。`);
    for (const newline of ["\n", "\r\n"]) {
      const split = outcome(`話者2: どうぞ。${newline}${sentences.map(sentence => `話者1: ${sentence}`).join(newline)}${newline}話者2: はい。`);
      assert.deepEqual(split, joined, `${JSON.stringify(newline)} ${sentences.join("|")}`);
    }
  }
});

test("a continuation line starting with a clock time is not split into a speaker label", () => {
  for (const [line, quote] of [["明日10:00までに見積書を送付します。", "明日10:00までに見積書を送付します。"], ["午前10：00までに社内で確認します。", "午前10：00までに社内で確認します。"]]) {
    const result = groundMinutesActions(`営業：承知しました。\n${line}`, [candidate(quote)]);
    assert.deepEqual(result.next_actions, [], line);
    assert.ok(!result.audit.accepted.length, line);
  }
});

test("humble sales verbs (お送りします・ご用意します…) are accepted and judged exactly like the kango verbs", () => {
  // gemini-3.5-flash-lite quoted natural phrasing such as 「資料をお送りします。」 that the kango-only rule dropped (2026-09-29).
  const accepted = groundMinutesActions("営業：11月20日までに資料をお送りします。", [candidate("11月20日までに資料をお送りします。", { due: "11月20日まで" })]);
  assert.deepEqual(accepted.next_actions, [{ action: "11月20日までに資料をお送りします。", owner: "営業", due: "11月20日まで" }]);
  for (const sentence of ["こちらでご用意します。", "見積書をお持ちします。", "契約書をお届けします。", "資料をお渡しします。", "結果をお伝えします。", "決まり次第お知らせします。", "概算をご提示します。", "進捗をご報告します。", "サンプルを持参します。", "資料をお送りいたします。", "資料をお送りする予定です。"]) {
    assert.equal(groundMinutesActions(`営業：${sentence}`, [candidate(sentence)]).next_actions.length, 1, sentence);
  }
  // Parity: each context gives the humble verb the same outcome as the kango verb it resembles.
  const contexts: Array<(v: string) => string[]> = [
    v => [`資料を${v}します。`], v => [`資料を${v}しますか？`], v => [`資料は${v}しません。`], v => [`資料を${v}します。ただ、${v}するかは未定です。`],
    v => [`資料を${v}します。`, `ただし、${v}は来月です。`], v => [`先方が資料を${v}します。`], v => [`「資料を${v}します」とのことでした。`],
    v => [`ご希望でしたら、資料を${v}します。`], v => [`何かあれば${v}します。`], v => [`資料の${v}は撤回します。`],
    // Adjacent negation that names the same action (checked through actionWords).
    v => [`資料を${v}します。`, `やはり${v}しません。`], v => [`資料を${v}します。`, `その${v}は撤回します。`],
  ];
  const outcome = (lines: string[]) => {
    const result = groundMinutesActions(lines.map(line => `営業：${line}`).join("\n"), [candidate(lines[0])]);
    return { accepted: result.next_actions.length, reasons: result.audit.rejected.map(({ reason }) => reason) };
  };
  // Compared with the kango verbs that the withdrawal check (未定・撤回) also covers: 送付・提出・連絡・確認.
  for (const [kango, humble] of [["送付", "お送り"], ["提出", "ご提示"], ["連絡", "お伝え"], ["確認", "ご用意"], ["送付", "お届け"], ["提出", "持参"]]) {
    for (const context of contexts) assert.deepEqual(outcome(context(humble)), outcome(context(kango)), `${humble} vs ${kango}: ${context(humble).join("")}`);
  }
});

// UI確認 2026-10-01（edge-02）：2分30秒の対面録音で「では来週の金曜日までに、構成案と見積もり書をお送りします。」の期限が「未確認」になった。
// 相対的な期限（来週の金曜日まで、明日中など）は日付に変換せず、原文の表記のまま期限に残す。原文に無い期限は作らない。
test("relative deadlines stay as literally spoken (来週の金曜日まで, 明日中) without converting to dates", () => {
  const friday = "では来週の金曜日までに、構成案と見積もり書をお送りします。";
  const source = `話者1: ${friday}`;
  for (const [due, expected] of [
    ["来週の金曜日まで", "来週の金曜日まで"],
    ["来週の金曜日までに", "来週の金曜日までに"],
    ["来週の金曜日", "来週の金曜日"],
    // 下書きが期限を拾えなかった（未確認・空）ときは、対応を表明した文にある期限の原文をそのまま使う。
    ["未確認", "来週の金曜日までに"],
    ["", "来週の金曜日までに"],
  ]) {
    assert.deepEqual(groundMinutesActions(source, [candidate(friday, { due })]).next_actions,
      [{ action: friday, owner: "話者1", due: expected }], due);
  }
  const today = "明日中に資料をお送りします。";
  for (const [due, expected] of [["明日中", "明日中"], ["明日中に", "明日中に"], ["未確認", "明日中に"]]) {
    assert.equal(groundMinutesActions(`営業：${today}`, [candidate(today, { due })]).next_actions[0].due, expected, due);
  }
  for (const quote of ["今週中に見積書をお送りします。", "再来週の月曜日までに見積書をお送りします。"]) {
    assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote)]).next_actions[0].due, quote.slice(0, quote.indexOf("に") + 1), quote);
  }
});

test("relative deadline fallback never invents or overrides a deadline", () => {
  // 原文に期限が無ければ未確認のまま。
  const plain = "構成案と見積もり書をお送りします。";
  assert.equal(groundMinutesActions(`営業：${plain}`, [candidate(plain)]).next_actions[0].due, "未確認");
  // 下書きの期限が原文と食い違うときは、原文から別の期限を補わない（従来どおり未確認）。
  const friday = "来週の金曜日までに見積書をお送りします。";
  assert.equal(groundMinutesActions(`営業：${friday}`, [candidate(friday, { due: "来週の月曜日" })]).next_actions[0].due, "未確認");
  // 条件付き・候補日・対応の表明でない文の日付は期限にしない。
  for (const quote of [
    "もし来週の金曜日までに承認されたら、資料をお送りします。",
    "次回の候補日は来週の金曜日です。資料をお送りします。",
    "来週の金曜日までに見積書をお送りします。社内承認が得られればの話です。",
  ]) {
    assert.equal(groundMinutesActions(`営業：${quote}`, [candidate(quote)]).next_actions[0]?.due ?? "未確認", "未確認", quote);
  }
});
