// T16: Google Meet の文字起こしの空白の正規化（数字と日本語の間、語ごとの区切り）。純関数と、Meet の発言の組み立てを
// ネットワーク無しで確かめる。本文はすべて架空の商談（2026-09-30 の実 Meet に流した架空の台本の読み上げ）。
import test from "node:test";
import assert from "node:assert/strict";
import timedTranscript from "../src/lib/meetings/timed-transcript.ts";
import { offlineModule } from "./helpers/offline-module.mjs";

const { normalizeMeetTranscriptSpacing: normalize } = timedTranscript;

test("spaces between digits and Japanese are removed so dates and amounts read as written", () => {
  // Shapes returned by the Meet REST API for ja-JP (2026-09-30).
  const cases = [
    ["ドライバーと倉庫スタッフの応募が去年から 3 割ほど減っています。", "ドライバーと倉庫スタッフの応募が去年から3割ほど減っています。"],
    ["当初は 300 万円で考えていました。ただ先日の予算会議で見直しがあって上限は 250 万円になりました。", "当初は300万円で考えていました。ただ先日の予算会議で見直しがあって上限は250万円になりました。"],
    ["これとあれさはなんかセットで 来年 4 月の新卒向け説明会に間に合わせたいです。", "これとあれさはなんかセットで 来年4月の新卒向け説明会に間に合わせたいです。"],
    ["ありがとうございます。では 10 月 10 日までに見積書をお送りします。", "ありがとうございます。では10月10日までに見積書をお送りします。"],
    ["はい、 10 月 17 日の 15 時で大丈夫です。", "はい、10月17日の15時で大丈夫です。"],
    ["締めは ２ 月です。", "締めは２月です。"],
    ["撮影は 10 時 30 分から、 3 か月ほどかけます。", "撮影は10時30分から、3か月ほどかけます。"],
    ["（ 10 月末 ）まで", "（10月末 ）まで"],
    ["単価は 2.5 万円です。", "単価は2.5万円です。"],
  ];
  for (const [raw, expected] of cases) assert.equal(normalize(raw), expected, raw);
});

test("only a digit and its unit, particle or preceding Japanese are tightened; other spaces stay", () => {
  const cases = [
    // Latin letters keep their spaces; only the digit next to its unit or particle is tightened.
    ["品番は ABC 123 です。", "品番は ABC 123です。"],
    ["iPhone 15 Pro を使っています。", "iPhone 15 Pro を使っています。"],
    ["A 社は 3 月に導入します。", "A 社は3月に導入します。"],
    // Spaces between numbers stay, and full-width ，． never join two numbers (2026-09-30 review).
    ["候補は 10 20 30 のどれかです。", "候補は10 20 30のどれかです。"],
    ["予算は 300 ， 250 万円の 2 案です。", "予算は300 ， 250万円の2 案です。"],
    ["合計は 3 ． 4 月からは 5 です。", "合計は3 ． 4月からは5です。"],
    // A number without a unit keeps the space before the next phrase.
    ["部屋番号は 301 担当は田中です。", "部屋番号は301 担当は田中です。"],
    ["予算は 300 次に納期ですが", "予算は300 次に納期ですが"],
    // An intended space in a name, and sentence-separating spaces, stay (fewer than three Japanese gaps).
    ["株式会社 ルマ の田中です。", "株式会社 ルマ の田中です。"],
    ["よろしくお願いします。 早速ですが、課題から伺えますか? はい。", "よろしくお願いします。 早速ですが、課題から伺えますか? はい。"],
    // Whether an utterance is word-spaced is decided on the line as written: removing the digit gaps first must not
    // tip an enumeration over the threshold (2026-09-30 review).
    ["出席者 田中 佐藤 鈴木。 日程は 10 月 10 日 の 15 時。", "出席者 田中 佐藤 鈴木。 日程は10月10日 の15時。"],
    ["ライト スタンダード プレミアム 月額 1000 円 2000 円 3000 円", "ライト スタンダード プレミアム 月額1000円2000円3000円"],
    // A whole utterance split into words is closed up with the existing rule (collapseJapaneseWordSpacing).
    ["で は その 日 に 動画 の 構成 案 を お 持ち し ます 。", "ではその日に動画の構成案をお持ちします。"],
    ["そう だ ね 。 3 月 まで に 終わら せ ます 。", "そうだね。3月までに終わらせます。"],
    // Lines are handled independently.
    ["森: 10 月 10 日\n森: 株式会社 ルマ です。", "森: 10月10日\n森: 株式会社 ルマ です。"],
  ];
  for (const [raw, expected] of cases) assert.equal(normalize(raw), expected, raw);
  // Without digits the Meet rule is exactly collapseJapaneseWordSpacing.
  for (const text of ["ウィンドウズ マック リナックス の 3 つ", "株式会社 ルマ の田中です。", "で は その 日 に"]) {
    assert.equal(normalize(text.replace(/[0-9]/gu, "")), timedTranscript.collapseJapaneseWordSpacing(text.replace(/[0-9]/gu, "")), text);
  }
});

test("Meet transcript entries are normalized once, for both the saved text and the segments", async () => {
  const lib = await offlineModule("src/lib/google/meet-artifacts.ts", {}, {
    googleapis: "export const google={};",
    "./meet": "export class GoogleMeetOperationError extends Error{};export const createMeetOAuthClient=()=>{throw Error('no network')};",
  }, ["src/lib/google/meet-artifacts.ts", "src/lib/meetings/timed-transcript.ts"]);
  const entries = [
    { participant: "conferenceRecords/r/participants/1", text: "では 10 月 10 日までに見積書をお送りします。", startTime: "2026-09-30T02:10:00Z", endTime: "2026-09-30T02:10:05Z" },
    { participant: "conferenceRecords/r/participants/1", text: "   " },
    { participant: "conferenceRecords/r/participants/2", text: "で は その 日 に 動画 の 構成 案 を お 持ち し ます 。" },
  ];
  const { segments, text } = lib.normalizeTranscriptEntries(entries, new Map([["conferenceRecords/r/participants/1", "森雄士郎"]]));
  // The module runs in a separate VM realm; compare plain JSON values.
  assert.deepEqual(JSON.parse(JSON.stringify(segments.map(s => [s.speaker, s.text]))), [
    ["森雄士郎", "では10月10日までに見積書をお送りします。"],
    ["話者1", "ではその日に動画の構成案をお持ちします。"],
  ]);
  assert.equal(text, "森雄士郎: では10月10日までに見積書をお送りします。\n話者1: ではその日に動画の構成案をお持ちします。");
});
