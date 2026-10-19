import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BANT_UNKNOWN_VALUES } from "../src/lib/ai/bant-definitions";
import { isUnknownBantValue } from "../src/lib/ai/bant-reconciliation";
import { groundTimeline, stripGeneratedSourceReference, timelineSourceTurns } from "../src/lib/ai/timeline-evidence";

test("generated trailing source citations are removed without altering factual text", () => {
  const transcript = "営業：予算は？\n顧客：80万円目安、正式承認未了です。\n営業：導入時期は？\n顧客：導入するなら2027年4月希望、未確定です。";
  for (const suffix of [" (id: 4)", " (id: 2, 4)", " （IDs：2、4）", " (id: 2) (id: 4)"]) {
    const value = "80万円目安・未承認。\n2027年4月希望・未確定。";
    assert.equal(stripGeneratedSourceReference(value + suffix, transcript), value);
  }
  assert.equal(stripGeneratedSourceReference("(id: 2)", transcript), "");
});

test("source business IDs survive formatting changes, and unsupported or inline citations are left intact", () => {
  const transcript = "顧客：製品（ＩＤ：４）を検討。\n顧客：候補 (ids: 2, 1) は未定。\n営業：承知しました。\n顧客：以上です。";
  for (const value of ["製品 (id: 4)", "候補 (ID: 1, 2)", "未確認 (id: 0)", "未確認 (id: 5)", "未確認 (id: 2, 9)", "未確認 (id: 1.5)", "製品(id: 3)の予算", "80万円・2027年4月・製品ID:3"]) {
    assert.equal(stripGeneratedSourceReference(value, transcript), value);
  }
});

test("source numbering skips blank lines while preserving literal whitespace and speakers", () => {
  const transcript = "\r\n  顧客：導入は9月を希望します。  \r\n \r\n話者1: 導入時期は未定です。\n";
  assert.deepEqual(timelineSourceTurns(transcript), [
    { id: 1, text: "  顧客：導入は9月を希望します。  " },
    { id: 2, text: "話者1: 導入時期は未定です。" },
  ]);
});

test("undecided adoption and information exchange cannot supply a timeline or a stage", () => {
  const transcript = "営業：制作予算は決まっていますか？\n顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。\n営業：導入することは決まりましたか？\n顧客：導入はまだ決めていません。今日は情報交換です。";
  const result = groundTimeline(transcript, [1, 2, 3, 4]);
  assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline);
  assert.deepEqual(result.sourceIds, []);
  assert.deepEqual(result.sourceQuotes, []);
  assert.deepEqual(result.rejectedSourceIds, [1, 2, 3, 4]);
});

test("a single mixed budget/undecided/exchange utterance does not invent a timeline", () => {
  const result = groundTimeline("顧客：予算は80万円目安です。導入は未決定です。今日は情報交換です。", [1]);
  assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline);
  assert.deepEqual(result.sourceIds, []);
});

test("conditional, hoped-for and mixed concrete/undecided timing retain the entire literal turn", () => {
  for (const source of [
    "顧客：導入するなら2027年4月希望。正式時期未確定。",
    "顧客：導入するなら、来春を希望します。",
    "顧客：導入するとしても9月より前は無理です。",
    "顧客：9月導入を予定しています。具体的な日は未定です。",
    "顧客：導入時期は未定だったが、9月15日で合意しました。",
    "顧客：承認されれば9月導入を希望します。",
    "顧客：予算は80万円目安です。導入は来年4月を希望します。",
    "顧客：導入は9月を希望します。可能でしょうか？",
    "顧客：9月に導入したいです。",
  ]) {
    const result = groundTimeline(source, [1]);
    assert.equal(result.value, `文字起こし記載: ${source}`, source);
    assert.deepEqual(result.sourceQuotes, [source]);
    assert.deepEqual(result.sourceIds, [1]);
  }
});

test("explicit unconsidered timing and unknown reasons remain quoted and unknown", () => {
  for (const source of [
    "顧客：導入時期はまだ検討していません。",
    "顧客：具体的な導入時期の検討段階ではありません。",
    "顧客：導入時期は社内確認が終わっておらず未定です。",
    "顧客：導入時期は不明です。",
  ]) {
    const result = groundTimeline(source, [1]);
    assert.equal(result.value, `${BANT_UNKNOWN_VALUES.timeline}\n文字起こし記載: ${source}`);
    assert.equal(isUnknownBantValue(result.value), true);
    assert.deepEqual(result.sourceQuotes, [source]);
  }
});

test("an unknown timeline sharing a provisional-budget line cannot be promoted by its amount", () => {
  const source = "顧客：予算は80万円を目安に検討中です。導入時期は未定です。";
  const result = groundTimeline(source, [1]);
  assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline);
  assert.equal(isUnknownBantValue(result.value), true);
  assert.deepEqual(result.sourceQuotes, [source]);
  assert.deepEqual(result.sourceIds, [1]);
});

test("sales questions, proposals and mixed speaker lines do not become customer schedules", () => {
  for (const source of [
    "営業：9月導入はいかがでしょうか？",
    "営業：9月導入を提案します。",
    "営業：導入は9月ですか？ 顧客：まだ決めていません。",
    "顧客：まだ決めていません。 営業：9月導入を提案します。",
    "田中：9月導入でしょうか？ 佐藤：まだ決めていません。",
    "顧客：導入は9月でしょうか",
    "話者1：導入は9月ですか？",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("a rejected sales date does not become a date when the customer only refuses it", () => {
  const result = groundTimeline("営業：9月導入でどうですか？\n顧客：それは無理です。導入はまだ決めていません。", [1, 2]);
  assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline);
  assert.deepEqual(result.sourceIds, []);
});

test("meeting dates, quotation deadlines and approval dates are not adoption dates", () => {
  for (const source of [
    "顧客：次回面談は9月30日です。導入は未決定です。",
    "顧客：9月30日までに見積をください。",
    "顧客：9月に予算承認し、導入は未決定です。",
    "顧客：9月の面談で導入時期を検討します。",
    "顧客：9月に見積を確認して導入を検討します。",
    "顧客：昨年9月に導入しました。",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("unknown and unlabeled speakers retain their literal identity without customer attribution", () => {
  for (const source of ["話者1：導入は9月を希望します。", "導入は9月を希望します。", "担当者A：導入は9月を希望します。", "導入時期：9月予定です。"]) {
    const result = groundTimeline(source, [1]);
    assert.equal(result.value, `文字起こし記載: ${source}`);
    assert.doesNotMatch(result.value, /顧客発言|顧客は/);
  }
});

test("valid IDs are deduplicated and rendered in source order; invalid types cannot select text", () => {
  const transcript = "顧客：導入は9月希望です。\n顧客：導入は10月希望です。";
  const invalid = ["1", 0, -1, 3, 1.5, NaN, Infinity, null, {}, true];
  const result = groundTimeline(transcript, [2, ...invalid, 1, 2, 1]);
  assert.deepEqual(result.sourceIds, [1, 2]);
  assert.deepEqual(result.sourceQuotes, transcript.split("\n"));
  assert.deepEqual(result.rejectedSourceIds, invalid);
  assert.equal(result.value, `文字起こし記載: ${transcript}`);
});

test("missing or nonarray selections fail closed and do not coerce IDs", () => {
  for (const ids of [undefined, null, 1, "1", { id: 1 }, []]) {
    const result = groundTimeline("顧客：導入は9月希望です。", ids);
    assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline);
    assert.deepEqual(result.sourceIds, []);
    assert.deepEqual(result.sourceQuotes, []);
    assert.deepEqual(result.rejectedSourceIds, ids === undefined || Array.isArray(ids) ? [] : [ids]);
  }
});

test("whole-turn conditions remain intact and no model-written interpretation can enter the value", () => {
  const source = "顧客：導入するなら9月希望です。契約はまだ決めていません。";
  const result = groundTimeline(source, [1, "今回は情報交換のため検討段階ではない"]);
  assert.equal(result.value, `文字起こし記載: ${source}`);
  assert.deepEqual(result.rejectedSourceIds, ["今回は情報交換のため検討段階ではない"]);
  assert.doesNotMatch(result.value, /検討段階ではない/);
});

test("video publication/delivery and production operation are actual implementation milestones", () => {
  for (const source of [
    "顧客：2027年3月に採用動画を公開したいです。",
    "顧客：動画の納品は2月末希望です。",
    "顧客：動画は2027年3月に公開したいです。",
    "顧客：動画を2027年3月に公開したいです。",
    "顧客：2027年4月の本番稼働を希望します。",
    "顧客：承認されれば9月に採用動画を公開したいです。",
  ]) {
    const result = groundTimeline(source, [1]);
    assert.equal(result.value, `文字起こし記載: ${source}`, source);
    assert.deepEqual(result.sourceQuotes, [source]);
  }
  const source = "顧客：動画の公開時期はまだ検討していません。";
  const result = groundTimeline(source, [1]);
  assert.equal(result.value, `${BANT_UNKNOWN_VALUES.timeline}\n文字起こし記載: ${source}`);
  assert.equal(isUnknownBantValue(result.value), true);
});

test("agreed video dates retain same-turn context and the customer's direct confirmation with literal seller context", () => {
  const transcript = readFileSync(new URL("./fixtures/uat/t18-agreed-conditions.txt", import.meta.url), "utf8");
  const turns = timelineSourceTurns(transcript);
  const adoption = turns.find(turn => turn.text.startsWith("顧客：説明いただいた範囲"))!;
  const seller = turns.find(turn => turn.text.startsWith("営業：採用動画の納品日"))!;
  const confirmation = turns.find(turn => turn.text.startsWith("顧客：はい。2026年12月15日"))!;
  const sameTurn = groundTimeline(transcript, [adoption.id]);
  assert.equal(sameTurn.value, `文字起こし記載: ${adoption.text}`);
  assert.deepEqual(sameTurn.contextSourceIds, []);
  const confirmed = groundTimeline(transcript, [confirmation.id]);
  assert.deepEqual(confirmed.sourceQuotes, [seller.text, confirmation.text]);
  assert.deepEqual(confirmed.contextSourceIds, [seller.id]);
  assert.match(confirmed.value, /営業：採用動画の納品日/u);
  assert.match(confirmed.value, /顧客：はい。2026年12月15日/u);
  assert.match(confirmed.value, /2027年1月10日.*正式な日程として確定します/u);
  const both = groundTimeline(transcript, [confirmation.id, seller.id, adoption.id]);
  assert.deepEqual(both.sourceIds, [adoption.id, seller.id, confirmation.id]);
  assert.deepEqual(both.contextSourceIds, [seller.id]);
  assert.equal(isUnknownBantValue(both.value), false);
  assert.doesNotMatch(both.value, /2026年10月5日|2026年9月30日17時/u);
});

test("same-turn video context cannot turn document, unrelated-party or meeting dates into adoption timing", () => {
  for (const source of [
    "顧客：採用動画の発注に合意します。資料の納品は2026年12月15日です。",
    "顧客：採用動画の発注に合意します。見積書を依頼します。納品は2026年12月15日です。",
    "顧客：採用動画の発注に合意します。他社の納品は2026年12月15日です。",
    "顧客：採用動画の発注に合意します。別案件の公開は2027年1月10日です。",
    "顧客：採用動画を制作します。別件の製品カタログについて説明します。納品は2026年12月15日です。",
    "顧客：採用動画の発注に合意します。2026年10月5日の面談で公開日を確認します。",
    "顧客：採用動画の発注に合意します。2026年10月5日の撮影後に公開日を相談します。",
    "顧客：採用動画の導入はまだ決めていません。納品は2026年12月15日でしょうか？",
    "顧客：『採用動画の発注に合意します』と他社が話していました。納品は2026年12月15日です。",
    "顧客：採用動画の発注に合意します。営業：納品は2026年12月15日です。",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("omitted video topic requires a direct explicit customer confirmation of the immediately preceding unambiguous seller offer", () => {
  const seller = "営業：採用動画の納品日は2026年12月15日です。2027年1月10日の公開に向けて制作します。";
  const confirmation = "顧客：はい。2026年12月15日の納品と2027年1月10日の公開を正式な日程として確定します。";
  for (const transcript of [
    confirmation,
    `${seller}\n顧客：検討します。\n${confirmation}`,
    `${seller}\n次は別案件です。\n${confirmation}`,
    `${seller.replace("営業：", "話者1：")}\n${confirmation}`,
    `${seller}\n${confirmation.replace("顧客：", "話者2：")}`,
    `${seller.replace("採用動画の納品日", "資料の納品日")}\n${confirmation}`,
    `${seller.replace("採用動画の納品日", "他社の採用動画の納品日")}\n${confirmation}`,
    "営業：採用動画の納品日は2026年12月15日です。製品カタログの公開は2027年1月10日です。\n顧客：はい。2027年1月10日の公開を正式な日程として確定します。",
    `${seller.replace("です。", "でしょうか？")}\n${confirmation}`,
    `${seller.replace("です。", "は候補です。")}\n${confirmation}`,
    `${seller} 顧客：未定です。\n${confirmation}`,
    `${seller}\n${confirmation.replace("はい。", "").replace("確定します", "希望します")}`,
    `${seller}\n${confirmation.replace("2026年12月15日", "2026年12月20日")}`,
  ]) {
    const last = timelineSourceTurns(transcript).length;
    assert.equal(groundTimeline(transcript, [last]).value, BANT_UNKNOWN_VALUES.timeline, transcript);
  }
  const withdrawn = `${seller}\n${confirmation}\n顧客：先ほどの導入時期は撤回します。新しい導入時期は未定です。`;
  const result = groundTimeline(withdrawn, [2]);
  assert.ok(result.withdrawal);
  assert.equal(isUnknownBantValue(result.value), true);
  assert.deepEqual(result.sourceIds, []);
});

test("document publication or quotation delivery cannot replace a video milestone", () => {
  for (const source of [
    "顧客：資料の公開は2027年3月です。",
    "顧客：見積書の納品は2月末希望です。",
    "顧客：動画の見積書を2027年3月に納品してください。",
    "顧客：動画の資料を2027年3月に公開します。",
    "顧客：動画の公開資料は2027年3月に完成します。",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("ISO and slash dates retain literal concrete timing and are not borrowed from meetings", () => {
  for (const source of [
    "顧客：導入は2027-04-01希望です。",
    "顧客：2027/04/01に導入したいです。",
    "顧客：採用動画を2027-03-15に公開したいです。",
    "顧客：動画の納品は2027/02/28を希望します。",
    "顧客：承認されれば2027-04-01に導入します。",
  ]) assert.equal(groundTimeline(source, [1]).value, `文字起こし記載: ${source}`, source);
  for (const source of [
    "顧客：面談は2027-04-01です。導入は未決定です。",
    "顧客：2027/04/01の会議で導入を検討します。",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("separate conditional lines survive even when omitted from the model's selected IDs", () => {
  const transcript = "顧客：導入は2027年4月です。\n顧客：ただし、承認された場合の希望です。まだ決定していません。";
  for (const ids of [[1], [1, 2], [2, 1, 2]]) {
    const result = groundTimeline(transcript, ids);
    assert.equal(result.value, `文字起こし記載: ${transcript}`);
    assert.deepEqual(result.sourceIds, [1, 2]);
    assert.deepEqual(result.sourceQuotes, transcript.split("\n"));
    assert.deepEqual(result.contextSourceIds, [2]);
    assert.deepEqual(result.rejectedSourceIds, []);
  }
});

test("conditions before the date and multiple following caveats are retained as one source block", () => {
  const transcript = [
    "顧客：承認が下りた場合の希望で、まだ確定ではありません。",
    "顧客：導入は2027年4月です。",
    "顧客：承認されなければ延期します。",
    "顧客：社内の確認も終わっていません。",
  ].join("\n");
  const result = groundTimeline(transcript, [2]);
  assert.equal(result.value, `文字起こし記載: ${transcript}`);
  assert.deepEqual(result.sourceIds, [1, 2, 3, 4]);
  assert.deepEqual(result.contextSourceIds, [1, 3, 4]);
  assert.deepEqual(result.rejectedSourceIds, []);
});

test("context blocks do not cross speaker, mixed-turn, unlabeled or blank-line boundaries", () => {
  const seed = "顧客：導入は2027年4月です。";
  for (const boundary of [
    "営業：確定という理解でよいですか？",
    "先方：それは別案件の話です。",
    "顧客：確認中です。営業：確定でしょうか？",
    "ただし、まだ承認は下りていません。",
    "",
    "   ",
  ]) {
    const transcript = `${seed}\n${boundary}\n顧客：別案件は確定です。`;
    const result = groundTimeline(transcript, [1]);
    assert.equal(result.value, `文字起こし記載: ${seed}`, boundary);
    assert.deepEqual(result.sourceIds, [1]);
    assert.deepEqual(result.contextSourceIds, []);
  }
});

test("context cannot supply an independent timeline to questions, adoption uncertainty or date-only replies", () => {
  for (const transcript of [
    "顧客：導入は2027年4月でしょうか？\n顧客：まだ決めていません。",
    "顧客：導入はまだ決めていません。\n顧客：ただし、承認が必要です。",
    "顧客：導入するかは未定です。\n顧客：希望は2027年4月です。",
    "営業：導入は2027年4月でしょうか？\n顧客：その日を希望します。",
  ]) {
    const result = groundTimeline(transcript, [1, 2]);
    assert.equal(result.value, BANT_UNKNOWN_VALUES.timeline, transcript);
    assert.deepEqual(result.sourceIds, []);
    assert.deepEqual(result.contextSourceIds, []);
  }
});

test("selected independent sources remain distinct from automatic context regardless of source order", () => {
  const transcript = "話者1：承認が必要です。\n話者1：導入は2027年4月希望です。\n話者1：導入は2027年5月になる可能性もあります。\n話者1：確約はできません。";
  const result = groundTimeline(transcript, [3, 2]);
  assert.equal(result.value, `文字起こし記載: ${transcript}`);
  assert.deepEqual(result.sourceIds, [1, 2, 3, 4]);
  assert.deepEqual(result.contextSourceIds, [1, 4]);
  assert.deepEqual(result.rejectedSourceIds, []);
});

test("customer deadlines for using or publishing the product are concrete timing even without adoption words", () => {
  for (const source of [
    "話者1: 4月の新入研修に間に合えば十分です。",
    "話者2: 説明会への出店そのものをを見送ることになったので、来年サツキの採用サイトの刷新に合わせて公開できれば十分です。",
    "顧客：来年5月の採用サイトの刷新に合わせて公開できれば十分です。",
    "顧客：4月の新人研修までに使いたいです。",
    "顧客：4月の新人研修に間に合わせたいです。",
    "顧客：来年4月から使い始めたいです。",
  ]) {
    const result = groundTimeline(source, [1]);
    assert.equal(result.value, `文字起こし記載: ${source}`, source);
    assert.equal(isUnknownBantValue(result.value), false, source);
    assert.deepEqual(result.sourceIds, [1]);
  }
});

test("a withdrawn deadline is rejected while the replacement deadline in the same meeting is kept", () => {
  const transcript = [
    "話者1: 時期についても、1月の研修から使いたいと言いましたが、撤回します。",
    "話者1: 4月の新入研修に間に合えば十分です。",
  ].join("\n");
  const withdrawnOnly = groundTimeline(transcript, [1]);
  assert.equal(withdrawnOnly.value, BANT_UNKNOWN_VALUES.timeline);
  assert.deepEqual(withdrawnOnly.rejectedSourceIds, [1]);
  // T06: the withdrawn line is neither evidence nor surrounding context, so it cannot lead the quotation.
  for (const ids of [[1, 2], [2]]) {
    const result = groundTimeline(transcript, ids);
    assert.equal(result.withdrawal, undefined);
    assert.equal(result.value, "文字起こし記載: 話者1: 4月の新入研修に間に合えば十分です。");
    assert.deepEqual(result.sourceIds, [2]);
    assert.deepEqual(result.sourceQuotes, ["話者1: 4月の新入研修に間に合えば十分です。"]);
    assert.deepEqual(result.contextSourceIds, []);
    assert.equal(isUnknownBantValue(result.value), false);
  }
});

test("deadline wording cannot pass sales remarks, meetings, quotations, withdrawals, questions or hypotheticals", () => {
  for (const source of [
    "営業：4月の新入研修に間に合わせます。",
    "営業：4月の新入研修に間に合えば十分ですね。",
    "顧客：10月28日の打ち合わせに間に合わせたいです。",
    "顧客：次回の打ち合わせは10月28日14時で、それに間に合えば十分です。",
    "顧客：見積を10月21日までに間に合わせてください。",
    "顧客：10月21日までに見積をいただければ間に合えば十分です。",
    "顧客：資料は来週に合わせて公開できれば十分です。",
    "顧客：3月の説明会に間に合わせたいとお話ししましたが、それは撤回します。",
    "顧客：時期についても、1月の研修から使いたいと言いましたが、撤回します。",
    "顧客：4月の新入研修に間に合えば十分ですか？",
    "顧客：4月の新入研修に間に合わせたいでしょうか",
    "顧客：もし4月の研修に間に合えば十分です。",
    "顧客：仮に来年5月に合わせて公開できれば十分です。",
    "顧客：4月の研修に間に合わせたいですが、時期は未定です。",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});

test("a withdrawn adoption date is not independent evidence, and context stops at a withdrawal line", () => {
  for (const source of [
    "顧客：導入は1月を希望していましたが、撤回します。",
    "顧客：1月の導入予定は取り下げます。",
  ]) assert.equal(isUnknownBantValue(groundTimeline(source, [1]).value), true, source);
  const transcript = "顧客：前回は1月から使い始めたいとお話ししましたが、それは撤回します。\n顧客：導入は4月を希望します。\n顧客：ただし承認が必要です。";
  const result = groundTimeline(transcript, [2]);
  assert.deepEqual(result.sourceIds, [2, 3]);
  assert.deepEqual(result.contextSourceIds, [3]);
  assert.doesNotMatch(result.value, /撤回/u);
});
