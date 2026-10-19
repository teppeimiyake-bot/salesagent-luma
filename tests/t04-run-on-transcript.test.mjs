// T04/T03: 区間に分けない短い録音の文字起こしが改行なしの1行（全発話が続けて書かれた形）で返された・保存された場合に、
// 議事録の課題・対応予定、会議の BANT のニーズの根拠が全部落ちないこと。根拠照合は1行を1発話として扱い、
// 話者ラベルが2つ以上ある行を「話者が混ざった行」として採らない。実物の判定モジュールと、AI を差し替えた
// パイプラインで確かめる。AI・DB・Vertex は使わない。
import test from "node:test";
import assert from "node:assert/strict";
import timelineEvidence from "../src/lib/ai/timeline-evidence.ts";
import issueEvidence from "../src/lib/ai/issue-evidence.ts";
import needEvidence from "../src/lib/ai/need-evidence.ts";
import minutesActionEvidence from "../src/lib/ai/minutes-action-evidence.ts";
import minutesProposalEvidence from "../src/lib/ai/minutes-proposal-evidence.ts";
import { offlineModule } from "./helpers/offline-module.mjs";

const { splitRunOnSpeakerTurns, timelineSourceTurns, groundTimeline } = timelineEvidence;
const { groundIssueEvidence } = issueEvidence;
const { groundNeedEvidence } = needEvidence;
const { groundMinutesActions } = minutesActionEvidence;
const { groundMinutesProposals } = minutesProposalEvidence;

// 2026-09-30 のクラウド確認（マイク録音 2:30、direct モード）の架空の対面商談の台本を、文字起こしの話者ラベルで書いたもの。
const TURNS = [
  "話者1: 本日はご来社いただき、ありがとうございます。ルマの佐藤が担当します。",
  "話者2: 水奈良正規、総務部の森田です。今日は対面でよろしくお願いします。",
  "話者1: さっそくですが、会社紹介動画のご相談について、いまの課題を伺えますか。",
  "話者2: はい。工場見学の申し込みが、ここ2年で半分ほどに減っています。ホームページの写真だけでは、職場の雰囲気が伝わらないと言われます。",
  "話者1: 撮影は、工場のラインと社員インタビューを中心に進める方法を試してみてはいかがでしょうか。",
  "話者2: 予算は、180万円を上限に考えています。",
  "話者2: 決裁は、工場長の石田です。私が比較した資料を石田に上げて決めます。",
  "話者2: 導入するなら、来年3月に動画を公開したいです。",
  "話者1: では、来週の金曜日までに、構成案と見積書をお送りします。",
  "話者2: はい、11月5日の10時で大丈夫です。",
];
const ISSUE = TURNS[3];
const OPTION = "撮影は、工場のラインと社員インタビューを中心に進める方法を試してみてはいかがでしょうか。";
const ACTION = "では、来週の金曜日までに、構成案と見積書をお送りします。";
const id = (turn) => TURNS.indexOf(turn) + 1;

for (const [name, separator] of [["space", " "], ["no separator", ""], ["ideographic space", "　"]]) {
  const oneLine = TURNS.join(separator);

  test(`reproduction (${name}): a one-line transcript loses every grounded minutes/BANT item`, () => {
    assert.equal(timelineSourceTurns(oneLine).length, 1);
    assert.deepEqual(groundIssueEvidence(oneLine, [1]).audit.rejected.map(({ reason }) => reason), ["ambiguous_speakers"]);
    assert.equal(groundNeedEvidence(oneLine, [1]).basis, "no_valid_source");
    assert.deepEqual(groundTimeline(oneLine, [1]).sourceIds, []);
    assert.deepEqual(groundMinutesActions(oneLine, [{ action: "送付", owner: "話者1", due: "来週の金曜日", source_quote: ACTION }]).next_actions, []);
    assert.deepEqual(groundMinutesProposals(oneLine, [{ text: "撮影案", source_quote: OPTION, speech_act: "offered_option" }]).proposals, []);
  });

  test(`speaker-label split (${name}): one utterance per line, literal text, idempotent`, () => {
    const split = splitRunOnSpeakerTurns(oneLine);
    assert.equal(split, TURNS.join("\n"));
    assert.equal(splitRunOnSpeakerTurns(split), split);
    // Every line is a literal substring of the stored one-line transcript (only separators between turns are removed).
    assert.ok(split.split("\n").every((line) => oneLine.includes(line)));
    assert.deepEqual(groundIssueEvidence(split, [id(ISSUE)]).issues, [ISSUE.replace(/^話者2: /u, "")]);
    assert.equal(groundNeedEvidence(split, [id(ISSUE)]).value, `文字起こし記載: ${ISSUE}`);
    // The timeline keeps the contiguous turns of the same labelled speaker as context (existing rule), never the other speaker.
    const timeline = groundTimeline(split, [id(TURNS[7])]);
    assert.deepEqual(timeline.sourceIds, [6, 7, 8]);
    assert.equal(timeline.value, `文字起こし記載: ${TURNS.slice(5, 8).join("\n")}`);
    assert.deepEqual(groundMinutesActions(split, [{ action: "送付", owner: "話者1", due: "来週の金曜日", source_quote: ACTION }]).next_actions.map(({ action }) => action), [ACTION]);
    assert.equal(groundMinutesProposals(split, [{ text: "撮影案", source_quote: OPTION, speech_act: "offered_option" }]).proposals.length, 1);
  });
}

test("the split does not relax evidence: unlabelled text, mid-sentence labels and field labels stay as they were", () => {
  const unchanged = [
    // No speaker labels at all: roles would have to be guessed, so the line is not split by sentence.
    "本日はありがとうございます。工場見学の申し込みが減っています。来週の金曜日までに見積書をお送りします。",
    // A label glued into a sentence (no sentence end or space before it) is not a safe boundary.
    "話者1: 担当は営業：佐藤です。",
    // Field labels and clock times are not speaker labels.
    "話者2: 理由：写真だけでは伝わらないためです。 開始は 10:00 からです。",
    // A single labelled turn, an indented continuation and blank lines keep their layout.
    "顧客：新卒採用の応募数不\n  足が課題です。\n\n営業：分かりました。\r\n顧客：はい。\r",
  ];
  for (const text of unchanged) assert.equal(splitRunOnSpeakerTurns(text), text);
  // Mixed seller/customer turns become separately labelled lines; the seller turn is still rejected as a seller turn.
  const mixed = "営業：課題を教えてください。 顧客：応募数が不足していることが課題です。";
  const split = splitRunOnSpeakerTurns(mixed);
  assert.equal(split, "営業：課題を教えてください。\n顧客：応募数が不足していることが課題です。");
  assert.deepEqual(groundIssueEvidence(split, [1, 2]).audit.rejected.map(({ reason }) => reason), ["seller_turn"]);
  assert.deepEqual(groundIssueEvidence(split, [1, 2]).issues, ["応募数が不足していることが課題です。"]);
  // Speaker labels with a role in parentheses and full-width digits are split as well.
  assert.equal(splitRunOnSpeakerTurns("話者１（営業）：ご予算は？ 話者２（顧客）：未定です。"), "話者１（営業）：ご予算は？\n話者２（顧客）：未定です。");
});

test("a time before a speaker label moves with the label; a leading time is never split off", () => {
  const cases = [
    ["[00:01] 話者1: こんにちは。 [00:05] 話者2: 予算は未定です。", "[00:01] 話者1: こんにちは。\n[00:05] 話者2: 予算は未定です。"],
    ["［0:01］話者1：こんにちは。［0:05］話者2：予算は未定です。", "［0:01］話者1：こんにちは。\n［0:05］話者2：予算は未定です。"],
    ["[1:00:01] 話者1: はい。 00:05 話者2: 未定です。", "[1:00:01] 話者1: はい。\n00:05 話者2: 未定です。"],
  ];
  for (const [input, expected] of cases) {
    const split = splitRunOnSpeakerTurns(input);
    assert.equal(split, expected);
    assert.equal(splitRunOnSpeakerTurns(split), split);
    // No line consists of a time only, so no time fragment can be selected as an unattributed statement.
    assert.ok(split.split("\n").every((line) => /話者[12][:：]/u.test(line)));
    // Grounding sees exactly what a line-per-utterance timed transcript gives (timed lines stay subject to the existing rules).
    assert.deepEqual(groundIssueEvidence(split, [1, 2]), groundIssueEvidence(expected, [1, 2]));
    assert.ok(groundIssueEvidence(split, [1, 2]).issues.every((issue) => !/:\s*[\[［]?[0-9]{1,2}:[0-9]{2}[\]］]?\s*$/u.test(issue)));
  }
});

test("a line whose head has no speaker label is not split: the head is not promoted to an unattributed statement", () => {
  // Before the split existed the whole mixed line was rejected; an unlabelled head could be the seller's or the customer's
  // words, and a separate unlabelled line would be read as a continuation of the previous speaker. Keep it rejected.
  for (const line of ["人手不足が課題です。 営業：承知しました。", "こんにちは。 話者2: 予算は未定です。 話者1: 承知しました。"]) {
    assert.equal(splitRunOnSpeakerTurns(line), line);
    assert.deepEqual(groundIssueEvidence(line, [1]).issues, []);
    assert.deepEqual(groundIssueEvidence(`顧客：採用の相談です。\n${line}`, [2]).issues, []);
  }
  // A time before the first label is still a labelled head.
  assert.equal(splitRunOnSpeakerTurns("  [00:01] 営業：課題は？ 顧客：人手不足です。"), "  [00:01] 営業：課題は？\n顧客：人手不足です。");
});

async function pipelineHarness() {
  const mocks = { prompts: [], heavyReply: null };
  const entry = "src/lib/ai/pipeline.ts";
  const pipeline = await offlineModule(entry, mocks, {
    "./anthropic": "export const callClaudeHeavyJSON=async p=>{mocks.prompts.push(p);return mocks.heavyReply};export const callClaudeJSON=async()=>null;export const tryParseJSON=JSON.parse;",
    "./provider": "export const hasAiTextKey=()=>false;",
  }, [entry, ...["fewshot", "bant-definitions", "bant-withdrawal", "bant-reconciliation", "timeline-evidence", "customer-conditions", "offer-evidence", "strategy-text", "minutes-proposal-evidence", "action-outcome", "issue-evidence", "need-evidence", "action-reason-evidence", "recommendation-source-references", "minutes-action-evidence", "minutes-participant-evidence", "causal-evidence"].map((name) => `src/lib/ai/${name}.ts`)]);
  return { pipeline, mocks };
}

test("meeting minutes from a stored one-line transcript keep grounded issues, proposals and next actions", async () => {
  const { pipeline, mocks } = await pipelineHarness();
  const oneLine = TURNS.join(" ");
  mocks.heavyReply = { usedFallback: false, parsed: {
    participants: ["話者1: ルマの佐藤", "話者2: 水奈良正規、総務部の森田"],
    issue_source_ids: [id(ISSUE)],
    proposals: [{ text: "撮影範囲の案", source_quote: OPTION, speech_act: "offered_option" }],
    next_actions: [{ action: "構成案と見積書を送付", owner: "話者1", due: "来週の金曜日", source_quote: ACTION }],
    decisions: [],
    summary: "工場見学の申し込み減少などの課題を確認した。",
  } };
  const result = await pipeline.runPipeline(oneLine, { companyName: "検証社", dealTitle: "会社紹介動画", products: [], pastEdits: [] });
  const minutes = result.meetingMinutes;
  // The model is shown one utterance per ID, as it would be for a correctly transcribed recording.
  const shown = JSON.parse(mocks.prompts[0].user.match(/# 文字起こし[^\n]*\n([\s\S]*)\n\nJSONのみ/u)[1]);
  assert.deepEqual(shown, TURNS.map((text, index) => ({ id: index + 1, text })));
  assert.deepEqual(Array.from(minutes.json.customer_issues), [ISSUE.replace(/^話者2: /u, "")]);
  assert.equal(minutes.json.proposals.length, 1);
  assert.match(minutes.json.proposals[0], /工場のラインと社員インタビュー/);
  assert.deepEqual(Array.from(minutes.json.next_actions, ({ action }) => action), [ACTION]);
  assert.doesNotMatch(minutes.markdown, /## 顧客の課題\n- 未確認/);
  assert.doesNotMatch(minutes.markdown, /## ネクストアクション\n- 未確認/);
  // Every published quote is literal text from the stored transcript, never the whole transcript.
  for (const text of [...minutes.json.customer_issues, ...minutes.json.next_actions.map(({ action }) => action)]) {
    assert.ok(text.length < oneLine.length / 2);
  }
});

// UI確認 2026-10-01（edge-02、2分30秒の対面録音）：参加者に同席していない「工場長の石田」が入り、ネクストアクションの期限が
// 「来週の金曜日まで」と話しているのに「未確認」、課題の各行に「発言（話者の役割未確認・原文）: 話者2:」が付いた。
test("edge-02: minutes keep only speakers as participants, the spoken relative deadline and issue text without internal prefixes", async () => {
  const { pipeline, mocks } = await pipelineHarness();
  const transcript = TURNS.join("\n");
  mocks.heavyReply = { usedFallback: false, parsed: {
    participants: ["話者1: ルマの佐藤", "話者2: 水奈良正規、総務部の森田", "話者2: 工場長の石田"],
    issue_source_ids: [id(ISSUE)],
    proposals: [],
    next_actions: [{ action: "構成案と見積書を送付", owner: "話者1", due: "未確認", source_quote: ACTION }],
    decisions: [],
    summary: "工場見学の申し込み減少などの課題を確認した。",
  } };
  const result = await pipeline.runPipeline(transcript, { companyName: "検証社", dealTitle: "会社紹介動画", products: [], pastEdits: [] });
  const minutes = result.meetingMinutes;
  assert.deepEqual(Array.from(minutes.json.participants), ["話者1: ルマの佐藤", "話者2: 水奈良正規、総務部の森田"]);
  assert.deepEqual(Array.from(minutes.json.next_actions, (row) => ({ ...row })), [{ action: ACTION, owner: "話者1", due: "来週の金曜日までに" }]);
  assert.deepEqual(Array.from(minutes.json.customer_issues), [ISSUE.replace(/^話者2: /u, "")]);
  assert.doesNotMatch(minutes.markdown, /工場長の石田|期限: 未確認|原文）:|^- 話者2: 工場見学/mu);
  // 落とした参加者と、課題の原文・話者の役割は監査に残る（公開文には出さない）。
  assert.deepEqual(Array.from(minutes.participantAudit.rejected, ({ participant, reason }) => ({ participant, reason })),
    [{ participant: "話者2: 工場長の石田", reason: "duplicate_speaker_label" }]);
  assert.deepEqual(Array.from(minutes.issueAudit.accepted, ({ sourceText, sourceRole }) => ({ sourceText, sourceRole })), [{ sourceText: ISSUE, sourceRole: "unspecified" }]);
  // 議事録の指示：参加者は発言者か同席が分かる人だけ、相対的な期限は原文の表記のまま。
  assert.match(mocks.prompts[0].system, /話の中で名前が出ただけの人/);
  assert.match(mocks.prompts[0].system, /来週の金曜日まで/);
});
