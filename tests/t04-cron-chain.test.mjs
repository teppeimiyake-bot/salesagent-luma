import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

// 無人処理（cron）の1回の実行の中で、文字起こしが終わった記録を続けて分析まで進めるかの確認。
// cron の route と実際の継続処理（transcription-continue.ts）を使い、文字起こし・分析・長い記録の分析は
// 処理権（processingStartedAt）の扱いを本物に合わせた模擬にする。時計は模擬の時刻で進める。
const entry = "src/app/api/cron/meeting-transcriptions/route.ts";
const STATUS = "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',TRANSCRIBED:'transcribed',ANALYZING:'analyzing',COMPLETED:'completed',ERROR:'error'};";
const LEASE_MS = 290_000;
const doneJob = { version: 1, state: "done", mode: "direct", segments: [{ startSec: 0, endSec: 150, status: "done", attempts: 1 }], autoAnalyze: true };

function matches(row, where) {
  for (const [key, value] of Object.entries(where)) {
    if (key === "id" && row.id !== value) return false;
    if (key === "processingStatus") {
      if (typeof value === "string" ? row.processingStatus !== value : !value.in.includes(row.processingStatus)) return false;
    }
    if (key === "processingStartedAt") {
      if (value === null ? row.processingStartedAt !== null : row.processingStartedAt?.getTime() !== value.getTime()) return false;
    }
  }
  return true;
}

function setup({ transcribeMs = 10_000, analyzeMs = 30_000, analysisKind = "ok" } = {}) {
  const m = { clock: 0, rows: new Map(), calls: [], env: { LUMA_CLOUD_AI_MODE: "vertex" } };
  m.prismaUnscoped = { tenant: { findMany: async () => [{ code: "luma" }] } };
  m.prisma = { meeting: {
    findMany: async ({ where, take }) => [...m.rows.values()].filter(row => {
      if (typeof where.processingStatus === "object") return where.processingStatus.in.includes(row.processingStatus);
      if (row.processingStatus !== where.processingStatus) return false;
      if (where.processingStatus === "transcribed") return row.meta?.transcriptionJob?.state === "done" && row.meta.transcriptionJob.autoAnalyze === true;
      return row.meta?.analysisJob?.version === 1;
    }).slice(0, take).map(row => ({ id: row.id, processingStatus: row.processingStatus, meta: structuredClone(row.meta) })),
    findUnique: async ({ where }) => (m.rows.has(where.id) ? structuredClone(m.rows.get(where.id)) : null),
    updateMany: async ({ where, data }) => {
      m.beforeUpdate?.(where, data);
      const row = m.rows.get(where.id);
      if (!row || !matches(row, where)) return { count: 0 };
      Object.assign(row, structuredClone(data));
      return { count: 1 };
    },
  } };
  // 文字起こし：本物と同じく、処理権が新しい（290秒以内）記録は取れずに leased を返す。
  m.transcribe = async (id, { budgetMs }) => {
    m.calls.push(["transcribe", id, budgetMs]);
    const row = m.rows.get(id);
    if (!row || !["uploaded", "transcribing"].includes(row.processingStatus)) return { outcome: "idle" };
    if (row.processingStartedAt && m.clock - row.processingStartedAt.getTime() < LEASE_MS) return { outcome: "leased" };
    m.clock += transcribeMs;
    Object.assign(row, { processingStatus: "transcribed", processingStartedAt: null, transcript: "顧客：予算は来期に確保します。", meta: { transcriptionJob: structuredClone(doneJob) } });
    m.afterTranscribed?.(row);
    return { outcome: "transcribed" };
  };
  // 分析：本物と同じく、呼び出し側が取った処理権（claimedAt）を持ったままのときだけ実行・保存する。
  m.analyze = async (id, { claimedAt }) => {
    m.calls.push(["analyze", id]);
    const row = m.rows.get(id);
    if (row.processingStatus !== "analyzing" || row.processingStartedAt?.getTime() !== claimedAt.getTime()) return { ok: false, kind: "in_flight", processingStatus: row.processingStatus };
    m.clock += analyzeMs;
    if (analysisKind === "accepted") {
      Object.assign(row, { processingStartedAt: null, meta: { ...row.meta, analysisJob: { version: 1, state: "extract" } } });
      return { ok: false, kind: "accepted", chunks: 3 };
    }
    Object.assign(row, { processingStatus: "completed", summary: "要約", processingCompletedAt: new Date(m.clock) });
    return { ok: true, meetingId: id, result: {} };
  };
  m.advanceLong = async (id, options) => {
    m.calls.push(["long", id, options.budgetMs, options.allowPipeline]);
    return { outcome: "progressed" };
  };
  const load = () => offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;export const prismaUnscoped=mocks.prismaUnscoped;",
    "@/lib/agent-auth": "export const isValidCronSecret=()=>true;",
    "@/lib/meetings/processing": STATUS,
    "@/lib/meetings/transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;",
    "./transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;export const advanceMeetingTranscription=(...a)=>mocks.transcribe(...a);",
    "@/lib/meetings/analysis": "export const runMeetingAnalysis=(...a)=>mocks.analyze(...a);",
    "./long-analysis": "export const advanceLongAnalysis=(...a)=>mocks.advanceLong(...a);",
    "./long-analysis-job": "export const readAnalysisJob=(meta)=>meta&&meta.analysisJob&&meta.analysisJob.version===1?meta.analysisJob:null;",
    "@/lib/tenant-context": "export const runAsTenant=async(code,fn)=>fn();",
  }, [entry, "src/lib/meetings/transcription-continue.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts"]);
  const run = async (route) => {
    const realNow = Date.now;
    Date.now = () => m.clock;
    try {
      const res = await route.GET(new Request("http://offline.invalid"));
      return { status: res.status, body: await res.json() };
    } finally {
      Date.now = realNow;
    }
  };
  const add = (id, fields = {}) => m.rows.set(id, { id, processingStatus: "uploaded", processingStartedAt: null, transcript: null, meta: null, ...fields });
  return { m, load, run, add };
}

test("T04 cron chain: a short recording goes from uploaded to completed in one cron run", async () => {
  const { m, load, run, add } = setup();
  add("m-short");
  const route = await load();
  const { status, body } = await run(route);
  assert.equal(status, 200);
  assert.equal(m.rows.get("m-short").processingStatus, "completed");
  assert.deepEqual(m.calls.map(([kind, id]) => `${kind}:${id}`), ["transcribe:m-short", "analyze:m-short"]);
  // 自動分析は1回だけ（消費済みの印が残る）。
  assert.equal(m.rows.get("m-short").meta.transcriptionJob.autoAnalyze, false);
  assert.equal(body.processed, 1);
  assert.equal(body.results[0].outcome, "analyzed");
  assert.deepEqual(body.results[0].steps, ["transcribed", "analyzed"]);
});

test("T04 cron chain: without enough time left after the transcription, the record stays transcribed for the next run", async () => {
  // 文字起こしが分析を始めてよい時間（実行の開始から30秒）を過ぎて終わった場合は、分析を始めない。
  const { m, load, run, add } = setup({ transcribeMs: 40_000 });
  add("m-slow");
  const route = await load();
  const first = await run(route);
  assert.equal(m.rows.get("m-slow").processingStatus, "transcribed");
  assert.equal(m.rows.get("m-slow").meta.transcriptionJob.autoAnalyze, true, "the auto-analysis is kept for the next run");
  assert.deepEqual(m.calls.map(([kind]) => kind), ["transcribe"]);
  assert.equal(first.body.results[0].outcome, "transcribed");
  // 次の実行（5分後）は自動分析待ちとして拾い、分析まで進める。
  m.clock += 300_000;
  m.calls.length = 0;
  const second = await run(route);
  assert.deepEqual(m.calls.map(([kind]) => kind), ["analyze"]);
  assert.equal(m.rows.get("m-slow").processingStatus, "completed");
  assert.equal(second.body.results[0].outcome, "analyzed");
});

test("T04 cron chain: a later record whose transcription ends after the start limit is left for the next run", async () => {
  // 1件目の文字起こし＋分析で30秒を超えたので、2件目は文字起こしまでで止める（時間予算は実行全体で共有）。
  const { m, load, run, add } = setup({ transcribeMs: 10_000, analyzeMs: 30_000 });
  add("m-a");
  add("m-b");
  const route = await load();
  const { body } = await run(route);
  assert.deepEqual(m.calls.map(([kind, id]) => `${kind}:${id}`), ["transcribe:m-a", "analyze:m-a", "transcribe:m-b"]);
  assert.equal(m.rows.get("m-a").processingStatus, "completed");
  assert.equal(m.rows.get("m-b").processingStatus, "transcribed");
  assert.deepEqual(body.results.map(row => row.outcome), ["analyzed", "transcribed"]);
  // 2件目の文字起こしには、実行の残りの予算だけを渡す。
  assert.equal(m.calls[2][2], 230_000 - 40_000);
});

test("T04 cron chain: a record leased by the page is not touched", async () => {
  const { m, load, run, add } = setup();
  const lease = new Date(-10_000);
  add("m-page", { processingStatus: "transcribing", processingStartedAt: lease, meta: { transcriptionJob: { ...doneJob, state: "transcribe", segments: [{ startSec: 0, endSec: 150, status: "pending", attempts: 1 }] } } });
  const before = structuredClone(m.rows.get("m-page"));
  const route = await load();
  const { body } = await run(route);
  assert.deepEqual(m.rows.get("m-page"), before);
  assert.deepEqual(m.calls.map(([kind]) => kind), ["transcribe"]);
  assert.equal(body.results[0].outcome, "leased");
});

test("T04 cron chain: when the page claims the analysis first, the cron does not run it again", async () => {
  // cron が文字起こしを終えて分析の処理権を取ろうとした瞬間に、画面の継続要求が先に取った（分析中・画面の時刻）。
  const { m, load, run, add } = setup();
  const pageClaim = new Date(10_000);
  m.beforeUpdate = (where, data) => {
    if (data.processingStatus !== "analyzing") return;
    m.beforeUpdate = null;
    Object.assign(m.rows.get(where.id), { processingStatus: "analyzing", processingStartedAt: pageClaim, meta: { transcriptionJob: { ...doneJob, autoAnalyze: false } } });
  };
  add("m-race");
  const route = await load();
  const { body } = await run(route);
  assert.deepEqual(m.calls.map(([kind]) => kind), ["transcribe"], "the cron neither runs the analysis nor takes the page's claim");
  assert.equal(m.rows.get("m-race").processingStartedAt.getTime(), pageClaim.getTime());
  assert.equal(m.rows.get("m-race").processingStatus, "analyzing");
  assert.equal(body.results[0].outcome, "analysis_in_flight");
});

test("T04 cron chain: a long transcript accepted for excerpt analysis continues in the same run within the remaining budget", async () => {
  const { m, load, run, add } = setup({ transcribeMs: 10_000, analyzeMs: 1_000, analysisKind: "accepted" });
  add("m-long");
  const route = await load();
  const { body } = await run(route);
  assert.deepEqual(m.calls.map(([kind]) => kind), ["transcribe", "analyze", "long"]);
  // 抜粋の抽出は残りの予算で進め、議事録・BANT の生成を始めるかは長い記録の分析が自分の基準で決める。
  assert.equal(m.calls[2][2], 230_000 - 11_000);
  assert.equal(m.calls[2][3], true);
  assert.deepEqual(body.results[0].steps, ["transcribed", "analysis_accepted", "progressed"]);
});

test("T04 cron chain: a transcription that leaves nothing to analyze keeps the transcribed outcome", async () => {
  // 自動分析の対象でない（ここでは文字起こしが空）記録は、続きの呼出しが idle でも結果を上書きしない。
  const { m, load, run, add } = setup();
  m.afterTranscribed = (row) => { row.transcript = ""; };
  add("m-empty");
  const route = await load();
  const { body } = await run(route);
  assert.deepEqual(m.calls.map(([kind]) => kind), ["transcribe", "transcribe"]);
  assert.equal(m.rows.get("m-empty").processingStatus, "transcribed");
  assert.equal(body.results[0].outcome, "transcribed");
  assert.deepEqual(body.results[0].steps, ["transcribed", "idle"]);
});
