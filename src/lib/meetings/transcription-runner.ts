/**
 * T04/T22: Cloud Run 向けの再開可能な文字起こし（継続処理）。
 *
 * 1回の呼び出しは時間予算（既定230秒）の範囲で「準備（ffmpeg）」または「区間の文字起こし」を
 * 1ステップずつ進め、ステップごとに meeting.meta.transcriptionJob へ保存する。
 * 処理権（リース）は processingStartedAt を時計兼CASトークンに使う。
 *   - null、または TRANSCRIPTION_LEASE_MS より古ければ取得できる（中断した処理の回収）。
 *   - 保存のたびに新しい時刻へ更新し、他の処理に奪われた後の書込は CAS で拒否される。
 *   - 時間切れで抜けるときは null に戻し、次の継続リクエストがすぐ再開できるようにする。
 * 作業ファイルはリースごとの名前で作り、奪われた処理が新しい所有者のファイルを壊さない。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { cleanupTempFile, fetchStored, localStoragePath, writeTempFile } from "@/lib/storage";
import { vertexTranscribeWithMetrics } from "@/lib/ai/vertex-audio";
import { VertexError, VERTEX_MODEL } from "@/lib/ai/vertex-policy";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { cutSegment, MediaToolError, mediaToolsAvailable, NORMALIZE_TIMEOUT_MS, normalizeToSpeechMp3, probeDurationSec } from "./audio-segments";
import { isUploadManifestKey, uploadPartPathsForKey } from "./upload-sessions";
import { NORMALIZED_AUDIO_FILE, transcriptionWorkDir } from "./transcription-files";
import {
  addUsage,
  betterSegmentText,
  completedTranscriptionJob,
  createTranscriptionJob,
  joinTranscriptionSegments,
  nextTranscriptionSegment,
  planTranscriptionSegments,
  previousSegmentTail,
  previousSegmentTimed,
  readTranscriptionJob,
  segmentCompleteness,
  segmentLabel,
  splitTranscriptionSegment,
  summarizeTranscriptionJob,
  TRANSCRIPTION_MAX_DURATION_SEC,
  TRANSCRIPTION_MAX_STEP_ATTEMPTS,
  TRANSCRIPTION_OVERLAP_SEC,
  TRANSCRIPTION_SEGMENT_SEC,
  transcriptionCallLimit,
  withTranscriptionJob,
  type TranscriptionJob,
  type TranscriptionSegment,
} from "./transcription-job";

/** 保存の間隔の最大（ffmpeg の正規化200秒＋長さの確認）より長くする。 */
export const TRANSCRIPTION_LEASE_MS = 290_000;
/** Cloud Run の timeoutSeconds=300 に対し、応答とDB保存の余裕を残す。 */
export const TRANSCRIPTION_REQUEST_BUDGET_MS = 230_000;
/** 区間1つ：Vertex の上限120秒＋切り出し・利用記録・保存。 */
const SEGMENT_STEP_RESERVE_MS = 135_000;
const PREPARE_STEP_RESERVE_MS = NORMALIZE_TIMEOUT_MS + 20_000;
/**
 * 予算＋この時間を超えて処理が続いていたら、CPU割当のない間に止まっていた（300秒超過・切断後）とみなす。
 * その間に期限が来たタイマーの失敗は本当の失敗ではないため、エラーにせず次の継続に任せる。
 */
const FROZEN_MARGIN_MS = 60_000;
const DIRECT_AUDIO_EXTENSIONS = new Set(["wav", "webm", "mp3", "m4a", "ogg", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mpeg", "mpg", "avi", "mkv"]);
const INLINE_AUDIO_MAX_BYTES = 6 * 1024 * 1024;
/** これより大きい元ファイルは再生時の全体読込を避け、正規化した音声で再生する。 */
const PLAYBACK_ORIGINAL_MAX_BYTES = 32 * 1024 * 1024;

export type AdvanceTranscriptionResult =
  | { outcome: "idle" }
  | { outcome: "leased" }
  | { outcome: "progressed" }
  | { outcome: "retrying" }
  | { outcome: "transcribed" }
  | { outcome: "error"; message: string };

class TranscriptionJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionJobError";
  }
}

/** 時間をおけば解消しうる準備側の失敗（分割アップロードのマニフェストが一時的に読めない等）。 */
class TransientJobError extends TranscriptionJobError {}

class SegmentFailure extends Error {
  constructor(public index: number, public failure: unknown) {
    super("segment failed");
  }
}

/**
 * 1 vCPU・maxScale 1 の検証サービスで ffmpeg の正規化を並行させない（互いに遅くなり時間切れになる）。
 * プロセス内の目印なので、別インスタンスとの排他はリースが担う。
 */
let preparingInProcess = 0;

function extensionOf(key: string) {
  return path.extname(key.split("?")[0] ?? "").slice(1).toLowerCase();
}

type RecordingSource = { paths: string[]; extension: string; bytes: number; parts: boolean; temp: string | null };

async function resolveSource(meetingId: string, recordingUrl: string | null, audioSizeBytes: number | null): Promise<RecordingSource> {
  if (!recordingUrl) throw new TranscriptionJobError("録音ファイルが保存されていないため、文字起こしを開始できません。");
  const parts = await uploadPartPathsForKey(recordingUrl);
  if (parts) return { paths: parts.paths, extension: parts.manifest.extension, bytes: parts.manifest.size, parts: true, temp: null };
  // 分割アップロードのマニフェストを読めない場合に、マニフェスト自体を録音として扱わない。
  if (isUploadManifestKey(recordingUrl)) throw new TransientJobError("分割アップロードした録画のパートを読み込めませんでした。時間をおいて再試行します。");
  const local = localStoragePath(recordingUrl);
  if (local) {
    const stat = await fs.stat(local).catch(() => null);
    if (!stat?.isFile()) throw new TranscriptionJobError("保存済み録音ファイルを読み込めませんでした。録音を添付し直してください。");
    return { paths: [local], extension: extensionOf(recordingUrl), bytes: stat.size, parts: false, temp: null };
  }
  const fetched = await fetchStored(recordingUrl);
  if (!fetched) throw new TranscriptionJobError("保存済み録音ファイルを読み込めませんでした。録音を添付し直してください。");
  const extension = extensionOf(recordingUrl) || "webm";
  const temp = await writeTempFile(`meeting_${meetingId}.${extension}`, fetched.buffer);
  return { paths: [temp], extension, bytes: audioSizeBytes ?? fetched.buffer.byteLength, parts: false, temp };
}

function failureMessage(error: unknown) {
  if (error instanceof VertexError || error instanceof MediaToolError || error instanceof TranscriptionJobError) return error.message;
  return "文字起こし中に不明なエラーが発生しました。時間をおいて「文字起こし再実行」を試してください。";
}

const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]);
const TRANSIENT_ERRNO = new Set(["EIO", "ETIMEDOUT", "EAGAIN", "ECONNRESET", "EBUSY"]);

/** 時間をおけば成功しうる失敗（通信・混雑・時間切れ・DBやストレージの一時的な失敗）。 */
function isTransient(error: unknown) {
  if (error instanceof TransientJobError) return true;
  if (error instanceof MediaToolError) return error.code === "media_timeout";
  if (error instanceof VertexError) {
    return ["timeout", "transport", "http_429", "retry_exhausted", "ledger_busy"].includes(error.code) || /^(?:http|count)_5\d\d$/.test(error.code);
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (TRANSIENT_DB_CODES.has(code) || TRANSIENT_ERRNO.has(code));
}

async function fileExists(file: string) {
  return fs.stat(file).then(stat => stat.isFile(), () => false);
}

export async function advanceMeetingTranscription(
  meetingId: string,
  { budgetMs = TRANSCRIPTION_REQUEST_BUDGET_MS, now = () => Date.now() }: { budgetMs?: number; now?: () => number } = {},
): Promise<AdvanceTranscriptionResult> {
  const startedAt = now();
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, processingStatus: true, recordingUrl: true, audioSizeBytes: true, durationSec: true, meta: true, transcript: true },
  });
  if (!meeting || meeting.transcript?.trim()) return { outcome: "idle" };
  if (meeting.processingStatus !== MEETING_PROCESSING_STATUS.UPLOADED && meeting.processingStatus !== MEETING_PROCESSING_STATUS.TRANSCRIBING) {
    return { outcome: "idle" };
  }
  const savedJob = readTranscriptionJob(meeting.meta);
  if (preparingInProcess > 0 && (!savedJob || savedJob.state === "prepare")) return { outcome: "leased" };

  let lease = new Date(now());
  const claimed = await prisma.meeting.updateMany({
    where: {
      id: meetingId,
      processingStatus: { in: [MEETING_PROCESSING_STATUS.UPLOADED, MEETING_PROCESSING_STATUS.TRANSCRIBING] },
      OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: new Date(now() - TRANSCRIPTION_LEASE_MS) } }],
    },
    data: {
      processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBING,
      processingStartedAt: lease,
      processingError: null,
      processingCompletedAt: null,
    },
  });
  if (claimed.count !== 1) return { outcome: "leased" };
  // このリース専用の作業ファイル名。奪われた処理が同じファイルを上書き・削除しないようにする。
  const nonce = String(lease.getTime());

  const baseMeta = meeting.meta;
  let job = savedJob ?? createTranscriptionJob(new Date(now()));
  // 完了済みの job（本文は meta から外してある）が残ったまま再実行された場合は最初からやり直す。
  if (job.state === "done" || job.segments.some(segment => segment.status === "done" && !segment.text?.trim())) {
    job = { ...createTranscriptionJob(new Date(now()), job.autoAnalyze), playbackFile: job.playbackFile };
  }
  // 利用者の「文字起こし再実行」（エラー→uploaded）で再開した場合は、失敗した区間だけを送り直す。
  // 人が再実行を指示したので、試行回数と呼び出し回数の上限はそこから数え直す。
  const userRetry = meeting.processingStatus === MEETING_PROCESSING_STATUS.UPLOADED && !!savedJob;
  job = {
    ...job,
    ...(userRetry ? {
      prepareAttempts: 0,
      vertexAttempts: job.segments.filter(segment => segment.status === "done").reduce((total, segment) => total + segment.attempts, 0),
    } : {}),
    segments: job.segments.map(segment => segment.status === "error" || (userRetry && segment.status === "pending")
      ? { ...segment, status: "pending", error: undefined, attempts: userRetry ? 0 : segment.attempts }
      : segment),
  };

  /** リースを保持しているときだけ保存し、リースを新しい時刻へ延長する。 */
  async function save(data: Record<string, unknown>, release = false) {
    const next = release ? null : new Date(Math.max(now(), lease.getTime() + 1));
    const updated = await prisma.meeting.updateMany({
      where: { id: meetingId, processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBING, processingStartedAt: lease },
      data: { ...data, processingStartedAt: next },
    });
    if (updated.count !== 1) return false;
    if (next) lease = next;
    return true;
  }
  const jobMeta = (nextJob: TranscriptionJob) => withTranscriptionJob(baseMeta, { ...nextJob, updatedAt: new Date(now()).toISOString() });
  const saveJob = (nextJob: TranscriptionJob, extra: Record<string, unknown> = {}) => save({ ...extra, meta: jobMeta(nextJob) });
  /** 予算を大きく超えて動いていた＝CPU割当のない間に止まっていた、またはリースを失っている。 */
  const frozen = () => now() - startedAt > budgetMs + FROZEN_MARGIN_MS || now() - lease.getTime() > TRANSCRIPTION_LEASE_MS;

  let source: RecordingSource | null = null;
  const sourceOnce = async () => (source ??= await resolveSource(meetingId, meeting.recordingUrl, meeting.audioSizeBytes));
  let failedIndex: number | null = null;
  let workDir: string | null = null;
  const ownFiles: string[] = [];

  try {
    workDir = transcriptionWorkDir(meetingId);
    for (;;) {
      const remaining = budgetMs - (now() - startedAt);
      if (job.state === "prepare") {
        if ((job.prepareAttempts ?? 0) >= TRANSCRIPTION_MAX_STEP_ATTEMPTS) {
          throw new TranscriptionJobError("録音の変換が繰り返し中断しました。ファイルを音声（mp3/m4a）に書き出して添付し直してください。");
        }
        // 準備は最長200秒かかるため、残り時間が十分なリクエストの冒頭でだけ始める。
        // 正規化の枠は await の前に同期的に取り、同時に届いた継続と重ならないようにする。
        if (remaining < PREPARE_STEP_RESERVE_MS || preparingInProcess > 0) break;
        preparingInProcess++;
        let prepared: { job: TranscriptionJob; normalizedTemp: string | null };
        try {
          job = { ...job, prepareAttempts: (job.prepareAttempts ?? 0) + 1 };
          if (!await saveJob(job)) return { outcome: "leased" };
          prepared = await prepareJob(job, await sourceOnce(), workDir, meeting.durationSec, nonce);
        } finally {
          preparingInProcess--;
        }
        if (prepared.normalizedTemp) ownFiles.push(prepared.normalizedTemp);
        const durationSec = meeting.durationSec ?? (prepared.job.durationSec ? Math.round(prepared.job.durationSec) : null);
        if (!await saveJob(prepared.job, { durationSec })) return { outcome: "leased" };
        // リースを保持していることを保存で確かめてから、正規化音声を共有の名前へ移す。
        if (prepared.normalizedTemp) await fs.rename(prepared.normalizedTemp, path.join(workDir, NORMALIZED_AUDIO_FILE));
        job = prepared.job;
        continue;
      }

      const index = nextTranscriptionSegment(job);
      if (index < 0) {
        const transcript = joinTranscriptionSegments(job).trim();
        if (!transcript) throw new TranscriptionJobError("文字起こし結果が空でした。録音内容・音声形式を確認して再試行してください。");
        const completedAt = new Date(now());
        const completed = completedTranscriptionJob(job, completedAt);
        const saved = await save({
          transcript,
          processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED,
          processingError: null,
          processingCompletedAt: completedAt,
          meta: {
            ...withTranscriptionJob(baseMeta, completed),
            transcription: summarizeTranscriptionJob(job, {
              provider: "vertex",
              model: VERTEX_MODEL,
              startedAt: job.createdAt,
              completedAt: completedAt.toISOString(),
              inputBytes: meeting.audioSizeBytes,
              inputDurationSec: meeting.durationSec,
            }),
          },
        }, true);
        if (!saved) return { outcome: "leased" };
        await cleanupWorkFiles(workDir, completed);
        console.log("[meeting-transcription] completed", { meetingId, segments: completed.segments.length, chars: transcript.length });
        return { outcome: "transcribed" };
      }

      const pending = job.segments[index];
      // 書き漏れの再試行を待つ区間（1回目の結果を保存済み）。再試行を始めた後に中断した場合や、試行の上限に
      // 達している場合は、再試行せずに1回目の結果を採る（この確認のために文字起こしを失敗させない）。
      const firstResult = job.mode === "segmented" && pending.text?.trim() ? pending.text.trim() : null;
      if (firstResult && (pending.completenessRetried === true || pending.attempts >= TRANSCRIPTION_MAX_STEP_ATTEMPTS
        || (job.vertexAttempts ?? 0) >= transcriptionCallLimit(job))) {
        const accepted = segmentDone(job, index, { text: firstResult });
        if (!await saveJob(accepted)) return { outcome: "leased" };
        logCompleteness(meetingId, job, index, firstResult, "accepted_first");
        job = accepted;
        failedIndex = null;
        continue;
      }
      if (pending.attempts >= TRANSCRIPTION_MAX_STEP_ATTEMPTS) {
        failedIndex = index;
        throw new TranscriptionJobError(`同じ区間の文字起こしを${TRANSCRIPTION_MAX_STEP_ATTEMPTS}回試しても完了しませんでした。`);
      }
      if ((job.vertexAttempts ?? 0) >= transcriptionCallLimit(job)) {
        failedIndex = index;
        throw new TranscriptionJobError("この録音で予定したAI呼び出し回数の上限に達したため、費用保護のため停止しました。利用状況を確認してから再実行してください。");
      }
      const normalized = job.mode === "segmented" ? path.join(workDir, NORMALIZED_AUDIO_FILE) : null;
      // 別インスタンスで再開した・作業ファイルが消えた場合は、準備（正規化）からやり直す。区間の結果は残す。
      if (normalized && !await fileExists(normalized)) {
        job = { ...job, state: "prepare" };
        continue;
      }
      if (remaining < SEGMENT_STEP_RESERVE_MS) break;
      failedIndex = index;
      const attempted: TranscriptionJob = {
        ...job,
        vertexAttempts: (job.vertexAttempts ?? 0) + 1,
        segments: job.segments.map((segment, i) => i === index
          ? { ...segment, attempts: segment.attempts + 1, ...(firstResult ? { completenessRetried: true } : {}) }
          : segment),
      };
      if (!await saveJob(attempted)) return { outcome: "leased" };
      job = attempted;

      let text: string;
      let metrics: Awaited<ReturnType<typeof vertexTranscribeWithMetrics>>["metrics"];
      const segmentPath = normalized ? path.join(workDir, `segment-${Math.round(pending.startSec * 1000)}-${Math.round(pending.endSec * 1000)}-${nonce}.mp3`) : null;
      try {
        let result: Awaited<ReturnType<typeof vertexTranscribeWithMetrics>>;
        if (normalized && segmentPath) {
          ownFiles.push(segmentPath);
          await cutSegment(normalized, segmentPath, pending.startSec, pending.endSec - pending.startSec);
          const overlapSec = index > 0 ? Math.max(0, job.segments[index - 1].endSec - pending.startSec) : 0;
          result = await vertexTranscribeWithMetrics(segmentPath, {
            segment: {
              index, total: job.segments.length, startSec: pending.startSec, endSec: pending.endSec, overlapSec,
              ...(index > 0 ? { previousTimed: previousSegmentTimed(job, index) } : {}),
            },
            previousTail: previousSegmentTail(job, index),
            // 書き漏れの再試行は任意の呼出し。429 で予約し直さず、失敗なら1回目の結果を採る。
            ...(firstResult ? { maxAttempts: 1 } : {}),
          });
        } else {
          result = await vertexTranscribeWithMetrics((await sourceOnce()).paths[0]);
        }
        text = result.text.trim();
        metrics = result.metrics;
        if (!text) throw new VertexError("empty", "AIから文字起こし本文を取得できませんでした。");
      } catch (error) {
        if (firstResult) {
          // 書き漏れの再試行が失敗した（上限・通信・429・空の応答など）。任意の再試行なので、区間を分けたり失敗にしたりせず、
          // 1回目の結果を採る（分けた後の失敗で、元なら完了したジョブを失敗させない）。
          const accepted = segmentDone(job, index, { text: firstResult });
          if (!await saveJob(accepted)) return { outcome: "leased" };
          logCompleteness(meetingId, job, index, firstResult, "accepted_first", error instanceof VertexError || error instanceof MediaToolError ? error.code : "unknown");
          job = accepted;
          failedIndex = null;
          continue;
        }
        const limitReached = error instanceof VertexError && ["incomplete", "input_limit"].includes(error.code) && !frozen();
        // 10分の発話が出力上限・入力上限を超えた場合は、半分の長さで送り直す。
        if (limitReached && job.mode === "segmented") {
          const split = splitTranscriptionSegment(job, index);
          if (split) {
            if (!await saveJob(split)) return { outcome: "leased" };
            job = split;
            failedIndex = null;
            continue;
          }
        }
        // 元の音声を1回で送る方式で上限に達した場合は、正規化して区間に分ける方式へ切り替える。
        if (limitReached && job.mode === "direct") {
          const segmented: TranscriptionJob = { ...job, state: "prepare", mode: undefined, segments: [], forceSegmented: true };
          if (!await saveJob(segmented)) return { outcome: "leased" };
          job = segmented;
          failedIndex = null;
          continue;
        }
        throw new SegmentFailure(index, error);
      } finally {
        if (segmentPath) await fs.rm(segmentPath, { force: true }).catch(() => {});
      }

      if (firstResult) {
        // 書き漏れの再試行の結果。最後の時刻が遅く発話を大きく減らしていなければ再試行を採り、利用量・所要時間は2回分を合算する。
        const chosen = betterSegmentText(firstResult, text, pending.endSec - pending.startSec);
        const done = segmentDone(job, index, { text: chosen, ...addSegmentMetrics(pending, metrics) });
        if (!await saveJob(done)) return { outcome: "leased" };
        logCompleteness(meetingId, job, index, chosen, chosen === firstResult ? "kept_first" : "kept_retry");
        job = done;
        failedIndex = null;
        continue;
      }
      if (job.mode === "segmented" && segmentCompleteness(job, index, text).endsEarly) {
        // 区間の出力が途中で止まった（モデルが確率的に早く止まることがある）。同じ区間を1回だけ送り直す。
        // 再試行は一時的な失敗の枠とは別に数える（transcriptionCallLimit）ので、後の区間の再試行の余地は減らない。
        const affordable = job.segments[index].attempts < TRANSCRIPTION_MAX_STEP_ATTEMPTS;
        if (affordable) {
          const waiting: TranscriptionJob = {
            ...job,
            segments: job.segments.map((segment, i) => i === index
              ? { ...segment, status: "pending", text, ...addSegmentMetrics(pending, metrics), error: undefined }
              : segment),
          };
          if (!await saveJob(waiting)) return { outcome: "leased" };
          logCompleteness(meetingId, job, index, text, "retry");
          job = waiting;
          failedIndex = null;
          continue;
        }
        logCompleteness(meetingId, job, index, text, "accepted_budget");
      }

      const done = segmentDone(job, index, { text, ...addSegmentMetrics(pending, metrics) });
      if (!await saveJob(done)) return { outcome: "leased" };
      job = done;
      failedIndex = null;
    }

    // 時間予算を使い切った。完了済みの区間は保存済みなので、処理権を手放して次の継続に任せる。
    await save({ meta: jobMeta(job) }, true);
    return { outcome: "progressed" };
  } catch (error) {
    const cause = error instanceof SegmentFailure ? error.failure : error;
    const index = error instanceof SegmentFailure ? error.index : failedIndex;
    const code = cause instanceof VertexError || cause instanceof MediaToolError ? cause.code : cause instanceof Error ? cause.name : "unknown";
    const stepAttempts = index !== null && job.segments[index] ? job.segments[index].attempts : job.prepareAttempts ?? 0;
    const retryable = frozen()
      || (isTransient(cause) && stepAttempts < TRANSCRIPTION_MAX_STEP_ATTEMPTS && (job.vertexAttempts ?? 0) < transcriptionCallLimit(job));
    if (retryable) {
      // 止まっていた間のタイマー切れや一時的な失敗はエラーにせず、試行回数を残して次の継続で再試行する。
      console.warn("[meeting-transcription] retry later", { meetingId, segment: index, code, frozen: frozen() });
      await save({ meta: jobMeta(job) }, true).catch(() => false);
      return { outcome: "retrying" };
    }
    const detail = failureMessage(cause);
    const segmented = job.mode === "segmented" && index !== null && job.segments[index];
    const message = segmented
      ? `${segmentLabel(job, index!)}の文字起こしに失敗しました: ${detail} 完了した区間は保存済みです。「文字起こし再実行」で失敗した区間から再開します。`
      : detail;
    const failedJob: TranscriptionJob = segmented
      ? { ...job, segments: job.segments.map((segment, i) => i === index ? { ...segment, status: "error", error: detail } : segment) }
      : job;
    console.error("[meeting-transcription] failed", { meetingId, segment: index, code });
    await save({
      processingStatus: MEETING_PROCESSING_STATUS.ERROR,
      processingError: message,
      processingCompletedAt: new Date(now()),
      meta: jobMeta(failedJob),
    }, true).catch(() => false);
    return { outcome: "error", message };
  } finally {
    // このリースで作った一時ファイルだけを消す（共有の normalized.mp3 は rename 済みなら対象外）。
    await Promise.all(ownFiles.map(file => fs.rm(file, { force: true }).catch(() => {})));
    const temp = (source as RecordingSource | null)?.temp;
    if (temp) await cleanupTempFile(temp);
  }
}

/**
 * 区間に保存済みの利用量・所要時間（書き漏れの再試行を待つ1回目の結果）に、
 * 今回の呼出しの分を足す。保存済みの値が無ければ今回の値そのもの。
 */
function addSegmentMetrics(pending: TranscriptionSegment, metrics: { usage?: Record<string, number>; elapsedMs: number }) {
  return {
    usage: pending.usage ? addUsage(pending.usage, metrics.usage) : metrics.usage,
    elapsedMs: (pending.elapsedMs ?? 0) + metrics.elapsedMs,
  };
}

/** 区間を完了にする。usage・elapsedMs を省いた場合は保存済みの値（1回目の結果）を残す。 */
function segmentDone(job: TranscriptionJob, index: number, result: Pick<TranscriptionSegment, "text"> & Partial<Pick<TranscriptionSegment, "usage" | "elapsedMs">>): TranscriptionJob {
  return {
    ...job,
    segments: job.segments.map((segment, i) => i === index ? { ...segment, ...result, status: "done", error: undefined } : segment),
  };
}

/** 書き漏れの確認の記録。本文は出さず、区間の番号・最後の時刻・区間の長さ・判断だけを残す。 */
function logCompleteness(meetingId: string, job: TranscriptionJob, index: number, text: string, action: string, code?: string) {
  const { lastSec, durationSec } = segmentCompleteness(job, index, text);
  console.log("[meeting-transcription] completeness", { meetingId, segment: index, lastSec, durationSec: Math.round(durationSec), action, ...(code ? { code } : {}) });
}

async function prepareJob(
  job: TranscriptionJob,
  source: RecordingSource,
  workDir: string,
  knownDurationSec: number | null,
  nonce: string,
): Promise<{ job: TranscriptionJob; normalizedTemp: string | null }> {
  const directAudio = !job.forceSegmented && !source.parts && DIRECT_AUDIO_EXTENSIONS.has(source.extension) && source.bytes <= INLINE_AUDIO_MAX_BYTES;
  const direct = (durationSec: number | null): { job: TranscriptionJob; normalizedTemp: null } => ({
    normalizedTemp: null,
    job: {
      ...job,
      state: "transcribe",
      mode: "direct",
      durationSec: durationSec ?? undefined,
      segments: [{ startSec: 0, endSec: Math.max(1, durationSec ?? 1), status: "pending", attempts: 0 }],
    },
  });
  // 作業ファイルが消えて正規化だけやり直す場合は、区間の結果を残す。
  const rebuilding = job.mode === "segmented" && job.segments.length > 0;

  if (!await mediaToolsAvailable()) {
    if (directAudio && !rebuilding) return direct(knownDurationSec);
    throw new TranscriptionJobError("長時間の録音・動画の文字起こしに必要な音声変換ツール（ffmpeg）がこの環境にありません。6MB以下の音声（wav/webm/mp3/m4a/ogg/flac）で再試行するか、管理者に確認してください。");
  }
  if (directAudio && !rebuilding) {
    // 10分以内の短い録音は、受入済みの従来経路（元の音声を1回で送信）をそのまま使う。
    // ブラウザ録音の webm は長さの情報を持たないことが多いため、録音カードが送った秒数で補う。
    const probed = await probeDurationSec(source.paths[0], source.extension).catch(() => null);
    const durationSec = probed ?? knownDurationSec;
    if (durationSec !== null && durationSec <= TRANSCRIPTION_SEGMENT_SEC + TRANSCRIPTION_OVERLAP_SEC) return direct(durationSec);
  }

  await fs.mkdir(workDir, { recursive: true });
  const normalizedTemp = path.join(workDir, `normalized-${nonce}.tmp.mp3`);
  await normalizeToSpeechMp3(source.paths, normalizedTemp, { extension: source.extension });
  const durationSec = await probeDurationSec(normalizedTemp);
  if (durationSec > TRANSCRIPTION_MAX_DURATION_SEC) {
    throw new TranscriptionJobError("録音が長すぎます。1件あたり3時間までの録音・録画を添付してください。");
  }
  if (rebuilding) return { normalizedTemp, job: { ...job, state: "transcribe" } };
  // T04/T03: ブラウザ録音の webm は長さの情報を持たず、プレーヤーに全体の長さが出ない（0:00 のみ）。
  // 区間処理では正規化した音声を既に作っているため、追加の変換なしにそれを再生にも使う
  // （10分程度までの短い録音は上の direct 経路で元のまま送り、ここへは来ないので余計な変換はしない）。
  const needsPlayback = source.parts || VIDEO_EXTENSIONS.has(source.extension) || source.extension === "webm" ||
    source.bytes > PLAYBACK_ORIGINAL_MAX_BYTES;
  return {
    normalizedTemp,
    job: {
      ...job,
      state: "transcribe",
      mode: "segmented",
      durationSec,
      segments: planTranscriptionSegments(durationSec),
      playbackFile: needsPlayback ? NORMALIZED_AUDIO_FILE : undefined,
    },
  };
}

async function cleanupWorkFiles(workDir: string, job: TranscriptionJob) {
  try {
    const names = await fs.readdir(workDir);
    await Promise.all(names
      .filter(name => name !== job.playbackFile && (name.startsWith("segment-") || name.endsWith(".tmp.mp3") || name === NORMALIZED_AUDIO_FILE))
      .map(name => fs.rm(path.join(workDir, name), { force: true })));
  } catch {
    // 作業領域が無い（短い録音を元ファイルのまま送った）場合は何もしない。
  }
}
