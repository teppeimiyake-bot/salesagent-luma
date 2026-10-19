/**
 * T04/T22: 長時間音声・動画を区間ごとに文字起こしするジョブの状態（純関数のみ）。
 *
 * Cloud Run は1リクエスト300秒・リクエスト外のCPU割当なしのため、60／90分の録音を
 * 1回の処理で終えられない。進捗を meeting.meta.transcriptionJob に区間単位で保存し、
 * 継続リクエストが途中から再開できるようにする。DB・ffmpeg・AIには依存しない。
 */
import { isNoSpeechTranscript, isTimedTranscript, joinTimedSegments, lastTimestampSec, parseTimedTranscript, spokenTextLength, stripTimestamps } from "./timed-transcript";

/**
 * 継続処理（202即応答→区間ごとに再開）を使うか。Cloud Run の Vertex 検証環境だけが対象で、
 * ローカル開発・Vercel の after() 経路は従来どおり。
 */
export function isTranscriptionJobMode(env: NodeJS.ProcessEnv = process.env) {
  return env.LUMA_CLOUD_AI_MODE === "vertex";
}

/** 1区間の長さ。10分なら音声入力は約1.9万tokensで、1回の上限32,768tokens・20円予約に収まる。 */
export const TRANSCRIPTION_SEGMENT_SEC = 600;
/**
 * 区間境界で発話が途切れないよう、次の区間と重ねる秒数。重なりの発話は両方の区間で書かせ、
 * 連結時に時刻と本文で照合して重複を除く（joinTranscriptionSegments）。610秒でも約1.95万tokensで上限に収まる。
 */
export const TRANSCRIPTION_OVERLAP_SEC = 10;
/** 出力上限などで失敗した区間を半分に分けるとき、これより短くは分けない。 */
export const TRANSCRIPTION_MIN_SPLIT_SEC = 150;
/** 1件で受け付ける最大の長さ（3時間＝18区間）。 */
export const TRANSCRIPTION_MAX_DURATION_SEC = 3 * 60 * 60;
/** 同じ区間・準備を試す上限（中断・一時的な失敗の自動再試行を含む）。 */
export const TRANSCRIPTION_MAX_STEP_ATTEMPTS = 3;

/**
 * 1件の文字起こしで区間の文字起こしを呼ぶ回数の上限（区間数の2倍、最低4回）。
 * 通常の60分（6区間）は6回・120円の予約。1回の呼出しは429の再試行で最大3件（60円）まで
 * 予約しうるため、上限まで使った最悪は60分で約720円。分割で区間が増えると上限も増え、
 * 利用者の「文字起こし再実行」でも数え直す。これを超えたら止め、共有の検証予算を1件で使い切らない。
 */
export function transcriptionAttemptLimit(job: TranscriptionJob) {
  return Math.max(4, job.segments.length * 2);
}

/**
 * 呼び出し回数の上限。書き漏れの再試行（1区間1回まで、completenessRetried）は、一時的な失敗の再試行の枠
 * （transcriptionAttemptLimit）とは別に数える。任意の再試行のせいで、後の区間の一時的な失敗が上限に当たらないようにする。
 */
export function transcriptionCallLimit(job: TranscriptionJob) {
  return transcriptionAttemptLimit(job) + job.segments.filter(segment => segment.completenessRetried === true).length;
}

export type TranscriptionSegmentStatus = "pending" | "done" | "error";

export type TranscriptionSegment = {
  startSec: number;
  endSec: number;
  status: TranscriptionSegmentStatus;
  attempts: number;
  /**
   * モデルの出力（区間の文字起こしは行頭に「[MM:SS]」の時刻が付く）。利用者・後段へは
   * joinTranscriptionSegments・previousSegmentTail で時刻を外してから渡す。
   * status が pending のまま本文がある区間は、書き漏れの再試行を待っている（1回目の結果）。
   */
  text?: string;
  /** 書き漏れ（途中で止まった出力）の再試行を始めた。再試行は1区間1回まで。 */
  completenessRetried?: boolean;
  usage?: Record<string, number>;
  elapsedMs?: number;
  error?: string;
};

export type TranscriptionJob = {
  version: 1;
  /** prepare: 音声の正規化・長さの確認前／transcribe: 区間の文字起こし中／done: 完了 */
  state: "prepare" | "transcribe" | "done";
  /** direct: 元の短い音声をそのまま1回で送る／segmented: 正規化した音声を区間に分けて送る */
  mode?: "direct" | "segmented";
  durationSec?: number;
  segments: TranscriptionSegment[];
  /** 文字起こし完了後に、継続処理から議事録・BANTの分析へつなぐ。 */
  autoAnalyze: boolean;
  /** 動画・分割アップロードなど、元ファイルをそのまま再生できない場合の再生用音声。 */
  playbackFile?: string;
  /** 準備（ffmpeg）を始めた回数。中断が続く入力を際限なく処理し直さない。 */
  prepareAttempts?: number;
  /** Vertex を呼んだ回数の累計（予約の上限管理）。 */
  vertexAttempts?: number;
  /** 元の音声を1回で送る方式が出力・入力上限に達したため、区間分割にする。 */
  forceSegmented?: boolean;
  createdAt: string;
  updatedAt: string;
};

export function createTranscriptionJob(now: Date, autoAnalyze = true): TranscriptionJob {
  return { version: 1, state: "prepare", segments: [], autoAnalyze, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

function finiteSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** meta に保存された値を検証して取り出す。形が壊れていれば null（最初から準備し直す）。 */
export function readTranscriptionJob(meta: unknown): TranscriptionJob | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).transcriptionJob;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const job = raw as Partial<TranscriptionJob>;
  if (job.version !== 1 || !["prepare", "transcribe", "done"].includes(job.state as string) || !Array.isArray(job.segments)) return null;
  const segments = job.segments.filter((segment): segment is TranscriptionSegment =>
    !!segment && finiteSeconds(segment.startSec) && finiteSeconds(segment.endSec) && segment.endSec > segment.startSec
    && ["pending", "done", "error"].includes(segment.status) && Number.isSafeInteger(segment.attempts));
  if (segments.length !== job.segments.length) return null;
  if (job.state !== "prepare" && segments.length === 0) return null;
  return {
    version: 1,
    state: job.state as TranscriptionJob["state"],
    mode: job.mode === "direct" || job.mode === "segmented" ? job.mode : undefined,
    durationSec: finiteSeconds(job.durationSec) ? job.durationSec : undefined,
    segments,
    autoAnalyze: job.autoAnalyze !== false,
    playbackFile: typeof job.playbackFile === "string" && /^[a-z0-9._-]+$/i.test(job.playbackFile) ? job.playbackFile : undefined,
    prepareAttempts: Number.isSafeInteger(job.prepareAttempts) ? job.prepareAttempts : undefined,
    vertexAttempts: Number.isSafeInteger(job.vertexAttempts) ? job.vertexAttempts : undefined,
    forceSegmented: job.forceSegmented === true ? true : undefined,
    createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date(0).toISOString(),
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date(0).toISOString(),
  };
}

export function withTranscriptionJob(meta: unknown, job: TranscriptionJob | null): Record<string, unknown> {
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...(meta as Record<string, unknown>) } : {};
  if (job) base.transcriptionJob = job;
  else delete base.transcriptionJob;
  return base;
}

/** 長さから区間を作る。最後の区間は録音の終わりで止め、各区間は次の区間と少し重ねる。 */
export function planTranscriptionSegments(durationSec: number, segmentSec = TRANSCRIPTION_SEGMENT_SEC, overlapSec = TRANSCRIPTION_OVERLAP_SEC): TranscriptionSegment[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("録音の長さを確認できませんでした。");
  const segments: TranscriptionSegment[] = [];
  for (let start = 0; start < durationSec; start += segmentSec) {
    const end = Math.min(durationSec, start + segmentSec + overlapSec);
    // 端数が重なり分しか残らない場合は、直前の区間に含まれている。
    if (segments.length && durationSec - start <= overlapSec) break;
    segments.push({ startSec: roundSec(start), endSec: roundSec(end), status: "pending", attempts: 0 });
  }
  return segments;
}

function roundSec(value: number) {
  return Math.round(value * 1000) / 1000;
}

/** 未処理か失敗した先頭の区間。再実行時は完了済みの区間を送り直さない。 */
export function nextTranscriptionSegment(job: TranscriptionJob): number {
  return job.segments.findIndex(segment => segment.status !== "done");
}

/** 出力上限などで失敗した区間を半分に分ける。短すぎて分けられなければ null。 */
export function splitTranscriptionSegment(job: TranscriptionJob, index: number, minSplitSec = TRANSCRIPTION_MIN_SPLIT_SEC): TranscriptionJob | null {
  const segment = job.segments[index];
  if (!segment || segment.endSec - segment.startSec < minSplitSec * 2) return null;
  const middle = roundSec(segment.startSec + (segment.endSec - segment.startSec) / 2);
  const halves: TranscriptionSegment[] = [
    { startSec: segment.startSec, endSec: Math.min(segment.endSec, roundSec(middle + TRANSCRIPTION_OVERLAP_SEC)), status: "pending", attempts: 0 },
    { startSec: middle, endSec: segment.endSec, status: "pending", attempts: 0 },
  ];
  return { ...job, segments: [...job.segments.slice(0, index), ...halves, ...job.segments.slice(index + 1)] };
}

export function transcriptionProgress(job: TranscriptionJob | null) {
  if (!job) return null;
  return {
    state: job.state,
    completed: job.segments.filter(segment => segment.status === "done").length,
    total: job.segments.length,
    durationSec: job.durationSec ?? null,
  };
}

export function formatSegmentClock(totalSec: number) {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = String(sec % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function segmentLabel(job: TranscriptionJob, index: number) {
  const segment = job.segments[index];
  return `区間${index + 1}/${job.segments.length}（${formatSegmentClock(segment.startSec)}〜${formatSegmentClock(segment.endSec)}）`;
}

/**
 * 全区間の本文を空行でつなぐ。区間の見出し（時刻）も、行頭の「[MM:SS]」も本文に入れない。
 * 「［0:00〜10:02］」や「[00:12] 話者1:」のような行は、議事録・BANTの根拠照合で話者「［0」「[00」の発言として
 * 扱われてしまうため。区間の時刻は meta.transcriptionJob.segments に残る。
 * 前後の区間がどちらも時刻付きなら、重なりの行を照合して重複した行を除く（timed-transcript.ts）。話者名は書き換えない。
 */
export function joinTranscriptionSegments(job: TranscriptionJob): string {
  return joinTimedSegments(job.segments);
}

/** 前の区間の末尾（時刻を外したもの）。話者表記をそろえるための参考に渡す（区間どうしの話者番号をそろえる唯一の手段）。 */
/**
 * 前の区間の末尾に渡す文字数。2026-09-29 の実音声（4区間目、各6回）では、400字だと区間全体の話者番号の入れ替わりが
 * 6回中2回、1,200字では0回（取り違えた行も平均約40行→約9行）だったため 1,200字にする（入力は約600 token 増えるだけ）。
 */
export const PREVIOUS_TAIL_CHARS = 1200;

export function previousSegmentTail(job: TranscriptionJob, index: number, maxChars = PREVIOUS_TAIL_CHARS): string | undefined {
  const previous = index > 0 ? job.segments[index - 1] : undefined;
  const text = previous?.status === "done" && previous.text ? stripTimestamps(previous.text).trim() : undefined;
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  // 行の途中から切ると先頭の行の話者名が欠けるので、次の行の頭から渡す（1行しか入らない場合はそのまま）。
  const tail = text.slice(-maxChars);
  const lineStart = tail.indexOf("\n");
  return text[text.length - maxChars - 1] === "\n" || lineStart < 0 ? tail : tail.slice(lineStart + 1);
}

/**
 * 直前の区間の保存済みの本文が時刻付きか。旧版で始まったジョブの区間は時刻が無く、連結時に重なりの重複を除けないため、
 * 次の区間には重なりを繰り返さないよう指示する（vertex-audio.ts）。先頭の区間は undefined。
 */
export function previousSegmentTimed(job: TranscriptionJob, index: number): boolean | undefined {
  if (index <= 0) return undefined;
  return isTimedTranscript(parseTimedTranscript(job.segments[index - 1]?.text ?? ""));
}

/** これより短い区間は書き漏れを確かめない（分割後の半分〈約5分〉は対象）。 */
export const COMPLETENESS_MIN_SEGMENT_SEC = 240;
/** 最後の時刻が区間の終わりから max(90秒, 区間の20%) より前なら、途中で止まったとみなす。 */
export const COMPLETENESS_TAIL_MIN_SEC = 90;
export const COMPLETENESS_TAIL_RATIO = 0.2;
/** 区間の長さをこの秒数より超える時刻は書き誤りとみなし、最後の時刻に数えない。 */
export const COMPLETENESS_TIME_SLACK_SEC = 5;
/** 再試行の結果は、発話の文字数が1回目のこの割合以上のときだけ採る（途中を省いた再試行で1回目の発話を失わない）。 */
export const COMPLETENESS_RETRY_MIN_TEXT_RATIO = 0.9;

/** 区間の出力の最後の時刻（区間の長さ＋COMPLETENESS_TIME_SLACK_SEC を超える時刻は数えない）。 */
function segmentLastSec(text: string, durationSec: number) {
  return lastTimestampSec(text, durationSec + COMPLETENESS_TIME_SLACK_SEC);
}

/**
 * 区間の出力が途中で止まったように見えるか（最後の時刻が区間の終わりより大きく前）。
 * 時刻の無い出力・無音の区間・短い区間は対象にしない。最後の区間と、区間の終わりから録音の終わりまでが判定の幅
 * （max(90秒, 区間の20%)）以内の区間も、録音の終わりが無音のことがあるため対象にしない。
 */
export function segmentCompleteness(job: TranscriptionJob, index: number, text: string) {
  const segment = job.segments[index];
  const durationSec = segment ? segment.endSec - segment.startSec : 0;
  const lastSec = segmentLastSec(text, durationSec);
  const tailSec = Math.max(COMPLETENESS_TAIL_MIN_SEC, COMPLETENESS_TAIL_RATIO * durationSec);
  const recordingEndSec = job.durationSec ?? job.segments.at(-1)?.endSec ?? 0;
  const endsEarly = !!segment && job.mode === "segmented" && index < job.segments.length - 1
    && recordingEndSec - segment.endSec > tailSec
    && durationSec >= COMPLETENESS_MIN_SEGMENT_SEC && lastSec !== null && !isNoSpeechTranscript(text)
    && lastSec < durationSec - tailSec;
  return { endsEarly, lastSec, durationSec };
}

/**
 * 書き漏れの再試行の前後でどちらを採るか。再試行の最後の時刻が1回目より遅く、発話の文字数が1回目の90%以上のときだけ
 * 再試行を採り、それ以外（同じ時刻・途中を省いた再試行・時刻の無い再試行）は1回目を採る。区間の長さを超える時刻は数えない。
 */
export function betterSegmentText(first: string, retry: string, durationSec: number): string {
  const firstLast = segmentLastSec(first, durationSec) ?? -Infinity;
  const retryLast = segmentLastSec(retry, durationSec) ?? -Infinity;
  const keepsText = spokenTextLength(retry) >= COMPLETENESS_RETRY_MIN_TEXT_RATIO * spokenTextLength(first);
  return retryLast > firstLast && keepsText ? retry : first;
}

/** 同じ区間を2回呼んだ場合の利用量の合算（meta.transcription の集計用）。 */
export function addUsage(a: Record<string, number> | undefined, b: Record<string, number> | undefined): Record<string, number> {
  return sumUsage([{ usage: a }, { usage: b }]);
}

function sumUsage(segments: Array<Pick<TranscriptionSegment, "usage">>) {
  const total: Record<string, number> = {};
  for (const segment of segments) {
    for (const [key, value] of Object.entries(segment.usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
    }
  }
  return total;
}

/** 完了時に meta.transcription へ残す集計。本文は transcript 列にだけ保存する。 */
export function summarizeTranscriptionJob(job: TranscriptionJob, extra: Record<string, unknown>) {
  return {
    ...extra,
    inputMode: job.mode === "segmented" ? "segmented" : "inline",
    segmentCount: job.segments.length,
    segmentSec: TRANSCRIPTION_SEGMENT_SEC,
    overlapSec: job.mode === "segmented" ? TRANSCRIPTION_OVERLAP_SEC : 0,
    audioDurationSec: job.durationSec ?? null,
    elapsedMs: job.segments.reduce((total, segment) => total + (segment.elapsedMs ?? 0), 0),
    attempts: job.vertexAttempts ?? job.segments.reduce((total, segment) => total + segment.attempts, 0),
    usage: sumUsage(job.segments),
  };
}

/** 完了後は区間の本文を meta から外し、同じ文章を二重に保持しない。 */
export function completedTranscriptionJob(job: TranscriptionJob, now: Date): TranscriptionJob {
  return {
    ...job,
    state: "done",
    updatedAt: now.toISOString(),
    segments: job.segments.map(segment => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      status: segment.status,
      attempts: segment.attempts,
      ...(segment.completenessRetried === true ? { completenessRetried: true } : {}),
      usage: segment.usage,
      elapsedMs: segment.elapsedMs,
    })),
  };
}
