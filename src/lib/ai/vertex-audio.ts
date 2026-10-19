import fs from "node:fs/promises";
import path from "node:path";
import { vertexGenerate } from "./vertex";
import { normalizeMeetTranscriptSpacing } from "@/lib/meetings/timed-transcript";
import { vertexConfiguration, VertexError, VERTEX_MAX_OUTPUT } from "./vertex-policy";

const TRANSCRIPTION_SYSTEM = "商談音声を忠実に文字起こししてください。聞こえた発話だけを日本語で出力し、推測で補わないでください。話者が区別できれば話者1、話者2と記載。無音の場合は（聞き取れませんでした）とのみ記載してください。";

/**
 * 長時間録音を区間に分けて送るときの位置情報（T04）。overlapSec は直前の区間と重なる秒数。
 * previousTimed が false なら、直前の区間の本文に時刻が無い（旧版で始まったジョブ）。連結時に重なりの重複を除けないため、
 * 重なりの発話を繰り返さないよう指示する（旧版の指示）。
 */
export type VertexTranscriptionSegment = { index: number; total: number; startSec: number; endSec: number; overlapSec?: number; previousTimed?: boolean };

function clock(totalSec: number) {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = String(Math.floor((sec % 3600) / 60)).padStart(hours > 0 ? 2 : 1, "0");
  return `${hours > 0 ? `${hours}:` : ""}${minutes}:${String(sec % 60).padStart(2, "0")}`;
}

function segmentPrompt(segment: VertexTranscriptionSegment, previousTail?: string) {
  const lines = [
    `この音声は1本の商談録音を分割した区間${segment.index + 1}/${segment.total}（録音全体の${clock(segment.startSec)}〜${clock(segment.endSec)}）です。`,
    "この区間の文字起こし本文だけを出力してください。区間の先頭・末尾で途切れた発話は、聞き取れた部分だけを書いてください。",
    // 長い記録の分析（原文抜粋）と根拠照合は1行を1つの発話として扱うため、区間の文字起こしは発話ごとに改行してもらう。
    // 行頭の時刻はアプリが区間のつなぎ目の重複除去・書き漏れの確認に使い、本文からは外す。
    "話者が変わるごと、または発話の区切りごとに改行し、1行に1つの発話を書いてください。各行は「[MM:SS] 話者1: 発話」のように、発話が始まった時刻と話者名から始めてください。MM:SS は録音全体の時刻ではなく、この区間の音声の先頭からの経過時間（分:秒）です。話者が区別できない行も時刻から始めてください。",
  ];
  if (segment.index > 0 && segment.previousTimed === false) {
    lines.push("直前の区間と重なる冒頭の数秒で同じ発話が聞こえる場合は繰り返さないでください。");
  } else if (segment.index > 0) {
    const overlap = segment.overlapSec && segment.overlapSec > 0 ? `最初の約${Math.round(segment.overlapSec)}秒` : "最初の数秒";
    lines.push(`この区間の音声の${overlap}は、直前の区間の終わりと重なっています。重なっている部分の発話も省かずに書いてください（重複はアプリ側で取り除きます）。`);
  }
  lines.push("区間の最後（この音声の終わり）まで、聞こえた発話をすべて書いてください。途中で書くのをやめたり、省略・要約したりしないでください。同じ話者が続けて話した発話や、短い返事も省かないでください。");
  if (previousTail) {
    lines.push(
      "参考：直前の区間の末尾は次のとおりです。話者の番号をこれに合わせてください（同じ人には同じ番号を使ってください）。この参考文自体は出力しないでください。",
      "<<<直前の区間の末尾",
      previousTail,
      "直前の区間の末尾>>>",
    );
  }
  return lines.join("\n");
}

/**
 * 区間に分けない短い録音の依頼文。根拠照合は1行を1つの発話として扱うため、区間の依頼文（segmentPrompt）と同じく
 * 発話ごとに改行してもらう（T04: 改行の無い1行の文字起こしで、議事録の課題・対応予定と BANT の根拠がすべて落ちた）。
 * 単発の出力は時刻を外す処理を通らないので、行頭の時刻は求めない。
 */
const DIRECT_PROMPT = [
  "この音声の文字起こし本文だけを出力してください。",
  "話者が変わるごと、または発話の区切りごとに改行し、1行に1つの発話を書いてください。話者が区別できる場合は、各行を「話者1: 発話」のように話者名から始めてください。",
].join("\n");

export async function vertexTranscribeWithMetrics(
  filepath: string,
  options: { segment?: VertexTranscriptionSegment; previousTail?: string; maxAttempts?: number } = {},
) {
  const config = vertexConfiguration();
  const started = new Date();
  const size = (await fs.stat(filepath)).size;
  const mimeType = ({ wav: "audio/wav", webm: "audio/webm", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac" } as Record<string, string>)[path.extname(filepath).slice(1).toLowerCase()];
  if (!mimeType || size < 1 || size > 6 * 1024 * 1024) throw new VertexError("audio_limit", "AI接続検証では6MB以下のWAV・WebM・MP3・M4A・OGG・FLAC音声を使用してください。");
  const data = (await fs.readFile(filepath)).toString("base64");
  const segment = options.segment;
  const result = await vertexGenerate({
    // 区間は10分ぶんの発話を受け取るため、出力をポリシー上限まで使う。単発の短い録音は従来どおり。
    feature: "transcription", maxTokens: segment ? VERTEX_MAX_OUTPUT : 4096,
    system: TRANSCRIPTION_SYSTEM,
    user: segment ? segmentPrompt(segment, options.previousTail) : DIRECT_PROMPT,
    audio: { data, mimeType },
    // 書き漏れの再試行のような任意の呼出しは 1（429 で予約し直さない）。省略時は vertexGenerate の既定（最大3回）。
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
  const completed = new Date();
  // 語ごとに空白で区切られた日本語の出力（まれに1区間まるごと）は、日本語の文字の間の空白だけを外す。
  // T04/T06: 数字と単位・助詞の間の空白（「4 月」「280 万円」）も Meet の文字起こしと同じ規則で詰め、
  // 時期・金額の照合が原文どおりに一致するようにする（時刻・話者ラベル・英字の前後の空白は残る）。
  return { text: normalizeMeetTranscriptSpacing(result.text), metrics: {
    provider: "vertex" as const, model: config.model, inputMode: "inline" as const, inputBytes: size, mimeType,
    startedAt: started.toISOString(), completedAt: completed.toISOString(), elapsedMs: completed.getTime() - started.getTime(), usage: result.usage,
  } };
}
