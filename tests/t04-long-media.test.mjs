// T04/T22: 長時間録音・動画の区間分割と、Cloud Run 向けの再開可能な継続処理。
// ffmpeg・Vertex・DB は模擬し、作業ファイルは実際の一時ディレクトリで確認する。AI・外部通信は呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, truncate, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineModule } from "./helpers/offline-module.mjs";
import { LONG_ANALYSIS_PURE_MODULES } from "./helpers/long-analysis-modules.mjs";
import transcriptionJob from "../src/lib/meetings/transcription-job.ts";
import statusPayload from "../src/lib/meetings/status-payload.ts";

const {
  planTranscriptionSegments, splitTranscriptionSegment, joinTranscriptionSegments, readTranscriptionJob,
  nextTranscriptionSegment, completedTranscriptionJob, createTranscriptionJob, TRANSCRIPTION_MAX_DURATION_SEC,
} = transcriptionJob;

const STATUS = "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',TRANSCRIBED:'transcribed',ANALYZING:'analyzing',COMPLETED:'completed',ERROR:'error'};";

test("T04 plan: 60/90 minutes become 10-minute segments with 10s overlap, each within the 32,768-token cap", () => {
  // A remainder no longer than the 10s overlap is already inside the previous segment (603s → 1 segment, 611s → 2).
  for (const [duration, count] of [[3600, 6], [5400, 9], [5010.264, 9], [601, 1], [603, 1], [610, 1], [611, 2], [1201, 2], [1210, 2], [1211, 3]]) {
    const segments = planTranscriptionSegments(duration);
    assert.equal(segments.length, count, `duration ${duration}`);
    assert.equal(segments[0].startSec, 0);
    assert.equal(segments.at(-1).endSec, duration);
    for (let i = 1; i < segments.length; i++) assert.ok(segments[i].startSec < segments[i - 1].endSec, "adjacent segments overlap");
    // Audio is billed at ~32 tokens/s; 610s ≈ 19,520 tokens leaves room for the prompt.
    for (const segment of segments) assert.ok((segment.endSec - segment.startSec) * 32 + 2000 < 32768);
    for (let i = 1; i < segments.length; i++) assert.equal(segments[i - 1].endSec - segments[i].startSec, 10, "adjacent segments share 10s");
    // ~32kbps mono MP3 (4,000 bytes/s): the 610s cut stays well inside the 6MiB inline limit.
    for (const segment of segments) assert.ok((segment.endSec - segment.startSec) * 4000 < 6 * 1024 * 1024);
  }
  assert.throws(() => planTranscriptionSegments(0));
  assert.equal(TRANSCRIPTION_MAX_DURATION_SEC, 10800);
});

test("T04 job helpers: split halves, resume index, headers only for multiple segments, text stripped on completion", () => {
  const job = { ...createTranscriptionJob(new Date("2026-09-25T00:00:00Z")), state: "transcribe", mode: "segmented", durationSec: 1200, segments: planTranscriptionSegments(1200) };
  const split = splitTranscriptionSegment(job, 0);
  assert.equal(split.segments.length, 3);
  assert.deepEqual([split.segments[0].startSec, split.segments[1].startSec], [0, 305]);
  assert.deepEqual([split.segments[0].endSec, split.segments[1].endSec], [315, 610], "the halves also share 10s");
  assert.ok(split.segments[0].endSec > split.segments[1].startSec);
  assert.equal(splitTranscriptionSegment({ ...job, segments: [{ startSec: 0, endSec: 200, status: "pending", attempts: 0 }] }, 0), null);
  const done = { ...job, segments: job.segments.map((s, i) => ({ ...s, status: i === 0 ? "done" : "error", text: `本文${i}` })) };
  assert.equal(nextTranscriptionSegment(done), 1);
  // No time headers in the transcript: a line like 「［0:00〜10:02］」 would be parsed as a speaker line by the evidence code.
  assert.equal(joinTranscriptionSegments(done), "本文0\n\n本文1");
  assert.equal(joinTranscriptionSegments({ ...done, segments: [done.segments[0]] }), "本文0");
  const completed = completedTranscriptionJob(done, new Date("2026-09-25T01:00:00Z"));
  assert.ok(completed.segments.every(s => s.text === undefined));
  assert.equal(readTranscriptionJob({ transcriptionJob: completed }).state, "done");
  assert.equal(readTranscriptionJob({ transcriptionJob: { version: 1, state: "transcribe", segments: [] } }), null);
  assert.equal(readTranscriptionJob({ transcriptionJob: { ...completed, segments: [{ startSec: 5, endSec: 1 }] } }), null);
});

// ---------------------------------------------------------------- runner
const runnerEntry = "src/lib/meetings/transcription-runner.ts";
const runnerBoundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/storage": "export const localStoragePath=k=>mocks.localPath(k);export const fetchStored=async k=>mocks.fetchStored(k);export const writeTempFile=async(n,b)=>mocks.writeTemp(n,b);export const cleanupTempFile=async p=>{mocks.cleaned.push(p)};",
  "@/lib/ai/vertex-audio": "export const vertexTranscribeWithMetrics=(...a)=>mocks.transcribe(...a);",
  "@/lib/ai/vertex-policy": "export class VertexError extends Error{constructor(code,message){super(message);this.code=code;this.name='VertexError';}};mocks.VertexError=VertexError;export const VERTEX_MODEL='gemini-2.5-flash';",
  "@/lib/meetings/processing": STATUS,
  "./audio-segments": "export class MediaToolError extends Error{constructor(code,message){super(message);this.code=code;}};mocks.MediaToolError=MediaToolError;export const NORMALIZE_TIMEOUT_MS=200000;export const mediaToolsAvailable=async()=>mocks.tools;export const normalizeToSpeechMp3=(...a)=>mocks.normalize(...a);export const probeDurationSec=(...a)=>mocks.probe(...a);export const cutSegment=(...a)=>mocks.cut(...a);",
  "./upload-sessions": "export const uploadPartPathsForKey=async k=>mocks.parts?mocks.parts(k):null;export const isUploadManifestKey=k=>/\\/recordings\\/parts\\/.*manifest\\.json$/.test(k??'');",
};
const runnerAllowed = [runnerEntry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", "src/lib/meetings/transcription-files.ts"];

function whereMatches(row, where) {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") { if (!value.some(w => whereMatches(row, w))) return false; continue; }
    const actual = row[key];
    if (value === null) { if (actual !== null && actual !== undefined) return false; continue; }
    if (value instanceof Date) { if (!(actual instanceof Date) || actual.getTime() !== value.getTime()) return false; continue; }
    if (typeof value === "object") {
      if ("in" in value) { if (!value.in.includes(actual)) return false; continue; }
      if ("lt" in value) { if (!(actual instanceof Date) || actual.getTime() >= value.lt.getTime()) return false; continue; }
      throw Error("unsupported where: " + key);
    }
    if (actual !== value) return false;
  }
  return true;
}

function meetingPrisma(m) {
  return { meeting: {
    findUnique: async () => m.row ? structuredClone(m.row) : null,
    updateMany: async ({ where, data }) => {
      m.updates.push(structuredClone(data));
      if (!m.row || !whereMatches(m.row, where)) return { count: 0 };
      Object.assign(m.row, structuredClone(data));
      return { count: 1 };
    },
    update: async ({ data }) => Object.assign(m.row, structuredClone(data)),
  } };
}

async function runnerSetup(t, { ext = "webm", bytes = 14 * 1024 * 1024, duration = 3600, tools = true, durationSec = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t04-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const m = {
    root, tools, clock: Date.parse("2026-09-25T01:00:00Z"), calls: [], normalized: [], cuts: [], cleaned: [], updates: [],
    env: { NODE_ENV: "production", LUMA_CLOUD_AI_MODE: "vertex" },
    localPath: key => key?.startsWith("/uploads/") ? path.join(root, key.slice("/uploads/".length)) : null,
    fetchStored: async () => null,
    writeTemp: async (name, buffer) => { const file = path.join(root, "tmp-" + name); await writeFile(file, buffer); return file; },
    probe: async file => file.endsWith("normalized.mp3") ? m.duration : (m.sourceDuration ?? m.duration),
    normalize: async (inputs, output) => { m.normalized.push(inputs); await writeFile(output, "normalized"); },
    cut: async (input, output, start, length) => { m.cuts.push({ start, length, output }); await writeFile(output, "segment"); },
    transcribe: async (file, options) => {
      m.calls.push({ file, options });
      m.clock += 40_000;
      if (m.failOn) { const failure = m.failOn(m.calls.length, options); if (failure) throw failure; }
      return { text: ` 区間${options?.segment ? options.segment.index + 1 : "単発"}の発話 `, metrics: { usage: { promptTokenCount: 19000, candidatesTokenCount: 1500, totalTokenCount: 20500 }, elapsedMs: 40_000 } };
    },
    duration,
  };
  m.row = { id: "meeting-1", processingStatus: "uploaded", recordingUrl: `/uploads/recordings/demo.${ext}`, audioSizeBytes: bytes, durationSec,
    meta: { attachment: { filename: `demo.${ext}` } }, transcript: null, processingStartedAt: null, processingError: null };
  m.prisma = meetingPrisma(m);
  await mkdir(path.join(root, "recordings"), { recursive: true });
  await writeFile(path.join(root, `recordings/demo.${ext}`), "");
  await truncate(path.join(root, `recordings/demo.${ext}`), bytes);
  const lib = await offlineModule(runnerEntry, m, runnerBoundaries, runnerAllowed, ["node:fs/promises", "node:path"]);
  const advance = (budgetMs) => lib.advanceMeetingTranscription("meeting-1", { now: () => m.clock, ...(budgetMs ? { budgetMs } : {}) });
  return { m, lib, advance };
}

test("T04 60-minute recording: 202 flow resumes across requests within the Cloud Run budget and completes once", async t => {
  const { m, advance } = await runnerSetup(t);
  assert.equal((await advance()).outcome, "progressed");
  assert.equal(m.row.processingStatus, "transcribing");
  assert.equal(m.row.processingStartedAt, null, "lease released so the next continuation can resume at once");
  assert.equal(m.row.durationSec, 3600, "probed duration is shown for attachments without a recorder duration");
  const saved = m.row.meta.transcriptionJob;
  assert.equal(saved.mode, "segmented");
  assert.equal(saved.segments.length, 6);
  assert.equal(saved.segments.filter(s => s.status === "done").length, 3, "3 segments fit in one 230s request at 40s each");
  assert.equal(m.row.meta.attachment.filename, "demo.webm", "existing meta is preserved");
  assert.equal(m.normalized.length, 1);

  assert.equal((await advance()).outcome, "transcribed");
  assert.equal(m.calls.length, 6, "completed segments are never sent again");
  assert.equal(m.normalized.length, 1, "normalized audio is reused from the persistent work directory");
  assert.equal(m.row.processingStatus, "transcribed");
  assert.equal(m.row.processingStartedAt, null);
  assert.equal(m.row.transcript, [1, 2, 3, 4, 5, 6].map(n => `区間${n}の発話`).join("\n\n"));
  assert.doesNotMatch(m.row.transcript, /［/, "no time headers in the transcript");
  assert.deepEqual(m.row.meta.transcriptionJob.segments.map(s => s.startSec), [0, 600, 1200, 1800, 2400, 3000], "segment times stay in meta");
  const job = m.row.meta.transcriptionJob;
  assert.equal(job.state, "done");
  assert.equal(job.autoAnalyze, true);
  assert.ok(job.segments.every(s => s.text === undefined && s.status === "done"), "segment text is not duplicated in meta");
  assert.equal(m.row.meta.transcription.provider, "vertex");
  assert.equal(m.row.meta.transcription.inputMode, "segmented");
  assert.equal(m.row.meta.transcription.segmentCount, 6);
  assert.equal(m.row.meta.transcription.usage.totalTokenCount, 6 * 20500);
  // Segment calls carry their position; later segments get the previous tail for speaker continuity.
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(m.calls[0].options.previousTail, undefined);
  assert.match(m.calls[3].options.previousTail, /区間3の発話/);
  assert.deepEqual(m.cuts.map(c => c.start), [0, 600, 1200, 1800, 2400, 3000]);
  const left = await readdir(path.join(m.root, "recordings/segments/meeting-1"));
  // T04/T03: a browser webm has no duration metadata, so the already-normalized audio is kept for playback.
  assert.deepEqual(left, ["normalized.mp3"], "segment files are cleaned up; the normalized audio of a webm recording is kept");
  assert.equal(job.playbackFile, "normalized.mp3");
  assert.equal((await advance()).outcome, "idle", "a transcribed meeting is not processed again");
});

test("T04/T03 playback: a long browser webm plays the normalized audio without an extra conversion; a playable m4a and a short webm do not", async t => {
  {
    // 60-minute in-app recording (10.4MB webm, under the 32MB size condition).
    const { m, advance } = await runnerSetup(t, { bytes: 10_914_633, duration: 3603 });
    while (m.row.processingStatus !== "transcribed") await advance();
    assert.equal(m.row.meta.transcriptionJob.playbackFile, "normalized.mp3");
    assert.equal(m.normalized.length, 1, "the segmenting normalization is reused; no second conversion for playback");
    assert.deepEqual(await readdir(path.join(m.root, "recordings/segments/meeting-1")), ["normalized.mp3"]);
  }
  {
    const { m, advance } = await runnerSetup(t, { ext: "m4a", bytes: 25 * 1024 * 1024, duration: 5400 });
    while (m.row.processingStatus !== "transcribed") await advance();
    assert.equal(m.row.meta.transcriptionJob.playbackFile, undefined, "an m4a with duration metadata keeps playing the original");
    assert.deepEqual(await readdir(path.join(m.root, "recordings/segments/meeting-1")), []);
  }
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 300 });
    assert.equal((await advance()).outcome, "transcribed");
    assert.equal(m.normalized.length, 0, "a short webm is sent as is and never converted");
    assert.equal(m.row.meta.transcriptionJob?.playbackFile, undefined);
  }
});

test("T04 90-minute recording completes in three continuations; reservations stay at one call per segment", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 5400, bytes: 21 * 1024 * 1024 });
  const outcomes = [];
  for (let i = 0; i < 5 && m.row.processingStatus !== "transcribed"; i++) outcomes.push((await advance()).outcome);
  assert.deepEqual(outcomes, ["progressed", "progressed", "transcribed"]);
  assert.equal(m.calls.length, 9);
  assert.equal(m.row.transcript.split("\n\n").length, 9);
});

test("T04 lease: an active worker blocks a second one; a stale lease is recovered; late writes from a lost lease are rejected", async t => {
  const { m, advance } = await runnerSetup(t);
  m.row.processingStatus = "transcribing";
  m.row.processingStartedAt = new Date(m.clock - 10_000);
  assert.equal((await advance()).outcome, "leased");
  assert.equal(m.calls.length, 0);
  m.row.processingStartedAt = new Date(m.clock - 300_000);
  // Another worker takes the lease while this one waits for the first segment.
  m.failOn = () => { m.row.processingStartedAt = new Date(m.clock + 1); return null; };
  assert.equal((await advance()).outcome, "leased");
  assert.equal(m.calls.length, 1);
  assert.ok(m.row.meta.transcriptionJob.segments.every(s => s.status !== "done"), "the zombie result is not saved");
});

test("T04 segment failure keeps finished segments, shows which segment failed, and retry resumes from it", async t => {
  const { m, advance } = await runnerSetup(t);
  m.failOn = (n) => n === 3 ? new m.VertexError("http_400", "AIサービスとの通信に失敗しました（400）。") : null;
  const failed = await advance();
  assert.equal(failed.outcome, "error");
  assert.equal(m.row.processingStatus, "error");
  assert.equal(m.row.processingStartedAt, null);
  assert.match(m.row.processingError, /区間3\/6（20:00〜30:10）の文字起こしに失敗しました: AIサービスとの通信に失敗しました（400）。/);
  assert.match(m.row.processingError, /失敗した区間から再開/);
  assert.deepEqual(m.row.meta.transcriptionJob.segments.map(s => s.status), ["done", "done", "error", "pending", "pending", "pending"]);
  // The retry route resets the status to uploaded without touching meta.
  Object.assign(m.row, { processingStatus: "uploaded", processingError: null });
  m.failOn = null;
  while (m.row.processingStatus !== "transcribed") await advance();
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2, 2, 3, 4, 5]);
  assert.equal(m.row.meta.transcriptionJob.segments[2].attempts, 1, "a user retry counts attempts again from zero");
});

test("T04 output/input limit on one segment splits it into halves instead of failing", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 1200 });
  m.failOn = (n) => n === 1 ? new m.VertexError("incomplete", "AIの応答が完了しませんでした。") : null;
  while (!["transcribed", "error"].includes(m.row.processingStatus)) await advance();
  assert.equal(m.row.processingStatus, "transcribed");
  assert.equal(m.row.meta.transcriptionJob.segments.length, 3);
  assert.deepEqual(m.cuts.map(c => c.start), [0, 0, 305, 600]);
});

test("T04 short recordings keep the accepted single inline call; no ffmpeg keeps the old 6MB limit with an explicit error", async t => {
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 300 });
    assert.equal((await advance()).outcome, "transcribed");
    assert.equal(m.normalized.length, 0);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].options, undefined, "legacy prompt and 4096-token output");
    assert.match(m.calls[0].file, /recordings\/demo\.webm$/);
    assert.equal(m.row.transcript, "区間単発の発話");
    assert.equal(m.row.meta.transcription.inputMode, "inline");
  }
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, tools: false, durationSec: 120 });
    assert.equal((await advance()).outcome, "transcribed");
    assert.equal(m.calls.length, 1);
  }
  {
    const { m, advance } = await runnerSetup(t, { ext: "mp4", bytes: 20 * 1024 * 1024, tools: false });
    const result = await advance();
    assert.equal(result.outcome, "error");
    assert.match(m.row.processingError, /ffmpeg/);
    assert.equal(m.calls.length, 0);
  }
});

test("T22 video: only the audio track is transcribed and normalized audio is kept for playback", async t => {
  const { m, advance } = await runnerSetup(t, { ext: "mp4", bytes: 30 * 1024 * 1024, duration: 1500 });
  while (m.row.processingStatus !== "transcribed") await advance();
  assert.equal(m.row.meta.transcriptionJob.playbackFile, "normalized.mp3");
  assert.deepEqual(await readdir(path.join(m.root, "recordings/segments/meeting-1")), ["normalized.mp3"]);
  assert.equal(m.calls.length, 3);
});

test("T22 split uploads are read part by part; over-length and silent/empty results are explicit errors", async t => {
  {
    const { m, advance } = await runnerSetup(t, { ext: "mp4", duration: 900 });
    m.row.recordingUrl = "/uploads/recordings/parts/0f0e0d0c-0b0a-4000-8000-000000000001/manifest.json";
    m.parts = async () => ({ manifest: { extension: "mp4", size: 100 * 1024 * 1024 }, paths: ["/p/part-00000", "/p/part-00001"] });
    while (m.row.processingStatus !== "transcribed") await advance();
    assert.deepEqual(m.normalized[0], ["/p/part-00000", "/p/part-00001"]);
    assert.equal(m.row.meta.transcriptionJob.playbackFile, "normalized.mp3");
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 3 * 3600 + 1 });
    assert.equal((await advance()).outcome, "error");
    assert.match(m.row.processingError, /3時間まで/);
    assert.equal(m.calls.length, 0);
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    m.transcribe = async () => { m.clock += 1000; return { text: "  ", metrics: { usage: {}, elapsedMs: 1 } }; };
    assert.equal((await advance()).outcome, "error");
    assert.match(m.row.processingError, /区間1\/2/);
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    m.normalize = async () => { throw new m.MediaToolError("media_no_audio", "このファイルには音声トラックが見つかりませんでした。"); };
    assert.equal((await advance()).outcome, "error");
    assert.equal(m.row.processingError, "このファイルには音声トラックが見つかりませんでした。");
  }
});

test("T04 a request with too little budget left does not start ffmpeg or a segment", async t => {
  const { m, advance } = await runnerSetup(t);
  assert.equal((await advance(100_000)).outcome, "progressed");
  assert.equal(m.normalized.length, 0);
  assert.equal(m.row.processingStartedAt, null);
});

test("T04 transient failures are retried automatically up to 3 attempts, then shown as an error", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 900 });
  m.failOn = () => new m.VertexError("http_503", "AIサービスとの通信に失敗しました（503）。");
  assert.equal((await advance()).outcome, "retrying");
  assert.equal(m.row.processingStatus, "transcribing");
  assert.equal(m.row.processingStartedAt, null);
  assert.equal(m.row.meta.transcriptionJob.segments[0].status, "pending");
  assert.equal((await advance()).outcome, "retrying");
  assert.equal((await advance()).outcome, "error");
  assert.equal(m.calls.length, 3);
  assert.match(m.row.processingError, /区間1\/2/);
});

test("T04 a worker frozen past its budget (Cloud Run 300s / closed tab) does not turn its stale timer into an error", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 900 });
  m.transcribe = async () => { m.clock += 400_000; throw new m.VertexError("timeout", "AIの応答待ちが制限時間を超えました。"); };
  assert.equal((await advance()).outcome, "retrying");
  assert.equal(m.row.processingStatus, "transcribing");
  assert.equal(m.row.processingError, null);
  assert.equal(m.row.processingStartedAt, null);
});

test("T04 a segment that keeps crashing the worker stops at 3 attempts; the per-recording call cap stops runaway cost", async t => {
  {
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    await advance(100_000); // prepare is not started with too little budget
    m.row.processingStatus = "transcribing";
    m.row.meta = { transcriptionJob: { version: 1, state: "transcribe", mode: "segmented", durationSec: 900, autoAnalyze: true, createdAt: "x", updatedAt: "x",
      segments: [{ startSec: 0, endSec: 602, status: "pending", attempts: 3 }, { startSec: 600, endSec: 900, status: "pending", attempts: 0 }] } };
    await mkdir(path.join(m.root, "recordings/segments/meeting-1"), { recursive: true });
    await writeFile(path.join(m.root, "recordings/segments/meeting-1/normalized.mp3"), "x");
    assert.equal((await advance()).outcome, "error");
    assert.match(m.row.processingError, /3回試しても完了しませんでした/);
    assert.equal(m.calls.length, 0);
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    m.row.processingStatus = "transcribing";
    m.row.meta = { transcriptionJob: { version: 1, state: "transcribe", mode: "segmented", durationSec: 900, autoAnalyze: true, vertexAttempts: 4, createdAt: "x", updatedAt: "x",
      segments: [{ startSec: 0, endSec: 602, status: "done", attempts: 2, text: "a" }, { startSec: 600, endSec: 900, status: "pending", attempts: 2 }] } };
    await mkdir(path.join(m.root, "recordings/segments/meeting-1"), { recursive: true });
    await writeFile(path.join(m.root, "recordings/segments/meeting-1/normalized.mp3"), "x");
    assert.equal((await advance()).outcome, "error");
    assert.match(m.row.processingError, /費用保護/);
    assert.equal(m.calls.length, 0);
  }
});

test("T04 lost work files: the normalized audio is rebuilt without redoing finished segments; segment files are per lease", async t => {
  const { m, advance } = await runnerSetup(t);
  assert.equal((await advance()).outcome, "progressed");
  await rm(path.join(m.root, "recordings/segments"), { recursive: true, force: true });
  while (m.row.processingStatus !== "transcribed") await advance();
  assert.equal(m.normalized.length, 2);
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2, 3, 4, 5]);
  assert.ok(m.cuts.every(c => /segment-\d+-\d+-\d+\.mp3$/.test(c.output)), "segment files carry the lease nonce");
});

test("T04 direct recording that hits the output limit switches to segments; a completed job is not reused on re-run", async t => {
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 580 });
    m.failOn = (n, options) => n === 1 && !options ? new m.VertexError("incomplete", "AIの応答が完了しませんでした。") : null;
    while (!["transcribed", "error"].includes(m.row.processingStatus)) await advance();
    assert.equal(m.row.processingStatus, "transcribed");
    assert.equal(m.row.meta.transcriptionJob.mode, "segmented");
    assert.equal(m.normalized.length, 1);
    assert.equal(m.calls.at(-1).options.segment.total, 1);
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    while (m.row.processingStatus !== "transcribed") await advance();
    const calls = m.calls.length;
    // The transcript was cleared via the API and "文字起こし再実行" was pressed.
    Object.assign(m.row, { transcript: "", processingStatus: "uploaded", processingStartedAt: null });
    while (m.row.processingStatus !== "transcribed") await advance();
    assert.equal(m.calls.length, calls * 2, "all segments are transcribed again instead of saving empty headers");
    assert.match(m.row.transcript, /区間2の発話/);
  }
});

test("T04 browser webm without duration metadata keeps the single inline call using the recorder's seconds", async t => {
  const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 120, durationSec: 120 });
  m.probe = async file => { if (file.endsWith(".webm")) throw new m.MediaToolError("media_duration", "no duration"); return 120; };
  assert.equal((await advance()).outcome, "transcribed");
  assert.equal(m.normalized.length, 0);
  assert.equal(m.calls[0].options, undefined);
});

// ---------------------------------------------------------------- timed segments: overlap, completeness retry
const WORDS = ["見積", "導入", "体制", "日程", "予算", "課題", "資料", "説明", "要件", "確認", "契約", "移行"];
const mmss = sec => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
/** 区間 n の架空の時刻付き出力（60秒ごとに1行、最後の行は lastSec）。区間ごとに語を変え、区間どうしが一致しないようにする。 */
function timedText(n, lastSec) {
  const rows = [];
  for (let sec = 0; sec < lastSec; sec += 60) rows.push(`[${mmss(sec)}] 話者${rows.length % 2 + 1}: ${WORDS[(n * 5 + rows.length) % WORDS.length]}について第${n}区間で話しています。`);
  rows.push(`[${mmss(lastSec)}] 話者1: 第${n}区間の最後の発言です。`);
  return rows.join("\n");
}
/** plan(index, nth) が最後の時刻（秒）か、投げるエラーを返す。 */
function timedTranscribe(m, plan) {
  return async (file, options) => {
    m.calls.push({ file, options });
    m.clock += 40_000;
    const index = options.segment.index;
    const outcome = plan(index, m.calls.filter(c => c.options?.segment?.index === index).length);
    if (outcome instanceof Error) throw outcome;
    return { text: timedText(index + 1, outcome), metrics: { usage: { promptTokenCount: 19000, candidatesTokenCount: 1500, totalTokenCount: 20500 }, elapsedMs: 40_000 } };
  };
}
async function craftJob(m, segments, extra = {}) {
  m.row.processingStatus = "transcribing";
  m.row.meta = { transcriptionJob: { version: 1, state: "transcribe", mode: "segmented", durationSec: segments.at(-1).endSec, autoAnalyze: true, createdAt: "x", updatedAt: "x", segments, ...extra } };
  await mkdir(path.join(m.root, "recordings/segments/meeting-1"), { recursive: true });
  await writeFile(path.join(m.root, "recordings/segments/meeting-1/normalized.mp3"), "x");
}
async function untilSettled(m, advance) {
  for (let i = 0; i < 12 && !["transcribed", "error"].includes(m.row.processingStatus); i++) await advance();
}

test("T04 timed segments: the prompt gets the 10s overlap and a tail without times; the transcript has no times", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 1500 });
  m.transcribe = timedTranscribe(m, index => index === 2 ? 290 : 605);
  await untilSettled(m, advance);
  assert.equal(m.row.processingStatus, "transcribed");
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2], "complete outputs are not retried");
  assert.deepEqual(m.calls.map(c => c.options.segment.overlapSec), [0, 10, 10]);
  assert.deepEqual(m.cuts.map(c => [c.start, c.length]), [[0, 610], [600, 610], [1200, 300]], "each cut includes the 10s overlap");
  assert.match(m.calls[1].options.previousTail, /第1区間の最後の発言です。$/);
  assert.doesNotMatch(m.calls[1].options.previousTail, /\[\d/, "the tail passed back to the model has no times");
  assert.deepEqual(m.calls.map(c => c.options.segment.previousTimed), [undefined, true, true], "the previous segments were timed");
  assert.deepEqual(m.calls.map(c => c.options.maxAttempts), [undefined, undefined, undefined], "normal calls keep the 429 retries");
  assert.doesNotMatch(m.row.transcript, /\[\d{2}:\d{2}\]/, "no times reach the transcript");
  assert.match(m.row.transcript, /^話者1: /);
  assert.equal(m.row.transcript.split("\n\n").length, 3);
});

test("T04 timed segments: after an untimed segment saved by the previous version, the old 'do not repeat the overlap' prompt is used", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 900 });
  await craftJob(m, [
    { startSec: 0, endSec: 602, status: "done", attempts: 1, text: "話者1: 旧版の区間1の発話です。\n話者2: 重なりの発話です。" },
    { startSec: 600, endSec: 900, status: "pending", attempts: 0 },
  ], { vertexAttempts: 1 });
  m.transcribe = timedTranscribe(m, () => 290);
  await untilSettled(m, advance);
  assert.equal(m.row.processingStatus, "transcribed");
  assert.equal(m.calls[0].options.segment.previousTimed, false);
  assert.equal(m.calls[0].options.segment.overlapSec, 2);
  assert.match(m.row.transcript, /^話者1: 旧版の区間1の発話です。\n話者2: 重なりの発話です。\n\n話者1: /);
});

test("T04 completeness: an early-stopped segment is sent once more; the later-ending result is kept and both calls are counted", async t => {
  {
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    // Segment 1 stops at 7:00 of 10:10 (threshold 610 - 122 = 488s); the retry reaches the end.
    const inner = timedTranscribe(m, (index, nth) => index === 0 && nth === 1 ? 420 : index === 2 ? 290 : 605);
    const retriedAtCall = [];
    m.transcribe = async (file, options) => {
      // The retry flag is saved before the retry call, so a worker stopped during the call never retries again.
      if (options.segment.index === 0) retriedAtCall.push(m.row.meta.transcriptionJob.segments[0].completenessRetried === true);
      return inner(file, options);
    };
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 2]);
    assert.deepEqual(retriedAtCall, [false, true]);
    assert.equal(m.calls[1].options.previousTail, undefined);
    assert.deepEqual(m.calls.map(c => c.options.maxAttempts), [undefined, 1, undefined, undefined], "the optional retry never re-reserves on 429");
    const [first] = m.row.meta.transcriptionJob.segments;
    assert.equal(first.completenessRetried, true);
    assert.equal(first.attempts, 2);
    assert.equal(first.text, undefined, "segment text is still removed from meta on completion");
    assert.equal(m.row.meta.transcription.attempts, 4, "the retry is a normal Vertex attempt");
    assert.equal(m.row.meta.transcription.usage.totalTokenCount, 4 * 20500, "usage of both calls is recorded");
    assert.match(m.row.transcript.split("\n\n")[0], /第1区間の最後の発言です。$/, "the complete retry is kept");
    assert.equal(m.row.transcript.split("\n\n")[0].split("\n").length, 12);
  }
  {
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    // The retry stops even earlier → the first result is kept.
    m.transcribe = timedTranscribe(m, (index, nth) => index === 0 ? (nth === 1 ? 420 : 300) : index === 2 ? 290 : 605);
    await untilSettled(m, advance);
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 2]);
    assert.equal(m.row.transcript.split("\n\n")[0].split("\n").length, 8, "0..6 min plus the 7:00 line");
  }
  {
    // A retry as long as the first run whose only later time is a mistyped one beyond the segment (17:05 in 10:10)
    // does not replace the first result.
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    const inner = timedTranscribe(m, index => index === 0 ? 420 : index === 2 ? 290 : 605);
    m.transcribe = async (file, options) => {
      const result = await inner(file, options);
      const retry = options.segment.index === 0 && m.calls.filter(c => c.options.segment.index === 0).length === 2;
      return retry ? { ...result, text: `${result.text}\n[17:05] 話者2: 誤った時刻の行です。` } : result;
    };
    await untilSettled(m, advance);
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 2]);
    assert.doesNotMatch(m.row.transcript, /誤った時刻/);
    assert.equal(m.row.transcript.split("\n\n")[0].split("\n").length, 8, "the first result (0..6 min plus 7:00) is kept");
  }
  {
    // Without times the check cannot judge the output → no retry (legacy behaviour).
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    await untilSettled(m, advance);
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2]);
  }
});

test("T04 completeness: a 5-minute half that ends in silence is retried once and then accepted", async t => {
  const { m, advance } = await runnerSetup(t, { duration: 600 });
  await craftJob(m, [{ startSec: 0, endSec: 310, status: "pending", attempts: 0 }, { startSec: 300, endSec: 600, status: "pending", attempts: 0 }]);
  // 310s half: early when the last time is before 310 - 90 = 220s. Speech ends at 2:30 in both calls.
  m.transcribe = timedTranscribe(m, index => index === 0 ? 150 : 290);
  await untilSettled(m, advance);
  assert.equal(m.row.processingStatus, "transcribed");
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1], "one retry only");
  assert.equal(m.row.meta.transcriptionJob.segments[0].completenessRetried, true);
  assert.match(m.row.transcript, /第1区間の最後の発言です。/);
});

test("T04 completeness: no retry on a segment's 3rd attempt; the retry is counted outside the transient-failure budget", async t => {
  const waitingSaved = m => m.updates.some(u => u.meta?.transcriptionJob?.segments?.some(s => s.status === "pending" && s.text));
  {
    // Two earlier transient failures on segment 1 (the call budget is untouched): this is its 3rd attempt, so it is accepted as is.
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    await craftJob(m, [{ startSec: 0, endSec: 610, status: "pending", attempts: 2 }, { startSec: 600, endSec: 900, status: "pending", attempts: 0 }]);
    m.transcribe = timedTranscribe(m, index => index === 0 ? 300 : 290);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1]);
    assert.equal(m.row.meta.transcriptionJob.segments[0].completenessRetried, undefined);
    assert.equal(waitingSaved(m), false, "the early result is not even parked for a retry");
  }
  {
    // A first result parked for a retry by an older worker, already at 3 attempts: accepted without another call.
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    await craftJob(m, [
      { startSec: 0, endSec: 610, status: "pending", attempts: 3, text: timedText(1, 300), usage: { totalTokenCount: 20500 } },
      { startSec: 600, endSec: 900, status: "pending", attempts: 0 },
    ]);
    m.transcribe = timedTranscribe(m, () => 290);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [1]);
    assert.match(m.row.transcript, /第1区間の最後の発言です。/);
  }
  {
    // Call cap 6 (3 segments) with 3 already used: the retry does not depend on that budget (it raises the cap by one).
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    await craftJob(m, planTranscriptionSegments(1500), { vertexAttempts: 3 });
    m.transcribe = timedTranscribe(m, index => index === 0 ? 300 : index === 2 ? 290 : 605);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 2]);
    assert.equal(m.row.meta.transcription.attempts, 7);
  }
});

test("T04 completeness: a retry never takes the transient-failure retry kept for a later segment", async t => {
  const busy = m => new m.VertexError("http_503", "AIサービスとの通信に失敗しました（503）。");
  {
    // 900s, cap 4. Segment 1 needed a transient retry and then stopped early: it is still retried (outside the cap), and
    // segment 2 still gets its transient retry.
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    m.transcribe = timedTranscribe(m, (index, nth) => nth === 1 ? busy(m) : index === 0 ? 300 : 290);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed", m.row.processingError ?? "");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 0, 1, 1]);
    assert.equal(m.row.meta.transcriptionJob.segments[0].completenessRetried, true);
  }
  {
    // Review scenario: segment 1 is retried, then segment 2 fails twice with 503. The original code (no retry) would finish
    // with a third call, and so must this one: two transient retries remain for segment 2.
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    m.transcribe = timedTranscribe(m, (index, nth) => index === 0 ? (nth === 1 ? 420 : 605) : nth <= 2 ? busy(m) : 290);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed", m.row.processingError ?? "");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 1, 1]);
    assert.equal(m.row.meta.transcription.attempts, 5);
  }
});

test("T04 completeness: a segment ending near the recording end is not retried (trailing silence)", async t => {
  // 700s: segment 1 ends at 610, 90s before the end (within max(90, 122)); speech ends at 7:00, the rest is silent.
  const { m, advance } = await runnerSetup(t, { duration: 700 });
  m.transcribe = timedTranscribe(m, index => index === 0 ? 420 : 80);
  await untilSettled(m, advance);
  assert.equal(m.row.processingStatus, "transcribed");
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1]);
});

test("T04 completeness: a failed or interrupted retry keeps the first result and never splits the segment", async t => {
  const failures = [
    m => new m.VertexError("incomplete", "AIの応答が完了しませんでした。"),
    m => new m.VertexError("input_limit", "今回のAI検証では入力が長すぎます。"),
    m => new m.VertexError("http_503", "AIサービスとの通信に失敗しました（503）。"),
    m => new m.VertexError("http_429", "AIサービスが混み合っているか、呼び出し制限に達しています（429）。"),
  ];
  for (const failure of failures) {
    const { m, advance } = await runnerSetup(t, { duration: 1500 });
    m.transcribe = timedTranscribe(m, (index, nth) => index === 0 && nth === 2 ? failure(m) : index === 0 ? 420 : index === 2 ? 290 : 605);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 0, 1, 2], "no further retry of the retry");
    assert.equal(m.calls[1].options.maxAttempts, 1);
    assert.equal(m.row.meta.transcriptionJob.segments.length, 3, "the segment is not split");
    assert.match(m.row.transcript.split("\n\n")[0], /第1区間の最後の発言です。$/);
    assert.equal(m.row.transcript.split("\n\n")[0].split("\n").length, 8);
  }
  {
    // The worker stopped during the retry call: the next continuation keeps the saved first result without calling again.
    const { m, advance } = await runnerSetup(t, { duration: 900 });
    await craftJob(m, [
      { startSec: 0, endSec: 610, status: "pending", attempts: 2, completenessRetried: true, text: timedText(1, 420), usage: { totalTokenCount: 20500 } },
      { startSec: 600, endSec: 900, status: "pending", attempts: 0 },
    ], { vertexAttempts: 2 });
    m.transcribe = timedTranscribe(m, () => 290);
    await untilSettled(m, advance);
    assert.equal(m.row.processingStatus, "transcribed");
    assert.deepEqual(m.calls.map(c => c.options.segment.index), [1]);
    assert.equal(m.row.meta.transcription.usage.totalTokenCount, 2 * 20500);
    assert.match(m.row.transcript, /第1区間の最後の発言です。/);
  }
});

test("T04 completeness: a retry that hits the output limit keeps the first result, even when splitting would be affordable", async t => {
  // 2400s = 4 segments, cap 8. Segment 3 (20:00-30:10) stops at 5:00 and its retry hits MAX_TOKENS: the first result is kept,
  // so a later failure of split halves can never fail a job the original code would have completed.
  const { m, advance } = await runnerSetup(t, { duration: 2400 });
  m.transcribe = timedTranscribe(m, (index, nth) => index === 2 ? (nth === 1 ? 300 : new m.VertexError("incomplete", "AIの応答が完了しませんでした。")) : index === 3 ? 590 : 605);
  await untilSettled(m, advance);
  assert.equal(m.row.processingStatus, "transcribed", m.row.processingError ?? "");
  assert.deepEqual(m.calls.map(c => c.options.segment.index), [0, 1, 2, 2, 3]);
  assert.equal(m.row.meta.transcriptionJob.segments.length, 4, "not split");
  assert.equal(m.row.meta.transcription.attempts, 5);
  assert.equal(m.row.meta.transcription.usage.totalTokenCount, 4 * 20500, "the kept first run's usage is recorded; the failed retry has none");
  assert.equal(m.row.transcript.split("\n\n").length, 4);
  assert.doesNotMatch(m.row.transcript, /\[\d{2}:\d{2}\]/);
});

test("T04 direct threshold follows the overlap: up to 610s is one inline call, longer is segmented", async t => {
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 610 });
    assert.equal((await advance()).outcome, "transcribed");
    assert.equal(m.normalized.length, 0);
    assert.equal(m.calls[0].options, undefined);
  }
  {
    const { m, advance } = await runnerSetup(t, { bytes: 900 * 1024, duration: 615 });
    await untilSettled(m, advance);
    assert.equal(m.normalized.length, 1);
    assert.deepEqual(m.row.meta.transcriptionJob.segments.map(s => [s.startSec, s.endSec]), [[0, 610], [600, 615]]);
  }
});

// ---------------------------------------------------------------- continue + routes
const continueEntry = "src/lib/meetings/transcription-continue.ts";
test("T04 continuation runs the automatic minutes/BANT analysis exactly once after transcription", async () => {
  const m = { analyses: 0, advances: 0, updates: [], row: { processingStatus: "transcribed", transcript: "本文", meta: { transcriptionJob: { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: true } } } };
  m.prisma = { meeting: { findUnique: async () => structuredClone(m.row), updateMany: async ({ data }) => { Object.assign(m.row, structuredClone(data)); return { count: 1 }; } } };
  const lib = await offlineModule(continueEntry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/meetings/analysis": "export const runMeetingAnalysis=async()=>{mocks.analyses++;mocks.row.processingStatus='completed';return {ok:true};};",
    "@/lib/meetings/processing": STATUS,
    "./transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;export const advanceMeetingTranscription=async()=>{mocks.advances++;return {outcome:'idle'}};",
    "./long-analysis": "export const advanceLongAnalysis=async()=>{throw Error('no long analysis in this test')};",
  }, [continueEntry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
  assert.equal((await lib.continueMeetingProcessing("meeting-1", { allowAnalysis: false })).outcome, "analysis_skipped");
  assert.equal(m.analyses, 0);
  assert.equal((await lib.continueMeetingProcessing("meeting-1")).outcome, "analyzed");
  assert.equal(m.row.meta.transcriptionJob.autoAnalyze, false, "the automatic trigger is consumed before analysis starts");
  assert.equal(m.analyses, 1);
  await lib.continueMeetingProcessing("meeting-1");
  assert.equal(m.analyses, 1);
  assert.equal(m.advances, 1);
});

const transcriptionRoute = "src/app/api/meetings/[id]/transcription/route.ts";
test("T04 continuation route checks auth, permission, environment and deal before processing", async () => {
  const params = { params: Promise.resolve({ id: "meeting-1" }) };
  for (const [change, status] of [[m => m.session = null, 401], [m => m.permission = "viewer", 403], [m => m.env = { NODE_ENV: "production" }, 409], [m => m.tenant = { crossTenant: true }, 409], [m => m.target = null, 404], [m => m.target.deal.deletedAt = new Date(), 404], [() => {}, 200]]) {
    const m = { session: { userId: "u" }, permission: "user", env: { LUMA_CLOUD_AI_MODE: "vertex" }, continued: 0,
      target: { id: "meeting-1", deal: { deletedAt: null, company: { deletedAt: null } } },
      status: { id: "meeting-1", processingStatus: "transcribing", processingError: null, durationSec: 3600, audioSizeBytes: 1, processingStartedAt: null, processingCompletedAt: null, transcript: null, minutes: null, summary: null, recordingUrl: "/uploads/r.webm", meta: { transcriptionJob: { version: 1, state: "transcribe", mode: "segmented", segments: [{ startSec: 0, endSec: 602, status: "done", attempts: 1 }, { startSec: 600, endSec: 1200, status: "pending", attempts: 0 }], autoAnalyze: true } } } };
    change(m);
    m.prisma = { user: { findUnique: async () => ({ permission: m.permission }) }, meeting: { findUnique: async ({ select }) => select.deal ? m.target : m.status } };
    const route = await offlineModule(transcriptionRoute, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
      "@/lib/meetings/transcription-continue": "export const continueMeetingProcessing=async()=>{mocks.continued++;return {outcome:'progressed'}};",
      "@/lib/tenant-context": "export const getRequestTenant=async()=>mocks.tenant??null;",
    }, [transcriptionRoute, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", "src/lib/meetings/status-payload.ts", ...LONG_ANALYSIS_PURE_MODULES]);
    const response = await route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
    assert.equal(response.status, status);
    assert.equal(m.continued, status === 200 ? 1 : 0);
    if (status === 200) {
      const json = await response.json();
      assert.equal(json.outcome, "progressed");
      assert.deepEqual(json.meeting.transcription, { mode: "job", state: "transcribe", completed: 1, total: 2, durationSec: null, waiting: true, autoAnalyzePending: false });
      assert.equal(json.meeting.recordingUrl, undefined);
      assert.equal(json.meeting.meta, undefined);
      assert.equal(json.meeting.transcript, undefined);
    }
  }
});

const uploadEntry = "src/app/api/meetings/route.ts";
test("T04 upload in the Cloud Run environment accepts long audio/video with ffmpeg and returns 202 without waiting", async () => {
  const cases = [
    { name: "long.webm", size: 14 * 1024 * 1024, tools: true, status: 202 },
    { name: "meeting.mp4", size: 20 * 1024 * 1024, tools: true, status: 202 },
    { name: "meeting.mp4", size: 1024, tools: false, status: 413 },
    { name: "long.webm", size: 7 * 1024 * 1024, tools: false, status: 413 },
    { name: "short.webm", size: 1024, tools: false, status: 202 },
  ];
  for (const c of cases) {
    const m = { session: { userId: "u" }, permission: "user", jobMode: true, mediaTools: c.tools, stored: 0, scheduled: 0 };
    m.prisma = { user: { findUnique: async () => ({ permission: "user" }) }, deal: { findUnique: async () => ({ deletedAt: null, company: { deletedAt: null } }) },
      meeting: { create: async ({ data }) => ({ id: "meeting-1", ...data }), findUnique: async () => { throw Error("must not wait for transcription"); } } };
    const route = await offlineModule(uploadEntry, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
      "@/lib/storage": "export class StorageConfigError extends Error {};export const putFile=async()=>{mocks.stored++;return {url:'/uploads/recordings/x'}};",
      "@/lib/meetings/processing": "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBED:'transcribed',COMPLETED:'completed'};export const scheduleMeetingTranscription=async()=>{mocks.scheduled++};",
      "@/lib/meetings/attachment-text": "export const extractAttachmentText=()=>'';",
      "@/lib/meetings/transcription-job": "export const isTranscriptionJobMode=()=>mocks.jobMode===true;",
      "@/lib/meetings/audio-segments": "export const mediaToolsAvailable=async()=>mocks.mediaTools!==false;",
    }, [uploadEntry, "src/lib/meetings/upload-formats.ts"], ["next/server", "zod", "node:crypto"]);
    const form = new FormData();
    form.set("dealId", "00000000-0000-4000-8000-000000000001");
    form.set("file", new File([new Uint8Array(c.size)], c.name));
    const response = await route.POST(new Request("http://offline.invalid", { method: "POST", body: form }));
    assert.equal(response.status, c.status, `${c.name} ${c.size} tools=${c.tools}`);
    if (response.status === 202) {
      const json = await response.json();
      assert.equal(json.transcriptionMode, "job");
      assert.equal(m.scheduled, 0, "no in-request transcription");
      assert.equal(m.stored, 1);
    }
  }
});

test("T04 status payload: stalled analysis is recoverable after 15 minutes; progress only in the job environment", async () => {
  const previous = process.env.LUMA_CLOUD_AI_MODE;
  const { meetingStatusPayload, isAnalysisStalled } = statusPayload;
  const now = Date.parse("2026-09-25T02:00:00Z");
  const row = { id: "m", processingStatus: "analyzing", processingError: null, durationSec: null, audioSizeBytes: null, processingStartedAt: new Date(now - 16 * 60_000), processingCompletedAt: null, transcript: "本文", minutes: null, summary: null, recordingUrl: "/uploads/a.webm", meta: {} };
  assert.equal(isAnalysisStalled(row, now), true);
  assert.equal(isAnalysisStalled({ ...row, processingStartedAt: new Date(now - 60_000) }, now), false);
  try {
    delete process.env.LUMA_CLOUD_AI_MODE;
    assert.equal(meetingStatusPayload(row, now).transcription, null);
    process.env.LUMA_CLOUD_AI_MODE = "vertex";
    const done = { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: true };
    const payload = meetingStatusPayload({ ...row, processingStatus: "transcribed", meta: { transcriptionJob: done } }, now);
    assert.equal(payload.transcription.autoAnalyzePending, true);
    assert.equal(payload.analysisStalled, false);
    assert.equal(meetingStatusPayload({ ...row, processingStatus: "uploaded", processingStartedAt: null, transcript: null }, now).transcription.state, "prepare");
  } finally {
    if (previous === undefined) delete process.env.LUMA_CLOUD_AI_MODE; else process.env.LUMA_CLOUD_AI_MODE = previous;
  }
});

test("T04 analysis stuck in 'analyzing' beyond 15 minutes can be re-claimed; a running one cannot", async () => {
  const entry = "src/lib/meetings/analysis.ts";
  for (const [ageMs, expectedOk] of [[16 * 60_000, true], [60_000, false]]) {
    const startedAt = new Date(Date.now() - ageMs);
    const row = { id: "meeting", dealId: "deal", minutes: null, transcript: "架空顧客の発言", processingStatus: "analyzing", processingStartedAt: startedAt, meta: {},
      deal: { title: "架空商談", company: { name: "架空企業" }, products: [] } };
    const m = { row, bant: 0 };
    m.prisma = { meeting: { findUnique: async () => structuredClone(row), update: async ({ data }) => Object.assign(row, data), updateMany: async ({ where, data }) => {
      if (!whereMatches(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 };
    } }, aiLog: { findMany: async () => [], create: async () => ({}) }, deal: { updateMany: async () => ({ count: 0 }) } };
    m.pipeline = async () => ({ meetingMinutes: { markdown: "## 参加者", json: {}, usedFallback: false }, topSales: { real_intent: "意図", winning_scenario: "仮説" },
      analysis: { issues: [], bant: { budget: "未確認", authority: "未確認", need: "未確認", timeline: "未確認" } }, nextActions: { next_actions: [] }, trace: [], structured: {}, strategy: {}, scores: {}, fallback: false, improved: false });
    const lib = await offlineModule(entry, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/ai/pipeline": "export const runPipeline=(...a)=>mocks.pipeline(...a);",
      "@/lib/meetings/processing": STATUS,
      "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>false;",
      "@/lib/ai/summarize-bant": "export const scheduleDealBantSummary=async()=>{mocks.bant++};",
    }, [entry, "src/lib/meetings/status-payload.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
    const result = await lib.runMeetingAnalysis("meeting");
    assert.equal(result.ok, expectedOk);
    assert.equal(row.processingStatus, expectedOk ? "completed" : "analyzing");
  }
});

test("T04 retry route recovers an in-request transcription stuck for over 10 minutes but not a running one", async () => {
  const entry = "src/app/api/meetings/[id]/status/route.ts";
  for (const [ageMs, status] of [[11 * 60_000, 202], [60_000, 409]]) {
    const row = { id: "meeting", recordingUrl: "/uploads/r.webm", transcript: null, processingStatus: "transcribing", processingStartedAt: new Date(Date.now() - ageMs), meta: { transcriptionJob: { keep: true } } };
    const m = { row, scheduled: 0, session: { userId: "u" }, env: { NODE_ENV: "development" } };
    m.prisma = { user: { findUnique: async () => ({ permission: "user" }) }, meeting: { findUnique: async () => structuredClone(row), updateMany: async ({ where, data }) => {
      if (!whereMatches(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 };
    } } };
    const route = await offlineModule(entry, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);",
      "@/lib/meetings/processing": "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded'};export const scheduleMeetingTranscription=async()=>{mocks.scheduled++};",
    }, [entry, "src/lib/meetings/status-payload.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
    const response = await route.POST(new Request("http://offline.invalid", { method: "POST", body: JSON.stringify({ action: "retry-transcription" }) }), { params: Promise.resolve({ id: "meeting" }) });
    assert.equal(response.status, status);
    assert.equal(row.processingStatus, status === 202 ? "uploaded" : "transcribing");
    assert.deepEqual(row.meta, { transcriptionJob: { keep: true } }, "saved segments are kept for resume");
  }
});

test("T04 cloud build: the runtime image installs ffmpeg and src has no directory the packager rejects", async () => {
  const { readFile } = await import("node:fs/promises");
  const dockerfile = await readFile(new URL("../scripts/cloud-development/Dockerfile", import.meta.url), "utf8");
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  assert.match(runtime, /apt-get install -y --no-install-recommends[^\n]*\bffmpeg\b/);
  assert.doesNotMatch(dockerfile, /npm (?:i|install)\b(?! ci)/);
  const bad = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || /^(node_modules|uploads|secrets|credentials)$/i.test(entry.name)) bad.push(path.join(dir, entry.name));
      await walk(path.join(dir, entry.name));
    }
  }
  await walk(fileURLToPath(new URL("../src", import.meta.url)));
  assert.deepEqual(bad, []);
  await stat(new URL("../src/app/api/meetings/upload-sessions/route.ts", import.meta.url));
});

test("T22 playback: video/split uploads play the normalized audio; a split upload without it is not served as raw parts", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t22-play-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "recordings/segments/meeting-1"), { recursive: true });
  await writeFile(path.join(root, "recordings/segments/meeting-1/normalized.mp3"), "MP3DATA");
  const entry = "src/app/api/meetings/[id]/recording/route.ts";
  const job = { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: false, playbackFile: "normalized.mp3" };
  const cases = [
    [{ recordingUrl: "/uploads/recordings/a.mp4", meta: { transcriptionJob: job } }, 200, "MP3DATA", "audio/mpeg"],
    [{ recordingUrl: "/uploads/recordings/parts/0f0e0d0c-0b0a-4000-8000-000000000001/manifest.json", meta: {} }, 404, null, null],
    [{ recordingUrl: "/uploads/recordings/a.webm", meta: {} }, 200, "ORIGINAL", "audio/webm"],
  ];
  for (const [row, status, text, type] of cases) {
    const m = { session: { userId: "u" }, prisma: { meeting: { findUnique: async () => row } },
      localPath: key => key?.startsWith("/uploads/") ? path.join(root, key.slice("/uploads/".length)) : null };
    const route = await offlineModule(entry, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};",
      "@/lib/storage": "export const localStoragePath=k=>mocks.localPath(k);export const fetchStored=async()=>({buffer:Buffer.from('ORIGINAL'),contentType:'audio/webm'});",
    }, [entry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", "src/lib/meetings/transcription-files.ts", "src/lib/meetings/upload-sessions.ts"], ["next/server", "node:fs/promises", "node:path"]);
    const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: "meeting-1" }) });
    assert.equal(response.status, status);
    if (text) {
      assert.equal(await response.text(), text);
      assert.equal(response.headers.get("content-type"), type);
    }
  }
});

test("T04 cron: CRON_SECRET required, job environment only, tenants iterated, transcribing, auto-analysis-pending and long-analysis meetings continued", async () => {
  const entry = "src/app/api/cron/meeting-transcriptions/route.ts";
  const load = (m) => offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;export const prismaUnscoped=mocks.prismaUnscoped;",
    "@/lib/agent-auth": "export const isValidCronSecret=()=>mocks.cronOk;",
    "@/lib/meetings/processing": STATUS,
    "@/lib/meetings/transcription-continue": "export const continueMeetingProcessing=async(id,o)=>{mocks.continued.push([mocks.tenant,id,o.allowAnalysis]);return {outcome:'progressed'}};",
    "@/lib/meetings/transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;",
    "@/lib/tenant-context": "export const runAsTenant=async(code,fn)=>{mocks.tenant=code;try{return await fn()}finally{mocks.tenant=null}};",
  }, [entry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts"]);
  const done = { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: true };
  const m = { cronOk: false, env: { LUMA_CLOUD_AI_MODE: "vertex" }, continued: [], queries: [] };
  m.prismaUnscoped = { tenant: { findMany: async () => [{ code: "luma" }, { code: "reagey" }] } };
  m.prisma = { meeting: { findMany: async ({ where }) => {
    m.queries.push([m.tenant, where.processingStatus, where]);
    if (m.tenant !== "luma") return [];
    if (typeof where.processingStatus === "object") return [{ id: "m-up", processingStatus: "uploaded", meta: null }];
    // 長い記録の分析（原文抜粋の抽出ジョブ）。テキスト添付は録音が無いので recordingUrl を条件にしない。
    if (where.processingStatus === "analyzing") return [{ id: "m-long", processingStatus: "analyzing", meta: { analysisJob: { version: 1 } } }];
    return [{ id: "m-done", processingStatus: "transcribed", meta: { transcriptionJob: done } }, { id: "m-consumed", processingStatus: "transcribed", meta: { transcriptionJob: { ...done, autoAnalyze: false } } }];
  } } };
  let route = await load(m);
  assert.equal((await route.GET(new Request("http://offline.invalid"))).status, 401);
  m.cronOk = true;
  m.env = { NODE_ENV: "production" };
  route = await load(m);
  assert.equal((await (await route.GET(new Request("http://offline.invalid"))).json()).skipped, true);
  m.env = { LUMA_CLOUD_AI_MODE: "vertex" };
  route = await load(m);
  const json = await (await route.POST(new Request("http://offline.invalid", { method: "POST" }))).json();
  assert.equal(json.processed, 3);
  assert.deepEqual(m.continued.map(([tenant, id]) => `${tenant}:${id}`), ["luma:m-up", "luma:m-done", "luma:m-long"]);
  const longQuery = m.queries.find(([tenant, status]) => tenant === "luma" && status === "analyzing")[2];
  // offlineModule の別レルムで作られたオブジェクトなので JSON で比べる。
  assert.equal(JSON.stringify(longQuery.meta), JSON.stringify({ path: ["analysisJob", "version"], equals: 1 }));
  assert.equal(longQuery.recordingUrl, undefined);
  assert.equal(JSON.stringify(longQuery.deal), JSON.stringify({ deletedAt: null, company: { deletedAt: null } }));
  assert.ok(m.continued.every(([, , allowAnalysis]) => allowAnalysis === true));
  assert.ok(m.queries.some(([tenant]) => tenant === "reagey"), "every active tenant is visited");
});

test("T04 processing: the Cloud Run job environment never transcribes inside the upload request", async () => {
  const m = { env: { NODE_ENV: "production", LUMA_CLOUD_AI_MODE: "vertex" }, calls: 0 };
  m.prisma = { meeting: { updateMany: async () => { m.calls++; return { count: 1 }; } } };
  const lib = await offlineModule("src/lib/meetings/processing.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "next/server": "export const after=()=>{mocks.calls++};",
    "@/lib/ai/openai": "export const transcribeFileWithMetrics=async()=>{mocks.calls++};",
    "@/lib/storage": "export const fetchStored=async()=>null;export const writeTempFile=async()=>'';export const cleanupTempFile=async()=>{};",
  }, ["src/lib/meetings/processing.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts"]);
  await lib.scheduleMeetingTranscription("meeting-1");
  assert.equal(m.calls, 0);
});

test("T04 status payload flags an in-request transcription stuck for 10 minutes only outside the job environment", () => {
  const previous = process.env.LUMA_CLOUD_AI_MODE;
  const now = Date.parse("2026-09-25T02:00:00Z");
  const row = { id: "m", processingStatus: "transcribing", processingError: null, durationSec: null, audioSizeBytes: null, processingStartedAt: new Date(now - 11 * 60_000), processingCompletedAt: null, transcript: null, minutes: null, summary: null, recordingUrl: "/uploads/a.webm", meta: {} };
  try {
    delete process.env.LUMA_CLOUD_AI_MODE;
    assert.equal(statusPayload.meetingStatusPayload(row, now).transcriptionStalled, true);
    assert.equal(statusPayload.meetingStatusPayload({ ...row, processingStartedAt: new Date(now - 60_000) }, now).transcriptionStalled, false);
    process.env.LUMA_CLOUD_AI_MODE = "vertex";
    assert.equal(statusPayload.meetingStatusPayload(row, now).transcriptionStalled, false);
  } finally {
    if (previous === undefined) delete process.env.LUMA_CLOUD_AI_MODE; else process.env.LUMA_CLOUD_AI_MODE = previous;
  }
});

test("T04 long transcript over the analysis input limit gets a clear message; a superseded analysis cannot overwrite", async () => {
  const entry = "src/lib/meetings/analysis.ts";
  const setupAnalysis = (pipeline) => {
    const row = { id: "meeting", dealId: "deal", minutes: null, transcript: "発話".repeat(20000), processingStatus: "transcribed", processingStartedAt: null, meta: {},
      deal: { title: "架空商談", company: { name: "架空企業" }, products: [] } };
    const m = { row, pipeline };
    m.prisma = { meeting: { findUnique: async () => structuredClone(row), update: async () => { throw Error("final writes must be conditional"); }, updateMany: async ({ where, data }) => {
      if (!whereMatches(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 };
    } }, aiLog: { findMany: async () => [], create: async () => { m.logs = (m.logs ?? 0) + 1; } }, deal: { updateMany: async () => ({ count: 0 }) } };
    return m;
  };
  const boundaries = {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/ai/pipeline": "export const runPipeline=(...a)=>mocks.pipeline(...a);",
    "@/lib/meetings/processing": STATUS,
    "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>false;",
    "@/lib/ai/summarize-bant": "export const scheduleDealBantSummary=async()=>{};",
  };
  const allowed = [entry, "src/lib/meetings/status-payload.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES];
  {
    const m = setupAnalysis(async () => { throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); });
    const lib = await offlineModule(entry, m, boundaries, allowed);
    const result = await lib.runMeetingAnalysis("meeting");
    assert.equal(result.ok, false);
    assert.equal(m.row.processingStatus, "error");
    assert.match(m.row.processingError, /文字起こしは保存済みです/);
    assert.match(m.row.processingError, /再実行しても同じ結果/);
    assert.match(m.row.processingError, /40,000文字/);
  }
  {
    const m = setupAnalysis(null);
    m.pipeline = async () => {
      // While this analysis runs, it is treated as stalled and another run re-claims it.
      m.row.processingStartedAt = new Date(Date.now() + 5);
      return { meetingMinutes: { markdown: "古い結果", json: {}, usedFallback: false }, topSales: { real_intent: "古い", winning_scenario: "古い" },
        analysis: { issues: [], bant: { budget: "", authority: "", need: "", timeline: "" } }, nextActions: { next_actions: [] }, trace: [{ step: "x" }], structured: {}, strategy: {}, scores: {}, fallback: false, improved: false };
    };
    const lib = await offlineModule(entry, m, boundaries, allowed);
    const result = await lib.runMeetingAnalysis("meeting");
    assert.equal(result.ok, false);
    assert.equal(m.row.summary, undefined, "the old result is discarded");
    assert.equal(m.row.minutes, null);
    assert.equal(m.logs, undefined, "no duplicate AI logs");
  }
});

test("T04 automatic analysis: the continuation claims 'analyzing' and consumes the trigger in one write; analysis accepts only that claim", async () => {
  const entry = "src/lib/meetings/analysis.ts";
  const claimedAt = new Date("2026-09-25T03:00:00Z");
  for (const [startedAt, expectedOk] of [[claimedAt, true], [new Date("2026-09-25T03:00:05Z"), false]]) {
    const row = { id: "meeting", dealId: "deal", minutes: null, transcript: "架空の発言", processingStatus: "analyzing", processingStartedAt: startedAt, meta: {},
      deal: { title: "架空商談", company: { name: "架空企業" }, products: [] } };
    const m = { row, claims: 0 };
    m.prisma = { meeting: { findUnique: async () => structuredClone(row), updateMany: async ({ where, data }) => {
      if (data.processingStatus === "analyzing") m.claims++;
      if (!whereMatches(row, where)) return { count: 0 }; Object.assign(row, data); return { count: 1 };
    } }, aiLog: { findMany: async () => [], create: async () => ({}) }, deal: { updateMany: async () => ({ count: 0 }) } };
    m.pipeline = async () => ({ meetingMinutes: { markdown: "## 参加者", json: {}, usedFallback: false }, topSales: { real_intent: "意図", winning_scenario: "仮説" },
      analysis: { issues: [], bant: { budget: "", authority: "", need: "", timeline: "" } }, nextActions: { next_actions: [] }, trace: [], structured: {}, strategy: {}, scores: {}, fallback: false, improved: false });
    const lib = await offlineModule(entry, m, {
      "@/lib/db": "export const prisma=mocks.prisma;",
      "@/lib/ai/pipeline": "export const runPipeline=(...a)=>mocks.pipeline(...a);",
      "@/lib/meetings/processing": STATUS,
      "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>false;",
      "@/lib/ai/summarize-bant": "export const scheduleDealBantSummary=async()=>{};",
    }, [entry, "src/lib/meetings/status-payload.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
    const result = await lib.runMeetingAnalysis("meeting", { claimedAt });
    assert.equal(result.ok, expectedOk);
    assert.equal(m.claims, 0, "no second claim write");
    assert.equal(row.processingStatus, expectedOk ? "completed" : "analyzing");
  }
  // The continuation's single write sets analyzing, the claim time and autoAnalyze=false together.
  const writes = [];
  const m = { analyses: [], row: { processingStatus: "transcribed", transcript: "本文", meta: { transcriptionJob: { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: true } } } };
  m.prisma = { meeting: { findUnique: async () => structuredClone(m.row), updateMany: async ({ where, data }) => { writes.push({ where, data }); Object.assign(m.row, structuredClone(data)); return { count: 1 }; } } };
  const lib = await offlineModule(continueEntry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/meetings/analysis": "export const runMeetingAnalysis=async(id,o)=>{mocks.analyses.push(o);return {ok:true}};",
    "@/lib/meetings/processing": STATUS,
    "./transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;export const advanceMeetingTranscription=async()=>({outcome:'idle'});",
    "./long-analysis": "export const advanceLongAnalysis=async()=>{throw Error('no long analysis in this test')};",
  }, [continueEntry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
  assert.equal((await lib.continueMeetingProcessing("meeting-1")).outcome, "analyzed");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].where.processingStatus, "transcribed");
  assert.equal(writes[0].data.processingStatus, "analyzing");
  assert.equal(writes[0].data.meta.transcriptionJob.autoAnalyze, false);
  assert.equal(m.analyses[0].claimedAt.getTime(), writes[0].data.processingStartedAt.getTime());
});
