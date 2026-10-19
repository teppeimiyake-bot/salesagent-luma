// T04/T06: 区間の文字起こし（Vertex）が「4 月の新人研修」「280 万円」のように数字と単位の間に空白を入れると、
// 時期・金額の照合（timeExpression・金額の正規表現など）が合わず、会議の BANT の時期が「未確定」になる。
// Meet の文字起こしと同じ正規化（normalizeMeetTranscriptSpacing）を保存前に掛け、既に保存された空白入りの
// 文字起こしでも時期の根拠が通るよう timeExpression は数字と単位の間の空白を許す。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offlineModule } from "./helpers/offline-module.mjs";
import timeline from "../src/lib/ai/timeline-evidence.ts";
import definitions from "../src/lib/ai/bant-definitions.ts";

const { groundTimeline } = timeline;
const { BANT_UNKNOWN_VALUES } = definitions;

test("T04 Vertex transcription output closes digit/unit gaps like Meet (dates, amounts), keeping times, labels and other spaces", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t04-spacing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "segment.mp3");
  await writeFile(file, Buffer.from("fake mp3"));
  const raw = [
    "[04:41] 話者1: 4 月の新人研修に間に合えば十分です。",
    "[04:50] 話者2: 予算は 280 万円を上限にしています。",
    "[05:02] 話者1: 研修の流れですが、 2 日目は実技をします。",
    "[05:10] 話者2: 撮影 の 開始 時期 は 未定 です 。",
    "[05:20] 話者1: 株式会社 ルマ の Luma 2 を使います。",
  ].join("\n");
  const m = {};
  const lib = await offlineModule("src/lib/ai/vertex-audio.ts", m, {
    "./vertex": `export const vertexGenerate=async()=>({text:${JSON.stringify(raw)},usage:{totalTokenCount:1}});`,
    "./vertex-policy": "export const vertexConfiguration=()=>({model:'gemini-2.5-flash'});export class VertexError extends Error{constructor(c,m){super(m);this.code=c}};export const VERTEX_MAX_OUTPUT=8192;",
  }, ["src/lib/ai/vertex-audio.ts", "src/lib/meetings/timed-transcript.ts"], ["node:fs/promises", "node:path"]);
  const { text } = await lib.vertexTranscribeWithMetrics(file, { segment: { index: 0, total: 6, startSec: 0, endSec: 610, overlapSec: 0 } });
  assert.deepEqual(text.split("\n"), [
    "[04:41] 話者1: 4月の新人研修に間に合えば十分です。",
    "[04:50] 話者2: 予算は280万円を上限にしています。",
    "[05:02] 話者1: 研修の流れですが、2日目は実技をします。",
    "[05:10] 話者2: 撮影の開始時期は未定です。",
    "[05:20] 話者1: 株式会社 ルマ の Luma 2を使います。",
  ]);
});

test("T04/T06 an already-saved transcript with a digit/unit gap still grounds the Timeline; unrelated or withdrawn dates do not", () => {
  for (const source of [
    "話者1: 4 月の新人研修に間に合えば十分です。",
    "話者1: 4　月の新人研修に間に合えば十分です。",
    "顧客：導入は 2027 年 4 月を希望します。",
    "顧客：来年 5 月の採用サイトの刷新に合わせて公開できれば十分です。",
  ]) assert.equal(groundTimeline(source, [1]).value, `文字起こし記載: ${source}`, source);
  for (const source of [
    "話者1: 時期についても 1 月の研修から使いたいと言いましたが、撤回します。",
    "顧客：次回の打ち合わせは 10 月 23 日の 14 時です。",
    "顧客：10 月 16 日までに見積をいただければ十分です。",
    "顧客：4 月の新人研修に間に合えば十分ですか？",
  ]) assert.equal(groundTimeline(source, [1]).value, BANT_UNKNOWN_VALUES.timeline, source);
});
