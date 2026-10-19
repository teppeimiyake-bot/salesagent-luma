/**
 * T04/T22: ffmpeg による音声の正規化・長さの確認・区間の切り出し。
 *
 * - 動画は音声トラックだけを取り出し、映像のトークン・費用を発生させない。
 * - どの入力形式も mono 16kHz・32kbps の MP3 にそろえる。10分でも約2.4MBで、
 *   Vertex の inline 6MiB 以内に収まる。
 * - シェルは使わず引数配列で起動し、時間切れは強制終了する。利用者向けの
 *   メッセージにはファイルパスや ffmpeg の出力を含めない。
 * - 入力形式は拡張子から明示し、読み込めるプロトコルも file（パート連結時は concat）に限る。
 *   中身が ffconcat や HLS のプレイリストでも、他のファイルを読み込ませない。
 */
import { spawn } from "node:child_process";

const FFMPEG = "ffmpeg";
const FFPROBE = "ffprobe";
const PROBE_TIMEOUT_MS = 5_000;
export const NORMALIZE_TIMEOUT_MS = 200_000;
const CUT_TIMEOUT_MS = 60_000;

export class MediaToolError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "MediaToolError";
  }
}

type RunResult = { code: number | null; stdout: string; stderrTail: string };

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MediaToolError("media_timeout", "音声の変換が制限時間内に終わりませんでした。ファイルを短くするか、音声だけに書き出して再試行してください。"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 4096) stdout += chunk.toString("utf8"); });
    // 失敗時の調査用に末尾だけ保持する。
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderrTail: stderr });
    });
  });
}

/** 受け付ける拡張子ごとの ffmpeg デマルチプレクサ（自動判定させない）。 */
const INPUT_FORMATS: Record<string, string> = {
  mp3: "mp3", wav: "wav", webm: "matroska", mkv: "matroska", m4a: "mov", mp4: "mov", mov: "mov",
  ogg: "ogg", oga: "ogg", flac: "flac", aac: "aac", aiff: "aiff", avi: "avi", mpeg: "mpeg", mpg: "mpeg",
};

export function inputFormatFor(extension: string): string | null {
  return INPUT_FORMATS[extension.toLowerCase()] ?? null;
}

let availability: Promise<boolean> | null = null;
let unavailableSince = 0;
const UNAVAILABLE_RECHECK_MS = 60_000;

/**
 * ffmpeg と ffprobe が実行できるか。成功はプロセス内でキャッシュし、失敗（起動直後の遅延など）は
 * 1分後に確認し直す。失敗を固定すると、再起動まで長時間録音・動画をすべて拒否してしまうため。
 */
export function mediaToolsAvailable(): Promise<boolean> {
  if (availability && unavailableSince && Date.now() - unavailableSince > UNAVAILABLE_RECHECK_MS) availability = null;
  availability ??= Promise.all([
    run(FFMPEG, ["-hide_banner", "-version"], PROBE_TIMEOUT_MS),
    run(FFPROBE, ["-hide_banner", "-version"], PROBE_TIMEOUT_MS),
  ]).then(results => results.every(result => result.code === 0), () => false).then(ok => {
    unavailableSince = ok ? 0 : Date.now();
    return ok;
  });
  return availability;
}

function failure(tool: string, result: RunResult, code: string, message: string): never {
  console.error("[audio-segments] media tool failed", { tool, exitCode: result.code, stderrTail: result.stderrTail });
  throw new MediaToolError(code, message);
}

/** 入力が複数（分割アップロードのパート）なら、バイト列を順に連結して読む。 */
function inputArgument(inputs: string[]) {
  if (inputs.length === 0) throw new MediaToolError("media_input", "変換する録音ファイルがありません。");
  if (inputs.some(input => input.includes("|"))) throw new MediaToolError("media_input", "録音ファイルの保存場所を確認できませんでした。");
  return inputs.length === 1 ? inputs[0] : `concat:${inputs.join("|")}`;
}

/** 最初の音声トラックを mono 16kHz・32kbps の MP3 に書き出す。映像・字幕・データは読み捨てる。 */
export async function normalizeToSpeechMp3(inputs: string[], output: string, { extension, timeoutMs = NORMALIZE_TIMEOUT_MS }: { extension: string; timeoutMs?: number }) {
  const format = inputFormatFor(extension);
  if (!format) throw new MediaToolError("media_input", "この形式の録音は文字起こしできません。mp3/m4a/wav/webm/mp4 などを添付してください。");
  const result = await run(FFMPEG, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-protocol_whitelist", inputs.length > 1 ? "file,concat" : "file",
    "-threads", "1", "-f", format,
    "-i", inputArgument(inputs),
    "-map", "0:a:0", "-vn", "-sn", "-dn", "-threads", "1",
    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k",
    "-write_xing", "0", "-f", "mp3", output,
  ], timeoutMs);
  if (result.code !== 0) {
    const noAudio = /matches no streams|does not contain any stream|Output file .* does not contain/i.test(result.stderrTail);
    failure("ffmpeg", result, noAudio ? "media_no_audio" : "media_convert",
      noAudio
        ? "このファイルには音声トラックが見つかりませんでした。音声付きの録画か録音を添付してください。"
        : "録音ファイルを文字起こし用の音声に変換できませんでした。ファイルが壊れていないか確認し、音声（mp3/m4a/webm）に書き出して再試行してください。");
  }
}

/** 音声の長さ（秒）。形式は拡張子から明示する（正規化済みの音声は mp3）。 */
export async function probeDurationSec(input: string, extension = "mp3") {
  const format = inputFormatFor(extension);
  if (!format) throw new MediaToolError("media_input", "この形式の録音は文字起こしできません。");
  const result = await run(FFPROBE, ["-v", "error", "-protocol_whitelist", "file", "-f", format, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input], PROBE_TIMEOUT_MS * 6);
  const duration = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isFinite(duration) || duration <= 0) {
    failure("ffprobe", result, "media_duration", "録音の長さを確認できませんでした。ファイルが壊れていないか確認して再試行してください。");
  }
  return duration;
}

/** 正規化済み MP3 から区間を切り出す（再エンコードしない）。 */
export async function cutSegment(input: string, output: string, startSec: number, durationSec: number) {
  const result = await run(FFMPEG, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-protocol_whitelist", "file", "-f", "mp3",
    "-ss", startSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", input,
    "-map", "0:a:0", "-c", "copy", "-write_xing", "0", "-f", "mp3", output,
  ], CUT_TIMEOUT_MS);
  if (result.code !== 0) failure("ffmpeg", result, "media_cut", "録音の区間を切り出せませんでした。「文字起こし再実行」で再試行してください。");
}
