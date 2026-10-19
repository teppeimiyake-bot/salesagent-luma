import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { groundIssueEvidence, readSourceEvidenceBlocks } from "../src/lib/ai/issue-evidence";
import { timelineSourceTurns } from "../src/lib/ai/timeline-evidence";

/** 公開する課題の文：原文の発言から先頭の話者ラベルだけを除いた本文（改行は LF にそろう）。 */
const spoken = (sourceText: string) => sourceText.replace(/^\s*[^:：。！？!?\n]{1,40}\s*[:：]\s*/u, "").replace(/\r\n/gu, "\n").trim();

test("long source projections preserve email-only deficiency and the recipient particle literally", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const selected = [15, 17];
  const before = [...selected];
  const result = groundIssueEvidence(transcript, selected);
  const turns = timelineSourceTurns(transcript);
  assert.deepEqual(result.issues, selected.map((id) => spoken(turns[id - 1].text)));
  assert.match(result.issues[0], /メールには応募手続きの案内を載せていますが、仕事内容を詳しく説明する文章はあまり入っていません/);
  assert.match(result.issues[0], /利用状況を把握しているとは言えません/);
  assert.doesNotMatch(result.issues[0], /採用サイトや案内メールに仕事内容/);
  assert.match(result.issues[1], /学生に会社をよく見せることだけではありません/);
  assert.doesNotMatch(result.issues[1], /学生が会社をよく見せる/);
  assert.deepEqual(selected, before);
  assert.equal(result.audit.requestedSourceIds, selected);
  assert.deepEqual(result.audit.rejected, []);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceRole), ["customer", "customer"]);
});

test("whole-turn extraction cannot omit qualifiers, negatives, uncertainty or original spacing", () => {
  const turn = "  お客様：資料は手元にありません。別の紹介動画があるかは分かりません。導入するなら来年を希望します。ただし、正式決定ではありません。  ";
  const transcript = `営業：何が必要ですか？\r\n\r\n${turn}`;
  const result = groundIssueEvidence(transcript, [2]);
  assert.equal(result.issues[0], spoken(turn));
  assert.equal(result.audit.accepted[0].sourceText, turn);
});

test("references require exact valid numeric IDs and duplicate requests are audited", () => {
  const transcript = "顧客：説明が伝わりにくいです。\n\n顧客：現場撮影の可否は未確認です。";
  const result = groundIssueEvidence(transcript, [1, "2", 0, -1, 1.5, 3, null, true, 1, 2]);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceId), [1, 2]);
  assert.deepEqual(result.audit.rejected.map((entry) => entry.reason), [
    "invalid_source_id", "invalid_source_id", "invalid_source_id", "invalid_source_id",
    "invalid_source_id", "invalid_source_id", "invalid_source_id", "duplicate_source_id",
  ]);
  for (const missing of [undefined, null, "1", { issues: ["原文にない課題"] }]) {
    const absent = groundIssueEvidence(transcript, missing);
    assert.deepEqual(absent.issues, []);
    assert.equal(absent.audit.rejected[0].reason, "invalid_source_ids");
  }
  assert.deepEqual(groundIssueEvidence(transcript, []).issues, []);
});

test("explicit seller statements and question-only turns are not customer evidence", () => {
  const lines = [
    "営業：説明不足が課題かもしれません。",
    "当社：説明不足が課題です。",
    "弊社：説明不足が課題です。",
    "営業担当者：資料不足ではありませんか？",
    "顧客：資料はありますか？",
    "先方：はい。資料はありますか。共有されていますか。",
    "顧客：現場を撮影できるかは未確認です。",
    "顧客：学生から「自分は何を担当しますか？」と聞かれました。説明が不足していると感じます。",
  ];
  const result = groundIssueEvidence(lines.join("\n"), lines.map((_, index) => index + 1));
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceId), [7, 8]);
  assert.deepEqual(result.audit.rejected.map((entry) => entry.reason), [
    "seller_turn", "seller_turn", "seller_turn", "seller_turn", "question_only", "question_only",
  ]);
});

test("unknown speaker labels keep neutral attribution and mixed turns are rejected", () => {
  const lines = [
    "田中：説明が不足しています。",
    "話者1：承認はまだ取れていません。",
    "説明資料はありません。",
    "顧客：説明が不足しています。 営業：そうですか。",
    "話者2：確認しました。田中：課題があります。",
    "顧客：面談は10:00開始を希望します。",
  ];
  const result = groundIssueEvidence(lines.join("\n\n"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceId), [1, 2, 3, 6]);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceRole), ["unspecified", "unspecified", "unspecified", "customer"]);
  // 役割の分からない話者は監査の sourceRole で区別し、公開文には前置きを付けない。
  assert.deepEqual(result.issues.slice(0, 3), ["説明が不足しています。", "承認はまだ取れていません。", "説明資料はありません。"]);
  assert.deepEqual(result.audit.rejected.map((entry) => entry.reason), ["ambiguous_speakers", "ambiguous_speakers"]);
});

test("numeric mixed speakers are rejected without confusing a clock time for a speaker", () => {
  const transcript = [
    "顧客：ありがとうございます。話者2：説明不足が課題だと思います。",
    "先方：はい。speaker 2: Materials are missing.",
    "顧客：面談は10:00開始を希望します。",
    "山田（営業）：説明不足が課題かもしれません。",
  ].join("\n");
  const result = groundIssueEvidence(transcript, [1, 2, 3, 4]);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceId), [3]);
  assert.deepEqual(result.audit.rejected.map((entry) => entry.reason), ["ambiguous_speakers", "ambiguous_speakers", "seller_turn"]);
});

test("requested order remains auditable while source chronology keeps corrections after old statements", () => {
  const before = "顧客：資料はありません。";
  const after = "顧客：先ほどの発言は訂正します。資料はあります。";
  const requested = [2, 1];
  const result = groundIssueEvidence(`${before}\n${after}`, requested);
  assert.deepEqual(result.audit.requestedSourceIds, [2, 1]);
  assert.deepEqual(requested, [2, 1]);
  assert.deepEqual(result.audit.accepted.map((entry) => entry.sourceId), [1, 2]);
  assert.deepEqual(result.issues, [spoken(before), spoken(after)]);
});

test("unlabeled continuation caveats stay with their labelled turn and cannot change speaker attribution", () => {
  const customerTurn = "顧客：応募数不足が課題です。\r\n  というのは以前の状況で、今は解消しています。";
  const transcript = `${customerTurn}\r\n営業：資料不足が課題かもしれません。\r\nこれは営業側の仮説です。`;
  for (const sourceId of [1, 2]) {
    const result = groundIssueEvidence(transcript, [sourceId]);
    assert.deepEqual(result.issues, [spoken(customerTurn)]);
    assert.deepEqual(result.audit.accepted[0].sourceIds, [1, 2]);
    assert.deepEqual(result.audit.accepted[0].contextSourceIds, [sourceId === 1 ? 2 : 1]);
  }
  const duplicates = groundIssueEvidence(transcript, [2, 1, 3, 4]);
  assert.equal(duplicates.issues.length, 1);
  assert.deepEqual(duplicates.audit.rejected.map((entry) => entry.reason), ["duplicate_source_turn", "seller_turn", "seller_turn"]);
});

test("a blank line delimits unattributed passages and oversized continuation context is never truncated", () => {
  const transcript = "営業：資料不足が課題かもしれません。\n\n資料の状況は分かりません。";
  const neutral = groundIssueEvidence(transcript, [2]);
  assert.equal(neutral.audit.accepted[0].sourceRole, "unspecified");
  const oversized = `顧客：応募数不足が課題です。\n${"あ".repeat(2400)}ただし、以前の状況です。`;
  const result = groundIssueEvidence(oversized, [1]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.audit.rejected[0].reason, "source_character_budget_exceeded");
});

test("eight accepted turns are capped independently of rejected requests", () => {
  const lines = ["営業：課題はありますか？", ...Array.from({ length: 9 }, (_, index) => `顧客：確認事項${index + 1}は未確認です。`)];
  const result = groundIssueEvidence(lines.join("\n"), lines.map((_, index) => index + 1));
  assert.equal(result.issues.length, 8);
  assert.deepEqual(result.audit.rejected.map((entry) => entry.reason), ["seller_turn", "turn_limit_exceeded"]);
});

test("character budget skips oversized complete turns without truncation or blocking smaller turns", () => {
  const large = `顧客：${"未確認の事項。".repeat(350)}ただし、確定ではありません。`;
  const small = "顧客：説明資料は手元にありません。";
  const result = groundIssueEvidence(`${large}\n${small}`, [1, 2]);
  assert.deepEqual(result.issues, [spoken(small)]);
  assert.equal(result.audit.rejected[0].reason, "source_character_budget_exceeded");
  const medium = `顧客：${"あ".repeat(1198)}。`;
  const aggregate = groundIssueEvidence(`${medium}\n${medium}\n${small}`, [1, 2, 3]);
  assert.deepEqual(aggregate.audit.accepted.map((entry) => entry.sourceId), [1, 3]);
  assert.equal(aggregate.issues[0], spoken(medium));
  assert.equal(aggregate.audit.rejected[0].reason, "source_character_budget_exceeded");
});

test("generic source blocks retain all roles and questions without inferring the speaker from content", () => {
  const lines = [
    "営業：採用サイトを比較するとよさそうです。",
    "顧客：比較できますか？",
    "田中：当社の課題は説明不足です。",
    "話者2：提案してもよろしいですか？",
    "山田（営業）：予算はいくらですか？",
    "鈴木（顧客）：未確認です。",
    "資料の状況は分かりません。",
    "顧客：",
  ];
  const transcript = lines.join("\n\n");
  const blocks = readSourceEvidenceBlocks(transcript);
  assert.deepEqual([...blocks.keys()], timelineSourceTurns(transcript).map(({ id }) => id));
  assert.deepEqual([...blocks.values()].map(({ sourceRole }) => sourceRole), ["seller", "customer", "unspecified", "unspecified", "seller", "customer", "unspecified", "customer"]);
  assert.deepEqual([...blocks.values()].map(({ sourceText }) => sourceText), lines);
  assert.equal(blocks.get(3)!.speaker, "田中");
  assert.equal(blocks.get(7)!.speaker, undefined);
  assert.equal(blocks.get(8)!.body, "");
  assert.equal(blocks.get(99), undefined);
  assert.deepEqual([...readSourceEvidenceBlocks("\r\n \n")], []);
  // This broader read API does not broaden issue acceptance.
  assert.deepEqual(groundIssueEvidence(transcript, [1, 2, 5, 8]).audit.rejected.map(({ reason }) => reason), ["seller_turn", "question_only", "seller_turn", "empty_turn"]);
});

test("generic source references preserve complete CRLF blocks and shared identity for continuation IDs", () => {
  const customer = "  顧客：予算は80万円です。  \r\n  ただし、社内承認はまだありません。  ";
  const seller = "営業：説明内容を整理しましょう。\r\n  方法は未定です。";
  const neutral = "担当は不明です。\r\n条件もまだ決めていません。";
  const transcript = `${customer}\r\n${seller}\r\n\r\n${neutral}`;
  const blocks = readSourceEvidenceBlocks(transcript);
  for (const [first, second, sourceText, role] of [[1, 2, customer, "customer"], [3, 4, seller, "seller"], [5, 6, neutral, "unspecified"]] as const) {
    assert.equal(blocks.get(first), blocks.get(second));
    assert.deepEqual(blocks.get(first)!.sourceIds, [first, second]);
    assert.equal(blocks.get(first)!.sourceText, sourceText);
    assert.equal(blocks.get(first)!.sourceRole, role);
    assert.equal(blocks.get(first)!.ambiguousSpeakers, false);
  }
  assert.notEqual(blocks.get(2), blocks.get(3));
  assert.notEqual(blocks.get(4), blocks.get(5));
  assert.deepEqual(groundIssueEvidence(transcript, [2]).issues, [spoken(customer)]);
});

test("generic source blocks flag mixed speakers with the same rules while retaining literal clock times", () => {
  const lines = [
    "顧客：確認しました。営業：資料を作成します。",
    "営業：確認しました。田中：資料がありません。",
    "顧客：確認しました。話者2：資料がありません。",
    "田中：Confirmed. speaker 2: Materials are missing.",
    "顧客：面談は10:00開始を希望します。",
  ];
  const blocks = readSourceEvidenceBlocks(lines.join("\n"));
  assert.deepEqual([...blocks.values()].map(({ ambiguousSpeakers }) => ambiguousSpeakers), [true, true, true, true, false]);
  assert.deepEqual([...blocks.values()].map(({ sourceText }) => sourceText), lines);
  assert.equal(blocks.get(1)!.sourceRole, "customer");
  assert.equal(blocks.get(2)!.sourceRole, "seller");
  assert.equal(blocks.get(4)!.sourceRole, "unspecified");
});

// T18 C3/C6/C7（2026-10-01 再実行）: 議事録「顧客の課題」に予算・時期・決裁者だけの発言が並んだ。
test("minutes issue projection rejects turns that only state budget, timing, authority or the meeting stage", () => {
  const c3 = [
    "営業：制作予算は決まっていますか？",
    "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。",
    "営業：導入することは決まりましたか？",
    "顧客：導入はまだ決めていません。今日は情報交換です。",
    "顧客：導入はまだ決めていませんが、導入するなら2027年4月を希望します。正式な時期は未確定です。",
    "顧客：予算は180万円が上限です。",
    "顧客：決済は工場長の石田が行います。",
  ].join("\n");
  const result = groundIssueEvidence(c3, [2, 4, 5, 6, 7], { excludeBantOnly: true });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.audit.rejected.map(({ reason }) => reason), Array(5).fill("bant_only"));
  // 既定（推論の issues）では従来どおり選択された発言を保持する。
  assert.equal(groundIssueEvidence(c3, [2, 4, 5], {}).issues.length, 3);
  assert.equal(groundIssueEvidence(c3, [2, 4, 5]).issues.length, 3);

  // 評価語の無い BANT の事実だけの定型の発言（許可リスト）だけを除く。
  const formulaic = [
    "顧客：予算は180万円を上限に考えています。",
    "顧客：決済は工場長の石田です。",
    "顧客：前回の80万円という予算と2027年4月の導入希望は撤回します。現在、予算と導入時期は未定です。",
    "顧客：導入するかどうかも決めていません。",
    "顧客：最新の検討上の目安は150万円です。正式な社内承認はまだ取れていません。",
    "顧客：まず上長に相談する予定です。",
    "顧客：本日は情報収集です。",
  ];
  const rejected = groundIssueEvidence(formulaic.join("\n"), formulaic.map((_, index) => index + 1), { excludeBantOnly: true });
  assert.deepEqual(rejected.issues, []);
  assert.deepEqual(rejected.audit.rejected.map(({ reason }) => reason), Array(formulaic.length).fill("bant_only"));
});

test("minutes issue projection keeps real problems, wants and mixed turns as complete source turns", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt", import.meta.url), "utf8");
  const turns = timelineSourceTurns(transcript);
  // 4・7 は課題、15・17 は不足・希望、35 は費用の中の困りごと、39 は運用の懸念、47 は時期と希望が混在した発言。
  const selected = [4, 7, 15, 17, 35, 39, 47];
  const long = groundIssueEvidence(transcript, selected, { excludeBantOnly: true });
  assert.deepEqual(long.audit.rejected, []);
  assert.deepEqual(long.issues, selected.map((id) => spoken(turns[id - 1].text)));

  const agreed = readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt", import.meta.url), "utf8");
  const mixed = timelineSourceTurns(agreed).find(({ text }) => text.includes("質問が繰り返し届いています"))!;
  assert.deepEqual(groundIssueEvidence(agreed, [mixed.id], { excludeBantOnly: true }).issues, [spoken(mixed.text)]);

  const others = [
    "顧客：前回の80万円という予算と2027年4月の導入希望は撤回します。現在、予算と導入時期は未定です。新卒採用の応募数不足という課題は引き続きあります。",
    "顧客：採用動画を導入したいです。",
    "顧客：予算が足りないことが悩みです。",
    "顧客：工場見学の申し込みがここ2年で半分ほどに減っています。",
    "顧客：試作品置き場は撮影できません。",
  ];
  const kept = groundIssueEvidence(others.join("\n"), [1, 2, 3, 4, 5], { excludeBantOnly: true });
  assert.deepEqual(kept.audit.rejected, []);
  assert.deepEqual(kept.issues, others.map((turn) => spoken(turn)));
});

// 独立レビュー（2026-10-01）: BANT の話題語を含むだけで、本当の課題・希望まで除いていた。
test("minutes issue projection keeps problems and wants that mention budget, timing or authority words", () => {
  const turns = [
    "決裁に時間がかかるんです。",
    "費用が高いと社内で言われています。",
    "納期が厳しくて。",
    "上長の承認がなかなか通らない。",
    "4月から新卒が入るので研修を増やしたい。",
    "スケジュールがタイトです。",
    "今の契約が3月で切れるので乗り換えを検討しています。",
    "稼働率が低い。",
    "予算は年度内に使い切る必要があります。",
    "見積を取って比較したいと思っています。",
    "来年3月の学校訪問に間に合わせたいです。",
    "予算は100万円以内に抑えたいです。",
    "導入するなら4月がいいのですが、現場の負担が心配です。",
  ].map((turn) => `顧客：${turn}`);
  // 1回に選べるのは8件までなので、1件ずつ確かめる。
  for (const turn of turns) {
    const kept = groundIssueEvidence(`営業：状況を教えてください。\n${turn}`, [2], { excludeBantOnly: true });
    assert.deepEqual(kept.audit.rejected, [], turn);
    assert.deepEqual(kept.issues, [spoken(turn)]);
  }
});

test("T04: an unattributed multi-line passage is not merged; questions and seller offers inside it are not issues", () => {
  // Long-recording segment output with the speaker labels missing for several lines (2026-10-01 60-minute check).
  const transcript = [
    "話者2: よろしくお願いします。",
    "",
    "テーマの区切りを作って、長さの目安をつけておきます。",
    "動画の見せ方ですが、1本の長さについてご希望はありますか?",
    "テーマごとに3分から5分にしたいです。",
    "休憩の時間に1本ずつ見られるようにします。",
    "パートやアルバイトの方の入れ替わりが多くて、衛生の教育がどうしても現場任せになっています。",
  ].join("\n");
  const offer = groundIssueEvidence(transcript, [2], { excludeBantOnly: true });
  assert.deepEqual(offer.issues, []);
  assert.equal(offer.audit.rejected[0].reason, "seller_offer");
  const question = groundIssueEvidence(transcript, [3], { excludeBantOnly: true });
  assert.deepEqual(question.issues, []);
  assert.equal(question.audit.rejected[0].reason, "question_only");
  // The real problem is kept, as its own line only (no neighbouring Q&A or offers).
  const issue = groundIssueEvidence(transcript, [6, 4], { excludeBantOnly: true });
  assert.deepEqual(issue.issues, [
    "テーマごとに3分から5分にしたいです。",
    "パートやアルバイトの方の入れ替わりが多くて、衛生の教育がどうしても現場任せになっています。",
  ]);
  assert.deepEqual(issue.audit.accepted.map((entry) => entry.sourceIds), [[4], [6]]);
  assert.deepEqual(issue.audit.accepted.map((entry) => entry.contextSourceIds), [[], []]);
});

test("T04: an unattributed problem statement is kept even when it uses polite or action wording", () => {
  for (const line of [
    "教え方が人によってバラバラで、新人が戸惑っています。",
    "外国籍のスタッフには日本語の説明だけでは伝わりにくいことがあります。",
    "毎年、口頭で説明していますが、内容がばらばらになります。",
    "外国籍のスタッフ向けに、やさしい日本語の字幕もお願いします。",
  ]) {
    const transcript = `話者1: 現状を教えてください。\n\n${line}\n続けて別の話です。`;
    const result = groundIssueEvidence(transcript, [2], { excludeBantOnly: true });
    assert.deepEqual(result.issues, [spoken(line)], line);
  }
});

// UI確認 2026-10-01（edge-02）：議事録「顧客の課題」と右側の「課題」の各行に「発言（話者の役割未確認・原文）: 話者2:」が付いて読みにくかった。
// 前置きは groundIssueEvidence が公開文（issues）を組み立てる時点で付き、そのまま minutes_json.customer_issues・meetings.issues・
// 議事録 Markdown に保存されていた。画面に出す課題の文は発言の本文だけにし、話者ラベル付きの原文と話者の役割は監査（audit.accepted）に残す。
test("public issue text is the spoken body only; label, speaker and role stay in the audit", () => {
  const transcript = [
    "話者1: 早速ですが会社紹介動画のご相談について、今の課題を伺えますか。",
    "話者2: 工場見学の申し込みが、ここ2年で半分ほどに減っています。",
    "顧客：ホームページの写真だけでは、職場の雰囲気が伝わらないと言われます。",
  ].join("\n");
  const result = groundIssueEvidence(transcript, [2, 3]);
  assert.deepEqual(result.issues, [
    "工場見学の申し込みが、ここ2年で半分ほどに減っています。",
    "ホームページの写真だけでは、職場の雰囲気が伝わらないと言われます。",
  ]);
  for (const issue of result.issues) assert.doesNotMatch(issue, /原文|役割未確認|話者\d|顧客[:：]|^[^。]{1,40}[:：]/u);
  assert.deepEqual(result.audit.accepted.map(({ sourceText, sourceRole, publicText }) => ({ sourceText, sourceRole, publicText })), [
    { sourceText: "話者2: 工場見学の申し込みが、ここ2年で半分ほどに減っています。", sourceRole: "unspecified", publicText: result.issues[0] },
    { sourceText: "顧客：ホームページの写真だけでは、職場の雰囲気が伝わらないと言われます。", sourceRole: "customer", publicText: result.issues[1] },
  ]);
});
