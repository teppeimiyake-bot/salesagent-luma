// T04: 区間の文字起こしの時刻（[MM:SS]）の読み取り・除去、区間のつなぎ目の重複除去（話者名は書き換えない）、
// 書き漏れの判定。純関数だけを使い、AI・DB・外部通信は呼ばない。本文はすべて架空（実出力の抜粋も架空の台本の読み上げ）。
import test from "node:test";
import assert from "node:assert/strict";
import timedTranscript from "../src/lib/meetings/timed-transcript.ts";
import transcriptionJob from "../src/lib/meetings/transcription-job.ts";

const {
  parseTimedLine, stripTimestamps, isTimedTranscript, parseTimedTranscript, lastTimestampSec, isNoSpeechTranscript,
  matchLines, normalizeForMatch, lineSimilarity, joinTimedSegments, spokenTextLength,
} = timedTranscript;
const {
  joinTranscriptionSegments, previousSegmentTail, previousSegmentTimed, segmentCompleteness, betterSegmentText, createTranscriptionJob, planTranscriptionSegments,
} = transcriptionJob;

// issue-evidence.ts の labelledLine と同じ判定（根拠照合が話者として読む形）。
const labelledLine = line => {
  const match = line.match(/^\s*([^:：。！？!?]{1,40})\s*[:：]\s*(.*)$/u);
  return match && !/^[\d０-９\s]+$/u.test(match[1]) ? match[1].trim() : null;
};

const A = { startSec: 0, endSec: 610 };
const B = { startSec: 600, endSec: 1210 };
const C = { startSec: 1200, endSec: 1810 };
const lines = (...rows) => rows.join("\n");

test("T04 timed lines: [MM:SS]/[H:MM:SS]/full-width stamps are read and always stripped; untimed lines are kept as they are", () => {
  assert.deepEqual(parseTimedLine("[00:12] 話者1: こんにちは"), { sec: 12, text: "話者1: こんにちは", speaker: "話者1", separator: ": ", body: "こんにちは" });
  assert.equal(parseTimedLine("[1:02:03] 話者2：はい").sec, 3723);
  assert.equal(parseTimedLine("［０１：０５］ 話者１： 承知しました").sec, 65);
  assert.equal(parseTimedLine("［０１：０５］ 話者１： 承知しました").text, "話者１： 承知しました");
  assert.equal(parseTimedLine("[09:58.4]話者1: 途中").sec, 598);
  assert.equal(parseTimedLine("[00:12 - 00:15] 話者1: 範囲").sec, 12);
  // An impossible time is not trusted but is still removed from the text.
  assert.deepEqual([parseTimedLine("[12:75] 話者1: 読めない時刻").sec, parseTimedLine("[12:75] 話者1: 読めない時刻").text], [null, "話者1: 読めない時刻"]);
  // Legacy lines and times inside an utterance are untouched.
  assert.deepEqual(parseTimedLine("話者1: 従来の行"), { sec: null, text: "話者1: 従来の行", speaker: "話者1", separator: ": ", body: "従来の行" });
  assert.deepEqual(parseTimedLine("10:00から始めます"), { sec: null, text: "10:00から始めます", speaker: null, separator: "", body: "10:00から始めます" });
  assert.equal(stripTimestamps("[00:01] 話者1: 一つ目\n\n話者2: 二つ目\n[00:09] （聞き取れませんでした）"), "話者1: 一つ目\n\n話者2: 二つ目\n（聞き取れませんでした）");
  // After stripping, the evidence code reads the speaker label, not "[00".
  assert.equal(labelledLine("[00:12] 話者1: 予算は80万円です。"), "[00");
  assert.equal(labelledLine(stripTimestamps("[00:12] 話者1: 予算は80万円です。")), "話者1");
});

test("T04 timed lines: decorated stamps (list markers, bold, 3-digit minutes, open ranges) are read and stripped", () => {
  for (const line of ["- [00:12] 話者1: 予算は80万円です。", "* [00:12] 話者1: 予算は80万円です。", "・[00:12] 話者1: 予算は80万円です。", "• [00:12] 話者1: 予算は80万円です。",
    "**[00:12]** 話者1: 予算は80万円です。", "- **[00:12]** 話者1: 予算は80万円です。", "[00:12〜] 話者1: 予算は80万円です。", "[00:12 - ] 話者1: 予算は80万円です。",
    "  ［００：１２～］ 話者1: 予算は80万円です。"]) {
    assert.deepEqual(parseTimedLine(line), { sec: 12, text: "話者1: 予算は80万円です。", speaker: "話者1", separator: ": ", body: "予算は80万円です。" }, line);
    assert.equal(labelledLine(stripTimestamps(line)), "話者1", line);
  }
  assert.equal(parseTimedLine("[100:05] 話者2: 長い区間").sec, 6005);
  assert.equal(parseTimedLine("[100:05] 話者2: 長い区間").speaker, "話者2");
  assert.equal(parseTimedLine("[1:02:03-1:02:09] 話者2: 範囲").sec, 3723);
  // A decorated transcript is still recognised as timed (so the boundary is deduplicated), and nothing leaks.
  assert.equal(isTimedTranscript(parseTimedTranscript(lines("- [00:00] 話者1: あ", "- [00:05] 話者2: い"))), true);
  assert.equal(stripTimestamps(lines("- [00:00] 話者1: あ", "**[00:05]** 話者2: い")), lines("話者1: あ", "話者2: い"));
  // Markers without a time are text, not stamps.
  assert.equal(parseTimedLine("- 話者1: 箇条書き").text, "- 話者1: 箇条書き");
  assert.equal(parseTimedLine("**重要** 話者1: 強調").sec, null);
});

test("T04 timed lines: a clock inside an unlabeled utterance is not read as a speaker label", () => {
  assert.deepEqual(parseTimedLine("[10:05] 時間は14:00からで大丈夫です"), { sec: 605, text: "時間は14:00からで大丈夫です", speaker: null, separator: "", body: "時間は14:00からで大丈夫です" });
  assert.equal(parseTimedLine("[10:05] 時間は１４：００からです").speaker, null);
  assert.equal(parseTimedLine("[10:05] 開始は9:30です").speaker, null);
  // Real labels followed by a number stay labels.
  assert.equal(parseTimedLine("[00:01] 話者1: 10時からで大丈夫です").speaker, "話者1");
  assert.equal(parseTimedLine("[00:01] 話者1：10時からで大丈夫です").speaker, "話者1");
  assert.equal(parseTimedLine("[00:01] 話者２：10時から").speaker, "話者２");
  assert.equal(parseTimedLine("[00:01] 営業: 14時からです").speaker, "営業");
  assert.equal(parseTimedLine("[00:01] 営業2: 14時からです").speaker, "営業2");
  // The extends rewrite no longer duplicates the text (「時間は14:時間は14:00から…」).
  const joined = joinTimedSegments([
    { ...A, text: lines("[09:40] 話者1: ご都合はいかがですか。", "[10:05] 時間は14:00からで大丈夫です") },
    { ...B, text: lines("[00:05] 話者2: 時間は14:00からで大丈夫です。会場は本社です。", "[00:20] 話者1: 承知しました。") },
  ]);
  assert.equal(joined, lines("話者1: ご都合はいかがですか。", "時間は14:00からで大丈夫です。会場は本社です。", "", "話者1: 承知しました。"));
});

test("T04 timed lines: a transcript is timed only when most spoken lines carry a time; last time and no-speech detection", () => {
  assert.equal(isTimedTranscript(parseTimedTranscript(lines("[00:00] 話者1: あ", "話者2: い", "[00:09] 話者1: う"))), true);
  assert.equal(isTimedTranscript(parseTimedTranscript(lines("[00:00] 話者1: あ", "話者2: い", "話者1: う"))), false);
  assert.equal(isTimedTranscript(parseTimedTranscript("話者1: 従来の出力")), false);
  assert.equal(lastTimestampSec(lines("[00:00] 話者1: あ", "[09:58] 話者2: い", "話者1: 時刻の無い最後の行")), 598);
  assert.equal(lastTimestampSec("話者1: 従来の出力"), null);
  // Times beyond maxSec (a mistyped [17:05] in a 610s segment) are not the last time.
  const mistyped = lines("[00:00] 話者1: あ", "[01:05] 話者2: い", "[17:05] 話者2: 誤った時刻", "[07:30] 話者1: ここで止まった");
  assert.equal(lastTimestampSec(mistyped), 1025);
  assert.equal(lastTimestampSec(mistyped, 615), 450);
  assert.equal(lastTimestampSec(lines("[17:05] 話者1: あ", "[18:00] 話者2: い"), 615), null, "no usable time");
  assert.equal(spokenTextLength(lines("[00:00] 話者1: あいう、えお。", "", "[00:05] 話者2: かき")), 7, "times, labels and punctuation are not counted");
  assert.equal(isNoSpeechTranscript("（聞き取れませんでした）"), true);
  assert.equal(isNoSpeechTranscript("[00:00] （聞き取れませんでした）"), true);
  assert.equal(isNoSpeechTranscript("[00:00] 話者1: はい"), false);
});

test("T04 line matching: normalized equality, containment of 6+ characters, a truncated last line, and a bounded difflib-like ratio", () => {
  const n = normalizeForMatch;
  assert.equal(n("撮影には、どのような 決まりが？"), "撮影にはどのような決まりが");
  assert.equal(matchLines(n("工場の中での撮影にはどのような決まりがありますか。"), n("工場の中での撮影には どのような決まりがありますか？")), "same");
  assert.equal(matchLines(n("工場の中での"), n("工場の中での撮影にはどのような決まりがありますか。")), "extends");
  assert.equal(matchLines(n("ヘルメットと安全靴が必要です。撮影する場合は事前に申請します。"), n("安全靴が必要です。")), "same");
  // Short lines only match when identical and at about the same moment of the recording.
  assert.equal(matchLines(n("はい。"), n("はい")), null);
  assert.equal(matchLines(n("はい。"), n("はい"), { timeGapSec: 1 }), "same");
  assert.equal(matchLines(n("はい。"), n("はい"), { timeGapSec: 8 }), null);
  assert.equal(matchLines(n("工場"), n("工場見学会")), null, "containment needs 6+ characters");
  // The previous segment's last line is cut mid-word at the audio boundary.
  const cut = n("オンライン説明会に関していいますと、品質保証部の区画は安全のために立ちい");
  const full = n("オンライン説明会に関していいますと、品質保証部の区画は安全のために立ち入りの手順が決まっていて、ヘルメットと安全靴が必要です。");
  assert.equal(matchLines(cut, full), null, "not the last line → not treated as truncated");
  assert.equal(matchLines(cut, full, { prevIsLast: true }), "extends");
  assert.ok(lineSimilarity("abcdefghij", "abcdefghiX") >= 0.8);
  assert.equal(lineSimilarity("abc", "xyz"), 0);
  assert.equal(matchLines(n("春の会社説明会では会社の歴史を紹介しています"), n("春の会社説明会では会社の歴史も紹介しています")), "same");
  assert.equal(matchLines(n("決裁は人事本部長が行います"), n("撮影には申請が必要です")), null);
  // Lines that differ only in a number are different utterances even though the ratio is high.
  assert.ok(lineSimilarity(n("ご予算は80万円を想定しています"), n("ご予算は90万円を想定しています")) >= 0.8);
  assert.equal(matchLines(n("ご予算は80万円を想定しています"), n("ご予算は90万円を想定しています")), null);
  assert.equal(matchLines(n("ご予算は８０万円を想定しています。"), n("ご予算は80万円を想定しています")), "same");
  // A similarity-only match where the next line is clearly longer carries text only the next run heard → extends.
  const said = n("工場見学会に関して言いますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。");
  const heard = n("工場見学会に関していいますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。ただ、稼働中の時間帯は難しいです。");
  assert.ok(!heard.includes(said) && lineSimilarity(said, heard) >= 0.8);
  assert.equal(matchLines(said, heard), "extends");
  assert.equal(matchLines(heard, said), "same", "the shorter next line is still a duplicate");
  assert.equal(matchLines(n("春の会社説明会では会社の歴史を紹介しています"), n("春の会社説明会では会社の歴史も紹介していますね")), "same", "up to 3 more characters is the same utterance");
});

test("T04 boundary: overlap duplicates are removed, a truncated previous line gets the longer body, unmatched head lines stay", () => {
  const a = lines(
    "[00:00] 話者1: 本日はよろしくお願いいたします。",
    "[09:40] 話者2: 春の会社説明会では会社の歴史を紹介しています。",
    "[09:58] 話者1: 工場の中での撮影にはどのような決まりがありますか。",
    "[10:01] 話者2: はい。",
    "[10:04] 話者2: オンライン説明会に関していいますと、品質保証部の区画は安全のために立ちい",
  );
  const b = lines(
    "[00:00] 話者1: 工場の中での撮影にはどのような決まりがありますか？",
    "[00:01] 話者2: はい",
    "[00:04] 話者2: オンライン説明会に関していいますと、品質保証部の区画は安全のために立ち入りの手順が決まっていて、ヘルメットと安全靴が必要です。",
    "[00:11] 話者1: なるほど。",
    "[00:15] 話者2: 撮影する場合は事前に総務部に申請を出してもらう流れになります。",
  );
  assert.equal(joinTimedSegments([{ ...A, text: a }, { ...B, text: b }]), lines(
    "話者1: 本日はよろしくお願いいたします。",
    "話者2: 春の会社説明会では会社の歴史を紹介しています。",
    "話者1: 工場の中での撮影にはどのような決まりがありますか。",
    "話者2: はい。",
    "話者2: オンライン説明会に関していいますと、品質保証部の区画は安全のために立ち入りの手順が決まっていて、ヘルメットと安全靴が必要です。",
    "",
    "話者1: なるほど。",
    "話者2: 撮影する場合は事前に総務部に申請を出してもらう流れになります。",
  ));
  // The previous segment ends on a fragment that the next segment contains.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:30] 話者2: 回答です。", "[10:08] 話者1: 工場の中での") },
    { ...B, text: lines("[00:07] 話者1: 工場の中での撮影にはどのような決まりがありますか。", "[00:14] 話者2: 申請が必要です。") },
  ]), lines("話者2: 回答です。", "話者1: 工場の中での撮影にはどのような決まりがありますか。", "", "話者2: 申請が必要です。"));
  // A short reply at a different moment is a different utterance and stays.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:30] 話者1: ご質問です。", "[10:00] 話者2: はい。") },
    { ...B, text: lines("[00:09] 話者2: はい。", "[00:12] 話者1: 次の質問です。") },
  ]), lines("話者1: ご質問です。", "話者2: はい。", "", "話者2: はい。", "話者1: 次の質問です。"));
});

test("T04 boundary: one utterance written as two lines on one side and one line on the other is kept once, without losing text", () => {
  const P = "設計部のお話、具体的なお話をありがとうございます。";
  const Q = "イメージがかなり湧いてきました。";
  // The previous run split it; the next run wrote it as one longer line → one line, the previous run's second line absorbed.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:30] 話者2: 回答です。", `[09:58] 話者1: ${P}`, `[10:03] 話者1: ${Q}`) },
    { ...B, text: lines(`[00:00] 話者1: ${P}${Q}`, "[00:30] 話者2: 次の話です。") },
  ]), lines("話者2: 回答です。", `話者1: ${P}${Q}`, "", "話者2: 次の話です。"));
  // The following line of another speaker is not absorbed (its attribution is kept, even if the text repeats).
  assert.equal(joinTimedSegments([
    { ...A, text: lines(`[09:58] 話者1: ${P}`, `[10:03] 話者2: ${Q}`) },
    { ...B, text: lines(`[00:00] 話者1: ${P}${Q}`, "[00:30] 話者2: 次の話です。") },
  ]), lines(`話者1: ${P}${Q}`, `話者2: ${Q}`, "", "話者2: 次の話です。"));
  // The next run split what the previous run wrote as one line → both parts are duplicates.
  assert.equal(joinTimedSegments([
    { ...A, text: lines(`[09:59] 話者1: ${P}${Q}`) },
    { ...B, text: lines(`[00:00] 話者1: ${P}`, `[00:05] 話者1: ${Q}`, "[00:30] 話者2: 次の話です。") },
  ]), lines(`話者1: ${P}${Q}`, "", "話者2: 次の話です。"));
  // A next line that continues past the absorbed line is kept, so nothing is lost.
  const R = "撮影は事前の申請が必要になります。";
  assert.equal(joinTimedSegments([
    { ...A, text: lines(`[09:58] 話者1: ${P}`, `[10:03] 話者1: ${Q}`) },
    { ...B, text: lines(`[00:00] 話者1: ${P}${Q}`, `[00:06] 話者1: ${Q}${R}`) },
  ]), lines(`話者1: ${P}${Q}`, "", `話者1: ${Q}${R}`));
});

test("T04 boundary: legacy untimed output falls back to plain concatenation; times are stripped wherever they appear", () => {
  const untimedA = "話者1: 区間1の発話\n話者2: 重なりの発話";
  const untimedB = "話者2: 重なりの発話\n話者1: 区間2の発話";
  assert.equal(joinTimedSegments([{ ...A, text: ` ${untimedA} ` }, { ...B, text: untimedB }]), `${untimedA}\n\n${untimedB}`);
  const timedB = "[00:00] 話者2: 重なりの発話です\n[00:30] 話者1: 区間2の発話";
  assert.equal(joinTimedSegments([{ ...A, text: untimedA }, { ...B, text: timedB }]), `${untimedA}\n\n話者2: 重なりの発話です\n話者1: 区間2の発話`);
  assert.equal(joinTimedSegments([{ ...A, text: "" }, { ...B, text: timedB }]), "話者2: 重なりの発話です\n話者1: 区間2の発話");
  // The job-level join and the old two-segment expectation agree.
  const job = { ...createTranscriptionJob(new Date("2026-09-29T00:00:00Z")), mode: "segmented", segments: [
    { ...A, status: "done", attempts: 1, text: "本文0" }, { ...B, status: "done", attempts: 1, text: "本文1" },
  ] };
  assert.equal(joinTranscriptionSegments(job), "本文0\n\n本文1");
});

test("T04 speakers: labels are never rewritten; a mislabeled overlap does not flip the next segment", () => {
  const X = "工場の中での撮影にはどのような決まりがありますか。";
  const Y = "事前に総務部に申請を出してもらう流れになります。";
  const a = lines(`[09:58] 話者1: ${X}`, `[10:04] 話者2: ${Y}`);
  const later = ["[03:00] 話者2: 次に資料の作り方を伺います。", "[03:10] 話者1: 人事の担当者二人が中心になって作っています。"];
  const plain = rows => rows.map(line => line.replace(/^\[\d+:\d+\] /, ""));
  // Both overlap lines came back with the other number: nothing is relabeled, and lines of another 話者N are not dropped.
  assert.equal(joinTimedSegments([{ ...A, text: a }, { ...B, text: lines(`[00:03] 話者2: ${X}`, `[00:06] 話者1: ${Y}`, ...later) }]), lines(
    `話者1: ${X}`, `話者2: ${Y}`, "", `話者2: ${X}`, `話者1: ${Y}`, ...plain(later),
  ));
  // Only the very first line within 2s is dropped whatever its label (the opening of the audio cuts into an utterance).
  assert.equal(joinTimedSegments([{ ...A, text: a }, { ...B, text: lines(`[00:00] 話者2: ${X}`, `[00:04] 話者1: ${Y}`, ...later) }]), lines(
    `話者1: ${X}`, `話者2: ${Y}`, "", `話者1: ${Y}`, ...plain(later),
  ));
  // Role labels (営業/顧客) are not 話者N: the duplicates are removed, the previous segment's labels stay, later lines are untouched.
  assert.equal(joinTimedSegments([
    { ...A, text: lines(`[09:58] 営業: ${X}`, `[10:04] 顧客: ${Y}`) },
    { ...B, text: lines(`[00:00] 顧客: ${X}`, `[00:04] 営業: ${Y}`, "[03:00] 顧客: 後の発話です。") },
  ]), lines(`営業: ${X}`, `顧客: ${Y}`, "", "顧客: 後の発話です。"));

  // Real gemini-3.5-flash-lite output for audio starting at 10:00 (TS_2): the salesperson is 話者1 throughout, but the
  // overlap line 「生産技術部のお話…」 came back as 話者2. Round 1 swapped the whole segment from this one pair.
  const prev = lines(
    "[09:47] 話者1: 冬の選考会では、どのような内容を学生の方にお伝えしていますか。",
    "[09:52] 話者2: 冬の選考会では、会社の歴史と主力製品の紹介、それから生産技術部の若手社員による仕事の説明をしています。説明の時間はだいたい四十分ほどで、そのあとに質問の時間を取っています。",
    "[10:05] 話者1: 生産技術部のお話、なるほど、よく分かりました。",
  );
  const next = lines(
    "[00:00] 話者1: 第四十分ほどで、そのあとに質問の時間を取り-います。",
    "[00:05] 話者2: 生産技術部のお話、なるほど、よくわかりました。現場の雰囲気が伝わるかどうかが大切なのですね。",
    "[00:14] 話者1: 冬の選考会と設計部の件で伺います。工場の中での撮影にはどのような決まりがありますか。",
    "[00:23] 話者2: 冬の選考会に関していいますと、設定部の区画は安全のために立ち入りの手順が決まっていて、ヘルメットと安全靴が必要です。撮影する場合は事前に総務部に申請を出してもらう流れになります。",
    "[00:40] 話者1: オンライン説明会と品質保証部の件で伺います。現在お使いの資料はどなたが作られていますか。",
  );
  const joined = joinTimedSegments([{ ...A, text: prev }, { ...B, text: next }]);
  assert.equal(joined, `${stripTimestamps(prev)}\n\n${stripTimestamps(next)}`, "nothing is relabeled or lost");
  assert.equal((joined.split("\n\n")[1].match(/^話者1: [^\n]*伺います/gmu) ?? []).length, 2);
  assert.equal((joined.split("\n\n")[1].match(/^話者2: [^\n]*伺います/gmu) ?? []).length, 0);

  // Segment 2 came back swapped relative to segment 1 and segment 3 followed segment 2: no segment is changed.
  const Z = "人事の担当者二人が中心になって作っています。";
  const W = "毎年少しずつ直していますが見せ方は変えていません。";
  const chained = joinTimedSegments([
    { ...A, text: lines(`[09:58] 話者1: ${X}`, `[10:04] 話者2: ${Y}`) },
    { ...B, text: lines(`[00:03] 話者2: ${X}`, `[00:06] 話者1: ${Y}`, `[09:58] 話者2: ${Z}`, `[10:04] 話者1: ${W}`) },
    { ...C, text: lines(`[00:03] 話者2: ${Z}`, `[00:06] 話者1: ${W}`, "[05:00] 話者2: 区間3の質問です。") },
  ]);
  assert.equal(chained, lines(`話者1: ${X}`, `話者2: ${Y}`, "", `話者2: ${X}`, `話者1: ${Y}`, `話者2: ${Z}`, `話者1: ${W}`, "", "話者2: 区間3の質問です。"));
});

test("T04 boundary: another 話者N's line is never dropped; a line inside a merged previous line is dropped only while that line is spoken", () => {
  // The other speaker's reply after the overlap is contained in the merged previous line: it stays.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:40] 話者2: 資料の件、承知しました。", "[10:02] 話者1: 本日の説明は以上です。よろしくお願いいたします。") },
    { ...B, text: lines("[00:02] 話者1: 本日の説明は以上です。", "[00:05] 話者1: よろしくお願いいたします。", "[00:11] 話者2: よろしくお願いいたします。", "[00:40] 話者2: 次回の日程ですが。") },
  ]), lines("話者2: 資料の件、承知しました。", "話者1: 本日の説明は以上です。よろしくお願いいたします。", "", "話者2: よろしくお願いいたします。", "話者2: 次回の日程ですが。"));
  // Short replies of different speakers at the same moment are both kept.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:30] 話者1: ご質問です。", "[10:02] 話者2: はい。") },
    { ...B, text: lines("[00:02] 話者1: はい。", "[00:12] 話者1: 次の質問です。") },
  ]), lines("話者1: ご質問です。", "話者2: はい。", "", "話者1: はい。", "話者1: 次の質問です。"));
  // Same speaker: a second part of the merged line is dropped while it is spoken; the same words after the following
  // previous line started (not transcribed by the next run) are a new utterance and stay.
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:58] 話者1: 本日の説明は以上です。ありがとうございます。", "[10:04] 話者2: 次回の日程を決めましょう。") },
    { ...B, text: lines("[00:00] 話者1: 本日の説明は以上です。", "[00:09] 話者1: ありがとうございます。", "[00:30] 話者2: 来週はいかがですか。") },
  ]), lines("話者1: 本日の説明は以上です。ありがとうございます。", "話者2: 次回の日程を決めましょう。", "", "話者1: ありがとうございます。", "話者2: 来週はいかがですか。"));
  // Without a following line the span ends 3s after the previous segment's audio (610 + 3 = 613s).
  assert.equal(joinTimedSegments([
    { ...A, text: lines("[09:30] 話者2: ご説明ください。", "[09:58] 話者1: 本日の説明は以上です。ありがとうございます。") },
    { ...B, text: lines("[00:01] 話者1: 本日の説明は以上です。", "[00:05] 話者1: ありがとうございます。", "[00:13] 話者1: ありがとうございます。") },
  ]), lines("話者2: ご説明ください。", "話者1: 本日の説明は以上です。ありがとうございます。", "", "話者1: ありがとうございます。"));
});

test("T04 boundary: a similar but longer next line replaces the previous line instead of being dropped", () => {
  const joined = joinTimedSegments([
    { ...A, text: lines(
      "[09:40] 話者1: 撮影にご協力いただける社員の方は、いらっしゃいそうですか。",
      "[10:00] 話者2: 工場見学会に関して言いますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。",
      "[10:09] 話者2: ただ、稼",
    ) },
    { ...B, text: lines(
      "[00:00] 話者2: 工場見学会に関していいますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。ただ、稼働中の時間帯は難しいです。",
      "[00:20] 話者1: 承知しました。",
    ) },
  ]);
  // The continuation heard only by the next run is kept under the previous segment's label. The 3-character cut
  // fragment 「ただ、稼」 is too short to match safely and stays.
  assert.equal(joined, lines(
    "話者1: 撮影にご協力いただける社員の方は、いらっしゃいそうですか。",
    "話者2: 工場見学会に関していいますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。ただ、稼働中の時間帯は難しいです。",
    "話者2: ただ、稼",
    "",
    "話者1: 承知しました。",
  ));
});

test("T04 boundary: a previous line that started before the overlap window but runs into it is compared", () => {
  assert.equal(joinTimedSegments([
    { ...A, text: lines(
      "[09:30] 話者1: 撮影にご協力いただける社員の方は、いらっしゃいそうですか。",
      "[09:56] 話者2: 工場見学会に関して言いますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。",
      "[10:05] 話者1: 承知しました。",
    ) },
    { ...B, text: lines("[00:03] 話者2: 声をかければ協力してくれると思います。", "[00:05] 話者1: 承知しました。", "[00:20] 話者1: 次の件で伺います。") },
  ]), lines(
    "話者1: 撮影にご協力いただける社員の方は、いらっしゃいそうですか。",
    "話者2: 工場見学会に関して言いますと、営業部には話すのが得意な若手が何人かいますので、声をかければ協力してくれると思います。",
    "話者1: 承知しました。",
    "",
    "話者1: 次の件で伺います。",
  ));
});

test("T04 boundary: the next segment's opening fragment of the previous utterance is dropped whatever its label (real two-segment run)", () => {
  // Excerpt of a real run with the new prompt: segment 1 (0:00-10:10) ends, segment 2 (10:00-20:10) begins. Segment 2
  // opens with the second half of 話者2's 09:47 line, misheard (「第40分ほどで」 for 「だいたい40分ほどで」) and labeled 話者1,
  // then repeats 話者1's 10:05 line, then continues with 「現場の雰囲気が…」 that only segment 2 heard.
  const s1 = lines(
    "[08:49] 話者1: 秋の合同説明会と生産技術部の件で伺います。これまでの説明会でうまくいったと感じた工夫はありますか。",
    "[08:59] 話者2: 秋の合同説明会で、生産技術部の先輩社員が自分の失敗談を話したときは、学生さんの反応がとても良かったです。飾らない話のほうが伝わるのだと感じました。",
    "[09:14] 話者1: 秋の合同説明会と総務部の件で伺います。動画はどこで見てもらうことを想定されていますか。",
    "[09:24] 話者2: 主に動画共有サイトで見てもらうことを考えています。秋の合同説明会の前に見てもらえれば、当日の説明がもっと深い話にできるのではないかと思っています。総務部からも同じような声",
    "[09:40] 話者1: 冬の先行会ではどのような内容を学生の方にお伝えしていますか。",
    "[09:47] 話者2: 冬の先行会では、会社の歴史と主力製品の紹介、それから生産技術部の若手社員による仕事の説明をしています。説明の時間はだいたい40分ほどで、その後に質問の時間を取り入れています。",
    "[10:05] 話者1: 生産技術部のお話、なるほど、よくわかりました。",
  );
  const s2 = lines(
    "[00:00] 話者1: 第40分ほどで、その後に質問の時間を取り入れています。",
    "[00:05] 話者1: 生産技術部のお話、なるほど、よくわかりました。",
    "[00:09] 話者1: 現場の雰囲気が伝わるかどうかが大切なのですね。",
    "[00:14] 話者1: 冬の先行会と設計部の件で伺います。",
    "[00:17] 話者1: 工場の中での撮影にはどのような決まりがありますか。",
    "[00:23] 話者2: 冬の先行会に関していいますと、設定部の区画は安全のために立ち入りの手順が決まっていて、ヘルメットと安全靴が必要です。",
    "[00:34] 話者2: 撮影する場合は事前に総務部に申請を出してもらう流れになります。",
    "[00:40] 話者1: オンライン説明会と品質保証部の件で伺います。",
  );
  const joined = joinTimedSegments([{ ...A, text: s1 }, { ...B, text: s2 }]);
  assert.equal(joined, `${stripTimestamps(s1)}\n\n${stripTimestamps(s2).split("\n").slice(2).join("\n")}`, "only the fragment and the repeated line are removed");
  assert.doesNotMatch(joined, /第40分/);
  assert.equal(joined.match(/生産技術部のお話、なるほど/gu).length, 1);
  assert.equal(joined.match(/現場の雰囲気が伝わるかどうか/gu).length, 1);

  const opening = first => joinTimedSegments([{ ...A, text: s1 }, { ...B, text: lines(first, "[00:30] 話者2: 次の回答です。") }]).split("\n\n")[1];
  assert.equal(opening("[00:02] 話者2: えーと40分ほどで、その後に質問の時間を取り入れています。"), "話者2: 次の回答です。", "up to 3 leading characters are skipped");
  // Kept: more than 3 characters to skip, starting after 2s, or too short to be sure.
  assert.match(opening("[00:00] 話者1: あのですね40分ほどで、その後に質問の時間を取り入れています。"), /^話者1: あのですね40分/);
  assert.match(opening("[00:03] 話者1: 第40分ほどで、その後に質問の時間を取り入れています。"), /^話者1: 第40分/);
  assert.match(opening("[00:00] 話者1: 取り入れ"), /^話者1: 取り入れ\n/);
});

test("T04 previous tail and completeness: the prompt tail has no times; early stops are detected only where they can be judged", () => {
  const segments = planTranscriptionSegments(1500).map((segment, i) => ({ ...segment, status: i === 0 ? "done" : "pending", attempts: i === 0 ? 1 : 0 }));
  segments[0].text = "[09:50] 話者1: ご予算はいかがですか。\n[09:58] 話者2: 予算は80万円です。";
  const job = { ...createTranscriptionJob(new Date("2026-09-29T00:00:00Z")), state: "transcribe", mode: "segmented", segments };
  assert.equal(previousSegmentTail(job, 1), "話者1: ご予算はいかがですか。\n話者2: 予算は80万円です。");
  assert.equal(previousSegmentTail(job, 1, 10), "予算は80万円です。", "the character budget applies to the text without times");
  // A budget that ends inside a line starts at the next line, so the model always sees the speaker name.
  assert.equal(previousSegmentTail(job, 1, 20), "話者2: 予算は80万円です。");
  assert.equal(transcriptionJob.PREVIOUS_TAIL_CHARS, 1200);
  assert.equal(previousSegmentTail(job, 0), undefined);

  // 610s segment: early when the last time is before 610 - max(90, 122) = 488s.
  assert.deepEqual(segmentCompleteness(job, 0, "[00:00] 話者1: あ\n[07:32] 話者2: い"), { endsEarly: true, lastSec: 452, durationSec: 610 });
  assert.equal(segmentCompleteness(job, 0, "[00:00] 話者1: あ\n[08:10] 話者2: い").endsEarly, false);
  assert.equal(segmentCompleteness(job, 0, "話者1: 時刻の無い出力").endsEarly, false);
  assert.equal(segmentCompleteness(job, 0, "[00:00] （聞き取れませんでした）").endsEarly, false);
  assert.equal(segmentCompleteness(job, 2, "[00:00] 話者1: 最後の区間は録音の終わりが無音のことがある").endsEarly, false);
  assert.equal(segmentCompleteness({ ...job, mode: "direct" }, 0, "[00:00] 話者1: あ").endsEarly, false);
  // A 5-minute half (after a split): 310 - max(90, 62) = 220s.
  const halves = { ...job, segments: [{ startSec: 0, endSec: 310, status: "pending", attempts: 0 }, { startSec: 300, endSec: 600, status: "pending", attempts: 0 }] };
  assert.equal(segmentCompleteness(halves, 0, "[03:30] 話者1: あ").endsEarly, true);
  assert.equal(segmentCompleteness(halves, 0, "[03:50] 話者1: あ").endsEarly, false);
  const short = { ...job, segments: [{ startSec: 0, endSec: 200, status: "pending", attempts: 0 }, { startSec: 190, endSec: 600, status: "pending", attempts: 0 }] };
  assert.equal(segmentCompleteness(short, 0, "[00:10] 話者1: あ").endsEarly, false, "segments under 240s are not checked");

  // A mistyped time beyond the segment (+5s) does not hide an early stop.
  assert.deepEqual(segmentCompleteness(job, 0, "[00:00] 話者1: あ\n[01:05] 話者2: い\n[17:05] 話者2: 誤った時刻\n[07:30] 話者1: ここで止まった"), { endsEarly: true, lastSec: 450, durationSec: 610 });
  assert.equal(segmentCompleteness(job, 0, "[00:00] 話者1: あ\n[10:15] 話者2: 区間の終わりの5秒後まで").lastSec, 615);
  // A segment ending within max(90s, 20%) of the recording end is treated like the last one (trailing silence).
  const near = (durationSec, text) => segmentCompleteness({ ...job, durationSec, segments: planTranscriptionSegments(durationSec) }, 0, text).endsEarly;
  assert.equal(near(700, "[00:00] 話者1: あ\n[07:00] 話者2: 録音の終わりまで無音"), false, "700 - 610 = 90 <= 122");
  assert.equal(near(732, "[00:00] 話者1: あ\n[07:00] 話者2: い"), false, "732 - 610 = 122 <= 122");
  assert.equal(near(733, "[00:00] 話者1: あ\n[07:00] 話者2: い"), true, "733 - 610 = 123 > 122");

  const first = "[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。";
  assert.equal(betterSegmentText(first, "[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。\n[10:05] 話者1: 続き。", 610), "[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。\n[10:05] 話者1: 続き。");
  assert.equal(betterSegmentText(first, "[05:00] 話者1: 再試行はもっと早く止まったけれど長い発話です。", 610), first);
  // Same last time → the first run, even if the retry is longer.
  assert.equal(betterSegmentText(first, "[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。再試行の方が長い。", 610), first);
  // A later-ending retry that skipped the middle (under 90% of the first run's spoken text) loses.
  assert.equal(betterSegmentText(first, "[00:00] 話者1: 一回目の\n[10:05] 話者1: 最後。", 610), first);
  assert.equal(spokenTextLength("[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。"), 16);
  const ninety = "[00:00] 話者1: 一回目の発話です\n[10:05] 話者2: 一回目の最後"; // 8 + 6 = 14 < 0.9 × 16 = 14.4
  assert.equal(betterSegmentText(first, ninety, 610), first);
  assert.equal(betterSegmentText(first, `${ninety}で`, 610), `${ninety}で`, "15 >= 14.4");
  // A retry whose only late time is beyond the segment does not win.
  assert.equal(betterSegmentText(first, "[00:00] 話者1: 一回目の発話です。\n[07:00] 話者2: 一回目の最後です。\n[12:40] 話者1: 誤った時刻", 610), first);
  assert.equal(betterSegmentText(first, "話者1: 時刻の無い再試行の出力はとても長いが時刻が無い", 610), first);

  // The prompt switches to the old "do not repeat the overlap" instruction after an untimed segment of an older job.
  assert.equal(previousSegmentTimed(job, 0), undefined);
  assert.equal(previousSegmentTimed(job, 1), true);
  const legacy = { ...job, segments: job.segments.map((segment, i) => i === 0 ? { ...segment, text: "話者1: ご予算はいかがですか。\n話者2: 予算は80万円です。" } : segment) };
  assert.equal(previousSegmentTimed(legacy, 1), false);
});

test("T04 boundary (review round 2): a later, different utterance after a matched line is never swallowed", () => {
  // After the first next line fully matched the last prev line, the 611 s question exists only in the next segment.
  const joined = joinTimedSegments([
    { ...A, text: lines("[09:50] 話者1: 製造部のお話、承知しました。", "[09:55] 話者2: はい。", "[10:02] 話者1: 工場見学会と製造部の件で伺います。") },
    { ...B, text: lines("[00:02] 話者1: 工場見学会と製造部の件で伺います。", "[00:08] 話者2: 回答です。", "[00:11] 話者1: 工場見学会と営業部の件で伺います。", "[00:30] 話者2: 次の回答です。") },
  ]);
  assert.match(joined, /工場見学会と営業部の件で伺います。/);
  assert.equal(joined.match(/工場見学会と製造部の件で伺います。/g).length, 1);
  const thanks = joinTimedSegments([
    { ...A, text: lines("[09:30] 話者2: ご説明ください。", "[10:00] 話者1: 本日の説明は以上です。ありがとうございます。") },
    { ...B, text: lines("[00:04] 話者1: ありがとうございます。", "[00:09] 話者1: ありがとうございます。", "[00:30] 話者2: 次です。") },
  ]);
  assert.equal(thanks.match(/ありがとうございます。/g).length, 2, "the second thanks at 609 s stays");
});

test("T04 boundary (review round 2): a prev line far before the overlap is not compared, so a new utterance is kept", () => {
  // The previous segment has nothing in its last 13 s; its 6:40 line cannot reach the overlap.
  const joined = joinTimedSegments([
    { ...A, text: "[06:40] 話者1: 資料は来週までにお送りします。よろしくお願いいたします。" },
    { ...B, text: lines("[00:01] 話者2: よろしくお願いいたします。", "[00:20] 話者1: では次の議題です。") },
  ]);
  assert.match(joined, /話者2: よろしくお願いいたします。/);
});

test("T04 boundary (review round 2): a misread 'label' that is really part of the sentence never duplicates text", () => {
  const joined = joinTimedSegments([
    { ...A, text: lines("[09:40] 話者1: 撮影の条件はありますか。", "[10:05] 条件は二つです：安全靴が必要です") },
    { ...B, text: lines("[00:05] 話者2: 条件は二つです：安全靴が必要です。ヘルメットも必要です。", "[00:20] 話者1: 承知しました。") },
  ]);
  assert.doesNotMatch(joined, /条件は二つです：条件は二つです/);
  assert.match(joined, /ヘルメットも必要です。/);
});

test("T04 boundary (review round 2): while one prev line is reused, only lines contained in it can be dropped", () => {
  // The first next line is the start of the prev line (the prev line continues), so the matcher stays on it. The 611 s
  // question is similar to that line but is a different utterance, so it must stay.
  const joined = joinTimedSegments([
    { ...A, text: lines("[09:50] 話者2: はい。", "[10:02] 話者1: 工場見学会と製造部の件で伺います。") },
    { ...B, text: lines("[00:02] 話者1: 工場見学会と製造部の件で", "[00:11] 話者1: 工場見学会と営業部の件で伺います。", "[00:30] 話者2: 次の回答です。") },
  ]);
  assert.match(joined, /工場見学会と営業部の件で伺います。/);
  assert.equal(joined.match(/工場見学会と製造部の件で/g).length, 1);
});

test("T04 word-spaced Japanese output is collapsed; ordinary spacing is kept", () => {
  const { collapseJapaneseWordSpacing: collapse } = timedTranscript;
  // Recorded on the live site (gemini-3.5-flash-lite, 2026-09-29): one whole segment came back spaced word by word.
  assert.equal(collapse("話者2: 撮影 の 開始 時期 は 未定 です 。"), "話者2: 撮影の開始時期は未定です。");
  assert.equal(collapse("[06:32] 話者2: 撮影 の 開始 時期 は 未定 です 。"), "[06:32] 話者2: 撮影の開始時期は未定です。", "the timestamp and label spacing stay");
  assert.equal(collapse("話者1: Luma の 採用 動画 は 3 本 です 。"), "話者1: Luma の採用動画は 3 本です。", "spaces next to Latin letters and digits stay");
  for (const line of ["話者1: 株式会社 ルマの田中です。", "話者2: はい、承知しました。", "話者1: A案 と B案 です。", "", "（聞き取れませんでした）"]) {
    assert.equal(collapse(line), line, line);
  }
  assert.equal(collapse("話者1: 本日 は よろしく お願い いたします 。\n話者2: 株式会社 ルマです。"), "話者1: 本日はよろしくお願いいたします。\n話者2: 株式会社 ルマです。", "only the spaced line changes");
});
