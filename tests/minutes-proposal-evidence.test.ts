import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { groundMinutesProposals } from "../src/lib/ai/minutes-proposal-evidence";

const candidate = (source_quote: string, text = "検討案を説明する", speech_act = "offered_option") => ({ text, source_quote, speech_act });
const published = (quote: string) => `営業側の検討案：${quote}`;

test("a mislabeled factual sharing question is rejected while an interrogative option survives", () => {
  const question = "学生からの質問は、説明会の担当者同士で共有されていますか。";
  const option = "動画を使ってみてはいかがでしょうか。";
  const result = groundMinutesProposals(`営業：${question}\n営業：${option}`, [candidate(question, "質問を共有する"), candidate(option)]);
  assert.deepEqual(result.proposals, [published(option)]);
  assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "factual_question" }]);
  assert.equal(result.audit.accepted[0].index, 1);
});

test("model speech-act labels cannot bypass existing-state, permission or negative source exclusions", () => {
  const cases = [
    ["学生からの質問は担当者間で口頭共有しています。", "existing_state"],
    ["動画をご提案してもよろしいですか？", "permission_request"],
    ["動画をご提案してもよろしいでしょうか。", "permission_request"],
    ["今回は動画を提案しません。", "negated_proposal"],
    ["今回は動画を提案しない方針です。", "negated_proposal"],
    ["動画を提案する方針ではありません。", "negated_proposal"],
    ["動画を提案していない状態です。", "negated_proposal"],
    ["動画の提案を見送ります。", "negated_proposal"],
    ["動画をご提案いたしません。", "negated_proposal"],
    ["動画を提案しますという意味ではありません。", "negated_proposal"],
    ["動画はおすすめですか？", "factual_question"],
    ["他に選択肢はありますか？", "factual_question"],
    ["質問を共有する方法はありますか。", "factual_question"],
  ];
  for (const [quote, reason] of cases) {
    const result = groundMinutesProposals(`営業：${quote}`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [], quote);
    assert.deepEqual(result.audit.rejected, [{ index: 0, reason }], quote);
  }
  const suggestion = "よくある質問を一覧に整理しませんか。";
  assert.deepEqual(groundMinutesProposals(`営業：${suggestion}`, [candidate(suggestion)]).proposals, [published(suggestion)]);
});

test("nonliteral, wrong-speaker and truncated conditional source quotes do not ground proposals", () => {
  const complete = "もし認知の機会が足りないのであれば、SNSで接点を増やす方法も考えられます。";
  for (const quote of [
    "もし認知の機会が足りないのであれば、SNSで接点を増やす方法があります。",
    "SNSで接点を増やす方法も考えられます。",
    "もし認知の機会が足りないのであれば、SNSで接点を増やす方法も考えられます",
  ]) {
    const result = groundMinutesProposals(`営業：${complete}`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [], quote);
    assert.equal(result.audit.rejected[0].reason, "source_not_literal_eligible_sentences");
  }
  assert.deepEqual(groundMinutesProposals(`顧客：${complete}`, [candidate(complete)]).proposals, []);
  assert.deepEqual(groundMinutesProposals(`営業：顧客：${complete}`, [candidate(complete)]).proposals, []);
  assert.deepEqual(groundMinutesProposals(`営業：はい。田中：${complete}`, [candidate(`田中：${complete}`)]).proposals, []);
});

test("adjacent explicit conditions must be quoted and withdrawal cannot disappear through a short quote", () => {
  const option = "動画を提案します。";
  const condition = "撮影許可が出た場合に限ります。";
  const incomplete = groundMinutesProposals(`営業：${condition}${option}`, [candidate(option)]);
  assert.deepEqual(incomplete.proposals, []);
  assert.equal(incomplete.audit.rejected[0].reason, "omitted_adjacent_qualifier");
  assert.deepEqual(groundMinutesProposals(`営業：${condition}${option}`, [candidate(`${condition}${option}`)]).proposals, [published(`${condition}${option}`)]);
  const withdrawn = `${option}ただし、その提案は取り下げます。`;
  for (const quote of [option, withdrawn]) {
    assert.deepEqual(groundMinutesProposals(`営業：${withdrawn}`, [candidate(quote)]).proposals, []);
  }
});

test("named, numbered and unlabelled transcripts preserve literal options without inferring a sales role", () => {
  const quote = "動画を使ってみてはいかがでしょうか。";
  for (const source of [`山田：${quote}`, `話者1：${quote}`, quote]) {
    const result = groundMinutesProposals(source, [candidate(quote)]);
    assert.deepEqual(result.proposals, [`商談中の検討案：${quote}`], source);
    assert.equal(result.audit.accepted[0].source_role, "unspecified");
  }
  for (const speaker of ["顧客", "顧客（山田）", "先方", "お客様"]) {
    assert.deepEqual(groundMinutesProposals(`${speaker}：${quote}`, [candidate(quote)]).proposals, [], speaker);
  }
});

test("past and reported proposals cannot become current offers while present proposals survive", () => {
  for (const quote of [
    "前回は採用動画をご提案しました。",
    "以前、採用動画を提案していました。",
    "他社では動画を使う方法もあるという感想を伺いました。",
    "動画をご提案しますと聞きました。",
  ]) {
    const result = groundMinutesProposals(`営業：${quote}今回は未定です。`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [], quote);
    assert.equal(result.audit.rejected[0].reason, "historical_or_reported");
  }
  const current = "今回は採用動画をご提案します。";
  assert.deepEqual(groundMinutesProposals(`営業：${current}`, [candidate(current)]).proposals, [published(current)]);
  const intended = "今回は採用動画をご提案したいです。";
  assert.deepEqual(groundMinutesProposals(`営業：${intended}`, [candidate(intended)]).proposals, [published(intended)]);
});

test("literal projection preserves option conditions even when generated text drops or invents them", () => {
  const quote = "もし認知の機会が足りないのであれば、SNSで接点を増やす方法も考えられます。ただ、これは営業側の仮説です。";
  const raw = Object.freeze([Object.freeze(candidate(quote, "SNSを導入すれば必ず応募が増える"))]);
  const result = groundMinutesProposals(`営業：${quote}`, raw);
  assert.deepEqual(result.proposals, [published(quote)]);
  assert.equal(result.audit.candidates, raw);
  assert.equal(raw[0].text, "SNSを導入すれば必ず応募が増える");
  assert.doesNotMatch(result.proposals.join("\n"), /必ず応募が増える/);
  assert.deepEqual(result.audit.rejected, []);
});

test("a mixed-role seller turn requires the complete option sentence instead of the factual question", () => {
  const option = "よくある質問を文章で整理する方法もあります。";
  const question = "学生からの質問は担当者同士で共有されていますか。";
  const source = `営業：${option}${question}`;
  const result = groundMinutesProposals(source, [candidate(question), candidate(`${option}${question}`), candidate(option)]);
  assert.deepEqual(result.proposals, [published(option)]);
  assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "factual_question" }, { index: 1, reason: "factual_question" }]);
});

test("only offered-option records with a source cue pass; old provider strings remain audited", () => {
  const quote = "動画をご提案します。";
  const raw = [quote, candidate(quote, "動画の提案", "factual_question"), { text: "動画の提案" }, candidate("本日はお時間をいただきありがとうございます。")];
  const before = structuredClone(raw);
  const result = groundMinutesProposals(`営業：${quote}\n営業：本日はお時間をいただきありがとうございます。`, raw);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.audit.rejected.map((row) => row.reason), ["legacy_string_without_source", "not_offered_option", "invalid_candidate", "no_explicit_option"]);
  assert.deepEqual(raw, before);
  assert.equal(result.audit.candidates, raw);
  assert.deepEqual(groundMinutesProposals(`営業：${quote}`, null).audit.rejected, [{ index: null, reason: "invalid_candidates" }]);
});

test("the transcript alone supplies proposal evidence and accepted duplicate options appear once", () => {
  const quote = "動画をご提案します。";
  const empty = groundMinutesProposals("営業：予算は決まっていますか？\n顧客：未確認です。", [candidate(quote)]);
  assert.deepEqual(empty.proposals, []);
  for (const seller of ["営業", "営業担当者", "当社", "弊社", "売り手"]) {
    const result = groundMinutesProposals(`${seller}：${quote}`, [candidate(quote), candidate(quote)]);
    assert.deepEqual(result.proposals, [published(quote)]);
    assert.equal(result.audit.accepted.length, 2);
  }
});

test("the long fixture retains complete FAQ, video and conditional SNS options", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const quotes = [
    "例えば、よくある質問を文章で整理する方法や、説明会の話す順番を変える方法もあります。",
    "採用動画で一度に説明する方法と、短い情報を分けて発信する方法には、それぞれ向く使い方があると思います。例えば、仕事内容の大きな流れを伝える部分と、社員の話を紹介する部分を分ける考え方もあります。SNS運用代行を使うかも含めて、どんな情報を誰に届けたいかから考えるのがよさそうです。",
    "もし学生に会社を見つけてもらう機会が足りていないのであれば、SNSで接点を増やす方法も考えられます。ただ、これは営業側の仮説です。",
  ];
  const result = groundMinutesProposals(source, quotes.map((quote) => candidate(quote)));
  assert.deepEqual(result.proposals, quotes.map(published));
  assert.deepEqual(result.audit.rejected, []);
});

test("the agreed fixture preserves the complete priced offer and unadopted SNS option from actual provider candidates", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt", import.meta.url), "utf8");
  const quotes = [
    "当社は税込110万円で採用動画を提供できます。内訳は税抜100万円、消費税10万円です。約3分の動画1本、企画、現場での撮影1日、編集、字幕、初稿後の修正1回を含みます。交通費もこの総額に含み、採用サイトと会社説明会で利用できる完成データを納品します。",
    "別の選択肢としてSNS運用代行も紹介します。ただし、今回の採用動画の税込110万円にはSNS運用代行は含まれません。追加の運用が必要であれば、別途検討するサービスです。",
  ];
  const raw = Object.freeze(quotes.map((quote) => Object.freeze(candidate(quote, "両方とも110万円で導入が決定した"))));
  const result = groundMinutesProposals(source, raw);
  assert.deepEqual(result.proposals, quotes.map(published));
  assert.deepEqual(result.audit.rejected, []);
  assert.deepEqual(result.audit.accepted.map((row) => row.source_role), ["seller", "seller"]);
  assert.equal(result.audit.candidates, raw);
  assert.equal(raw[0].text, "両方とも110万円で導入が決定した");
  assert.doesNotMatch(result.proposals.join("\n"), /導入が決定した/);
  // These are seller statements regardless of the customer's later acceptance.
  const sellerOnly = quotes.map((quote) => `営業：${quote}`).join("\n");
  assert.deepEqual(groundMinutesProposals(sellerOnly, raw).proposals, result.proposals);
  assert.deepEqual(groundMinutesProposals(`営業：${quotes[1]}`, [candidate(quotes[1].split("。")[0] + "。")]).proposals, []);
});

test("new current-price and option-introduction cues require an explicit seller role", () => {
  const quotes = [
    "弊社は税抜１，０００，０００円で研修資料を提供します。",
    "選択肢として保守サービスをご紹介いたします。",
  ];
  for (const quote of quotes) {
    for (const speaker of ["営業", "営業担当者", "当社", "弊社", "売り手"]) {
      assert.deepEqual(groundMinutesProposals(`${speaker}：${quote}`, [candidate(quote)]).proposals, [published(quote)], speaker);
    }
    for (const source of [`顧客：${quote}`, `先方：${quote}`, `山田：${quote}`, `話者1：${quote}`, quote]) {
      assert.deepEqual(groundMinutesProposals(source, [candidate(quote)]).proposals, [], source);
    }
  }
});

test("current seller cue additions do not turn requests, questions, negatives, reports or hypotheses into proposals", () => {
  for (const quote of [
    "当社は税込110万円で採用動画を提供できますか。",
    "当社は税込110万円で採用動画を提供してください。",
    "当社は税込110万円で採用動画を提供しません。",
    "当社は税込110万円で採用動画を提供できますという意味ではありません。",
    "当社は税込110万円で採用動画を提供しました。",
    "当社は税込110万円で採用動画を提供できますと聞きました。",
    "他社は『当社は税込110万円で採用動画を提供できます。』と説明しました。",
    "もし条件が整えば当社は税込110万円で採用動画を提供できます。",
    "仮の話です。当社は税込110万円で採用動画を提供できます。",
    "別の選択肢としてSNS運用代行も紹介しますか。",
    "別の選択肢としてSNS運用代行も紹介してください。",
    "別の選択肢としてSNS運用代行も紹介してよろしいでしょうか。",
    "別の選択肢としてSNS運用代行も紹介しません。",
    "別の選択肢としてSNS運用代行も紹介しました。",
    "別の選択肢としてSNS運用代行も紹介しますと聞きました。",
    "仮に依頼があれば別の選択肢としてSNS運用代行も紹介します。",
  ]) {
    assert.deepEqual(groundMinutesProposals(`営業：${quote}`, [candidate(quote)]).proposals, [], quote);
  }
});

test("new seller cues keep actual prices separate from corrected budget conditions", () => {
  const price = "当社は税込110万円で採用動画を提供できます。";
  const correction = "顧客：先ほどの予算110万円は訂正します。現在の目安は120万円です。";
  assert.deepEqual(groundMinutesProposals(`営業：${price}\n${correction}`, [candidate(price)]).proposals, [published(price)]);
  const conditional = "別の選択肢として保守サービスも紹介します。予算110万円を目安とする場合に限ります。";
  const result = groundMinutesProposals(`営業：${conditional}\n${correction}`, [candidate(conditional)]);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "superseded_budget_condition", later_source_quote: correction }]);
  assert.deepEqual(groundMinutesProposals(`営業：${conditional}`, [candidate(conditional)]).proposals, [published(conditional)]);
});

test("an explicit later withdrawal overrides only the new seller option or its same-price offer", () => {
  const price = "当社は税込110万円で採用動画を提供できます。";
  const option = "別の選択肢としてSNS運用代行も紹介します。";
  for (const quote of [
    `${price}訂正します。110万円では提供できません。`,
    `${price}訂正します。1,100,000円では提供できません。`,
    `${option}ただし、この案は撤回します。`,
    `${option}その選択肢を取り下げます。`,
  ]) {
    const result = groundMinutesProposals(`営業：${quote}`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [], quote);
    assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "negated_proposal" }], quote);
  }
  for (const quote of [
    `${price}90万円では提供できません。`,
    `${price}他社は110万円では提供できません。`,
    `${price}110万円では提供できませんか。`,
    `${option}ただし、110万円には含まれません。`,
    `${option}この案は撤回しません。`,
    `${option}この案は撤回しますか。`,
    `${option}この案は撤回する場合があります。`,
    `${option}『この案は撤回します。』という説明はしていません。`,
  ]) {
    assert.deepEqual(groundMinutesProposals(`営業：${quote}`, [candidate(quote)]).proposals, [published(quote)], quote);
  }
});

test("the long fixture omits an old budget-conditioned proposal after an explicit correction", () => {
  const source = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const old = "95万円を仮の目安として、まずは必要な内容を整理しましょう。撮影を伴うか、どのくらい編集するか、使う場所をどうするかで費用は変わります。今日の段階では金額をお約束できないので、範囲が見えたところで見積を検討することになります。";
  const option = "例えば、よくある質問を文章で整理する方法や、説明会の話す順番を変える方法もあります。";
  const raw = Object.freeze([Object.freeze(candidate(old)), Object.freeze(candidate(option))]);
  const result = groundMinutesProposals(source, raw);
  assert.deepEqual(result.proposals, [published(option)]);
  assert.equal(result.audit.candidates, raw);
  assert.equal(result.audit.rejected[0].reason, "superseded_budget_condition");
  assert.match(result.audit.rejected[0].later_source_quote!, /先ほどの95万円という目安は訂正します/);
  assert.equal(raw[0].source_quote, old);
  assert.doesNotMatch(result.proposals.join("\n"), /95万円|150万円/);
});

test("explicit corrections link equivalent monetary forms without synthesizing a replacement", () => {
  for (const [amount, corrected, predicate] of [
    ["80万円", "８０万円", "訂正します"],
    ["100万円", "1,000,000円", "120万円に変更しました"],
    ["0.2億円", "2000万円", "誤りでした"],
    ["250千円", "25万円", "訂正前の数字として扱ってください"],
  ]) {
    const quote = `予算${amount}を目安に動画を提案します。`;
    const correction = `顧客：先ほどの予算${corrected}は${predicate}。`;
    const result = groundMinutesProposals(`営業：${quote}\n${correction}`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [], correction);
    assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "superseded_budget_condition", later_source_quote: correction }]);
  }
});

test("unrelated prices, reports, non-corrections and ambiguous speakers do not supersede a budget condition", () => {
  const quote = "80万円を仮の目安として、内容を整理しましょう。";
  for (const later of [
    "顧客：予算90万円は訂正します。",
    "顧客：動画の見積80万円は訂正します。",
    "顧客：別会社の予算80万円は訂正します。",
    "顧客：予算80万円は訂正しません。",
    "顧客：予算80万円は訂正しますか？",
    "顧客：予算80万円を訂正するなら再度お知らせします。",
    "顧客：もし予算80万円を訂正する場合は相談します。",
    "顧客：予算80万円を訂正すると聞きました。",
    "顧客：他社では『予算80万円を訂正します』とのことです。",
    "顧客：予算80万円は訂正しますという意味ではありません。",
    "顧客：別の動画の価格は120万円です。",
    "顧客：予算担当者は撤回します。予算は未定です。",
    "営業：予算80万円は訂正します。",
    "田中：予算80万円は訂正します。",
    "顧客：はい。田中：予算80万円は訂正します。",
  ]) {
    const result = groundMinutesProposals(`営業：${quote}\n${later}`, [candidate(quote)]);
    assert.deepEqual(result.proposals, [published(quote)], later);
  }
  const price = "動画は80万円でご提案します。";
  assert.deepEqual(groundMinutesProposals(`営業：${price}\n顧客：予算80万円は訂正します。`, [candidate(price)]).proposals, [published(price)]);
});

test("later field withdrawal reuses the customer withdrawal guard without changing unrelated options", () => {
  const quote = "予算80万円を目安に動画を提案します。";
  const neutral = "よくある質問を整理する方法もあります。";
  const withdrawal = "顧客：予算を撤回します。現在の予算は未定です。";
  const result = groundMinutesProposals(`営業：${quote}\n営業：${neutral}\n${withdrawal}`, [candidate(quote), candidate(neutral)]);
  assert.deepEqual(result.proposals, [published(neutral)]);
  assert.deepEqual(result.audit.rejected, [{ index: 0, reason: "superseded_budget_condition", later_source_quote: withdrawal }]);
  const hypothetical = "顧客：予算を撤回する場合は連絡します。現在の予算は未定です。";
  assert.deepEqual(groundMinutesProposals(`営業：${quote}\n${hypothetical}`, [candidate(quote)]).proposals, [published(quote)]);
});

test("correction chronology preserves explicit later proposals, including literal re-presentations", () => {
  const old = "80万円を仮の目安として、内容を整理しましょう。";
  const current = "120万円を仮の目安として、内容を整理しましょう。";
  const correction = "顧客：先ほどの80万円という目安は訂正します。今は120万円が目安です。";
  const result = groundMinutesProposals(`営業：${old}\n${correction}\n営業：${current}`, [candidate(old), candidate(current)]);
  assert.deepEqual(result.proposals, [published(current)]);
  assert.deepEqual(groundMinutesProposals(`${correction}\n営業：${old}`, [candidate(old)]).proposals, [published(old)]);
  const repeat = `営業：${old}\n${correction}\n顧客：再確認した結果、現在の目安は80万円です。\n営業：${old}`;
  assert.deepEqual(groundMinutesProposals(repeat, [candidate(old)]).proposals, [published(old)]);
});

test("candidate and total quote limits reject complete rows without truncating source sentences", () => {
  const quote = "動画をご提案します。";
  const repeated = groundMinutesProposals(`営業：${quote}`, Array.from({ length: 7 }, () => candidate(quote)));
  assert.equal(repeated.audit.accepted.length, 6);
  assert.deepEqual(repeated.audit.rejected, [{ index: 6, reason: "limit_exceeded" }]);
  const first = `${"条件を整理する。".repeat(65)}${quote}`;
  const second = first.replace("動画", "資料");
  const result = groundMinutesProposals(`営業：${first}\n営業：${second}`, [candidate(first), candidate(second)]);
  assert.deepEqual(result.proposals, [published(first)]);
  assert.deepEqual(result.audit.rejected, [{ index: 1, reason: "source_quote_budget_exceeded" }]);
});

test("a proposal quote prefixed with its own speaker label is matched without the label; another speaker's label is not", () => {
  const option = "採用動画を1本制作してみてはいかがでしょうか。";
  const source = `顧客：説明会の動画を検討しています。\n営業：${option}`;
  const own = groundMinutesProposals(source, [candidate(`営業：${option}`)]);
  assert.deepEqual(own.proposals, [published(option)]);
  assert.equal(own.audit.accepted[0].source_quote, option);
  for (const quote of [`顧客：${option}`, `当社：${option}`]) {
    const other = groundMinutesProposals(source, [candidate(quote)]);
    assert.deepEqual(other.proposals, [], quote);
    assert.deepEqual(other.audit.rejected, [{ index: 0, reason: "source_not_literal_eligible_sentences" }], quote);
  }
});

test("a proposal line starting with a clock time is not split into a speaker label", () => {
  for (const line of ["14:00からの説明会で採用動画を流してみてはいかがでしょうか。", "午後2：00からの説明会で採用動画を流してみてはいかがでしょうか。"]) {
    const result = groundMinutesProposals(`営業：本日はありがとうございます。\n${line}`, [candidate(line)]);
    assert.ok(result.proposals.every(text => text.includes(line)), line);
    assert.ok(!result.proposals.some(text => /：00から/u.test(text)), line);
  }
});
