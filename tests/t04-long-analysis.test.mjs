// T04/T22: 長い記録（60〜90分の文字起こし・長い議事録テキスト）の分析。
// 区間ごとに「関係する発言の行番号と原文の一部」を選ばせ、原文と一致した行だけを元の文字どおりに並べた
// 抜粋で、既存の分析（議事録・BANT）を行う。Vertex・DB・パイプラインは模擬し、AI・外部通信は呼ばない。
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
import { LONG_ANALYSIS_PURE_MODULES } from "./helpers/long-analysis-modules.mjs";
import longTranscript from "../src/lib/ai/long-transcript.ts";
import longAnalysisJob from "../src/lib/meetings/long-analysis-job.ts";
import statusPayload from "../src/lib/meetings/status-payload.ts";

const {
  exceedsSinglePassLimit, planLongChunks, splitLongChunk, chunkTurns, extractionPrompt, verifySelections, guardSelections,
  buildCondensedSource, rebuildCondensedSource, turnsJsonBytes, sha256, EXTRACT_RESPONSE_SCHEMA,
  LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES, LONG_ANALYSIS_CHUNK_TURNS_JSON_BYTES, LONG_ANALYSIS_EXTRACT_PROMPT_VERSION,
} = longTranscript;
const { createAnalysisJob, readAnalysisJob, readAnalysisInput, resumeOrCreateAnalysisJob, withAnalysisJob, analysisAttemptLimit } = longAnalysisJob;

const STATUS = "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded',TRANSCRIBING:'transcribing',TRANSCRIBED:'transcribed',ANALYZING:'analyzing',COMPLETED:'completed',ERROR:'error'};";
const VERTEX_INPUT_LIMIT = 65_536;
const byteLength = text => Buffer.byteLength(text, "utf8");
const turnsOf = text => text.split(/\r?\n/u).filter(line => line.trim()).map((line, index) => ({ id: index + 1, text: line }));

/** 約90分の商談を模した架空の文字起こし（各行に番号が入り、どの行も一意）。 */
function longMeeting(lines = 720) {
  const out = [];
  for (let i = 1; i <= lines; i++) out.push(`${i % 2 ? "営業" : "顧客"}：議題${i}について、現在の運用と入力の手間、それから現場での確認手順を順番に説明します。`);
  const set = (index, text) => { if (index < lines) out[index] = text; };
  set(100, "顧客：予算は年間300万円を上限として社内で確保しています。");
  set(101, "営業：承知しました。最終的な判断はどなたが行いますか。");
  set(102, "顧客：はい、部長です。");
  set(300, "顧客：先ほどの11月開始という条件は撤回します。開始時期は未定です。");
  set(500, "営業：では10月末までに見積を提出します。");
  return out.join("\n");
}

function whereMatches(row, where) {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") { if (!value.some(w => whereMatches(row, w))) return false; continue; }
    const actual = row[key];
    if (value === null) { if (actual !== null && actual !== undefined) return false; continue; }
    if (value instanceof Date) { if (!(actual instanceof Date) || actual.getTime() !== value.getTime()) return false; continue; }
    if (typeof value === "object") {
      if ("lt" in value) { if (!(actual instanceof Date) || actual.getTime() >= value.lt.getTime()) return false; continue; }
      throw Error("unsupported where: " + key);
    }
    if (actual !== value) return false;
  }
  return true;
}

// ---------------------------------------------------------------- pure helpers
test("T04 long analysis: 60/90-minute transcripts exceed one analysis call; ordinary meetings keep the single pass", () => {
  assert.equal(exceedsSinglePassLimit(longMeeting(720)), true, "about 90 minutes");
  assert.equal(exceedsSinglePassLimit(longMeeting(480)), true, "about 60 minutes");
  assert.equal(exceedsSinglePassLimit(longMeeting(120)), false, "about 15 minutes");
  assert.equal(exceedsSinglePassLimit("顧客：予算は未定です。"), false);
});

test("T04 long analysis: chunks cover every line once, stay within the chunk budget, and each extraction request fits the Vertex input limit", () => {
  const source = longMeeting(720);
  const chunks = planLongChunks(source);
  const total = turnsOf(source).length;
  assert.ok(chunks.length >= 4, `90 minutes need several chunks (got ${chunks.length})`);
  assert.equal(chunks[0].startId, 1);
  assert.equal(chunks.at(-1).endId, total);
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.index, i);
    if (i) assert.equal(chunk.startId, chunks[i - 1].endId + 1, "contiguous, no overlap or gap");
    const turns = chunkTurns(source, chunk);
    assert.equal(turns.length, chunk.endId - chunk.startId + 1);
    assert.ok(turnsJsonBytes(turns) <= LONG_ANALYSIS_CHUNK_TURNS_JSON_BYTES, `chunk ${i} is ${turnsJsonBytes(turns)} bytes`);
    const prompt = extractionPrompt(turns, chunk, chunks.length);
    const bytes = byteLength(prompt.system + prompt.user) + byteLength(JSON.stringify(EXTRACT_RESPONSE_SCHEMA));
    assert.ok(bytes < VERTEX_INPUT_LIMIT, `extraction request ${i} is ${bytes} bytes`);
    assert.match(prompt.user, new RegExp(`区間 ${i + 1}/${chunks.length}（発言 ${chunk.startId}〜${chunk.endId}）`));
  });
  assert.deepEqual(splitLongChunk({ index: 2, startId: 10, endId: 20 }), [{ index: 2, startId: 10, endId: 15 }, { index: 3, startId: 16, endId: 20 }]);
  assert.equal(splitLongChunk({ index: 0, startId: 7, endId: 7 }), null, "a single line cannot be split");
  // Blank lines (joined transcription segments) are not turns; ids stay the non-empty line numbers.
  assert.deepEqual(chunkTurns("営業：一\n\n顧客：二\n営業：三", { index: 0, startId: 2, endId: 3 }).map(t => t.text), ["顧客：二", "営業：三"]);
});

test("T04 long analysis: only selections whose quote is verbatim in the chosen line are kept; a unique quote relocates a wrong id", () => {
  const turns = [
    { id: 11, text: "顧客：予算は年間300万円を上限としています。" },
    { id: 12, text: "営業：導入時期はいつ頃をお考えですか。" },
    { id: 13, text: "顧客：はい。" },
    { id: 14, text: "顧客：来年4月の稼働を目標にしています。" },
  ];
  const { selections, stats } = verifySelections({ selections: [
    { id: 11, topics: ["budget"], quote: "年間300万円を上限" },
    { id: 11, topics: ["authority", "unknown-topic"], quote: "予算は年間" },
    { id: 12, topics: ["timeline"], quote: "来年4月の稼働を目標" },
    { id: 13, topics: ["need"], quote: "予算を増やしたい" },
    { id: 99, topics: ["need"], quote: "来年4月" },
    { id: 14, topics: ["timeline"], quote: "4月" },
    { id: 12, topics: [], quote: "導入時期はいつ頃" },
  ] }, turns);
  assert.deepEqual(selections, [
    { id: 11, topics: ["budget", "authority"] },
    { id: 12, topics: ["need"] },
    { id: 14, topics: ["timeline"] },
  ]);
  assert.deepEqual(stats, { accepted: 3, relocated: 1, rejected: { invalid_id: 1, not_verbatim: 2, duplicate: 1 } });
  assert.deepEqual(verifySelections(null, turns).selections, []);
  assert.deepEqual(verifySelections({ selections: "x" }, turns).selections, []);
  // More than 80 selections are ignored beyond the cap. The cap is enforced here, not by the response schema:
  // gemini-3.5-flash-lite rejects an array maxItems in the schema with HTTP 400 (seen on Vertex on 2026-09-29).
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, text: `顧客：行${i + 1}の本文です。` }));
  assert.equal(verifySelections({ selections: many.map(t => ({ id: t.id, topics: ["need"], quote: t.text.slice(3) })) }, many).selections.length, 80);
  assert.equal(JSON.stringify(EXTRACT_RESPONSE_SCHEMA).includes("maxItems"), false, "no maxItems in the extraction schema");
});

test("T04 long analysis: the excerpt is original lines only, in order, within budget; withdrawals/uncertainty/deadlines survive trimming", () => {
  const source = longMeeting(720);
  const original = new Set(source.split("\n"));
  const turns = turnsOf(source);
  const chunks = planLongChunks(source);
  const need = turns.filter(t => t.id % 3 === 1).map(t => ({ id: t.id, topics: ["need"] }));
  const guards = guardSelections(source);
  // Must-keep lines (the guards read them) vs generic hint words (kept only when there is room).
  const guardIds = guards.filter(g => g.topics.includes("keep")).map(g => g.id);
  for (const id of [101, 301]) assert.ok(guardIds.includes(id), `line ${id} is a must-keep line`);
  assert.deepEqual(guards.find(g => g.id === 501)?.topics, ["guard"], "a seller's 'までに見積' line is only a hint");

  const condensed = buildCondensedSource(source, [...need, { id: 103, topics: ["authority"] }, ...guards], chunks);
  assert.ok(condensed.condensedTurnsJsonBytes <= LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES);
  assert.equal(condensed.condensedTurnsJsonBytes, turnsJsonBytes(turnsOf(condensed.text)));
  assert.ok(condensed.droppedForBudget > 0, "the budget forced trimming");
  for (const line of condensed.text.split("\n")) assert.ok(line === "" || original.has(line), `not an original line: ${line}`);
  const ids = condensed.sourceLineIds;
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  for (const id of guardIds) assert.ok(ids.includes(id), `guard line ${id} was dropped`);
  assert.ok(ids.includes(102), "the question before a short reply is added as context, with the reply's priority");
  assert.ok(condensed.contextAdded >= 1);
  // Adjacent source lines stay together; a gap becomes one blank line.
  const at = condensed.text.split("\n");
  const question = at.indexOf(turns[101].text);
  assert.equal(at[question + 1], turns[102].text);
  assert.ok(at.every((line, i) => line !== "" || (at[i - 1] !== "" && at[i + 1] !== "")), "no double blank lines");
  assert.equal(at.filter(line => line === "").length, new Set(ids).size - 1 - ids.filter((id, i) => i && id === ids[i - 1] + 1).length);
  // The saved line ids rebuild exactly the same excerpt.
  assert.equal(rebuildCondensedSource(source, ids), condensed.text);
  assert.equal(rebuildCondensedSource(source, [99999]), null);
  // A smaller target keeps the highest-priority lines.
  const tight = buildCondensedSource(source, [...need, ...guards], chunks, 2_000);
  assert.ok(tight.condensedTurnsJsonBytes <= 2_000);
  for (const id of guardIds) assert.ok(tight.sourceLineIds.includes(id), "need lines are dropped before must-keep lines");
  assert.ok(tight.sourceLineIds.length < 20);
  // CRLF and blank lines in the source keep the original line text.
  // The short line 2 also brings line 1 as context; the physical blank line becomes one separator.
  const crlf = "営業：一行目\r\n\r\n顧客：予算は未定です\r\n営業：三行目";
  assert.equal(buildCondensedSource(crlf, [{ id: 2, topics: ["budget"] }, { id: 3, topics: ["need"] }], [{ index: 0, startId: 1, endId: 3 }]).text, "営業：一行目\n\n顧客：予算は未定です\n営業：三行目");
});

test("T04 long analysis job: resume keeps finished chunks of the same text and extraction version; a changed text starts over", () => {
  const source = longMeeting(720);
  const now = new Date("2026-09-28T01:00:00Z");
  const job = createAnalysisJob(source, "transcript", now);
  assert.equal(job.state, "extract");
  assert.equal(job.sourceSha256, sha256(source));
  assert.equal(job.promptVersion, LONG_ANALYSIS_EXTRACT_PROMPT_VERSION);
  assert.ok(job.chunks.every(chunk => chunk.status === "pending" && chunk.attempts === 0));
  assert.equal(analysisAttemptLimit(job), Math.max(4, job.chunks.length * 2));
  const worked = {
    ...job, vertexAttempts: 5, pipelineAttempts: 2, pipelineRuns: 4, targetBytes: 9_000,
    chunks: job.chunks.map((chunk, i) => i === 0 ? { ...chunk, status: "done", attempts: 2, selections: [{ id: 3, topics: ["need"] }] } : i === 1 ? { ...chunk, status: "error", attempts: 3, error: "x" } : chunk),
  };
  const resumed = resumeOrCreateAnalysisJob(readAnalysisJob({ analysisJob: worked }), source, "transcript", now);
  assert.equal(resumed.chunks[0].status, "done");
  assert.deepEqual(resumed.chunks[0].selections, [{ id: 3, topics: ["need"] }]);
  assert.equal(resumed.chunks[1].status, "pending");
  assert.equal(resumed.chunks[1].attempts, 0);
  assert.equal(resumed.chunks[1].error, undefined);
  assert.equal(resumed.vertexAttempts, 2, "only calls that produced kept results are counted");
  assert.equal(resumed.attemptLimit, job.attemptLimit, "the cost cap planned at creation is kept");
  assert.equal(resumed.pipelineAttempts, 0);
  assert.equal(resumed.pipelineRuns, 0);
  assert.equal(resumed.targetBytes, 9_000, "an excerpt already shrunk for the input limit does not restart from the failed size");
  const allDone = resumeOrCreateAnalysisJob({ ...job, chunks: job.chunks.map(chunk => ({ ...chunk, status: "done", attempts: 1 })) }, source, "transcript", now);
  assert.equal(allDone.state, "pipeline");
  assert.ok(resumeOrCreateAnalysisJob(worked, source + "\n顧客：追記", "transcript", now).chunks.every(chunk => chunk.status === "pending"));
  assert.ok(resumeOrCreateAnalysisJob({ ...worked, promptVersion: "old" }, source, "transcript", now).chunks.every(chunk => chunk.status === "pending"));
  // Malformed saved state is ignored rather than trusted.
  for (const bad of [null, {}, { analysisJob: { ...job, version: 2 } }, { analysisJob: { ...job, chunks: [] } }, { analysisJob: { ...job, chunks: [{ startId: 5, endId: 1, status: "pending", attempts: 0 }] } }, { analysisJob: { ...job, state: "done" } }]) {
    assert.equal(readAnalysisJob(bad), null);
  }
  assert.equal(readAnalysisInput({ analysisInput: { version: 1, mode: "condensed", sourceSha256: "x", sourceLineIds: [1, 0] } }), null);
  const meta = { keep: 1 };
  assert.deepEqual(withAnalysisJob(meta, job).keep, 1);
  assert.deepEqual(meta, { keep: 1 }, "meta is not mutated");
  assert.equal("analysisJob" in withAnalysisJob({ analysisJob: job, keep: 1 }, null), false);
});

// ---------------------------------------------------------------- analysis entry (job environment)
const analysisEntry = "src/lib/meetings/analysis.ts";
const longEntry = "src/lib/meetings/long-analysis.ts";
const analysisAllowed = [analysisEntry, "src/lib/meetings/status-payload.ts", "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES];
const analysisBoundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/ai/pipeline": "export const runPipeline=(...a)=>mocks.pipeline(...a);",
  "@/lib/meetings/processing": STATUS,
  "@/lib/feature-flags": "export const isAutoBantFeatureEnabled=()=>false;",
  "@/lib/ai/summarize-bant": "export const scheduleDealBantSummary=async()=>{};",
};
const chainBoundaries = {
  ...analysisBoundaries,
  "@/lib/ai/anthropic": "export const callClaudeHeavyJSON=(...a)=>mocks.extract(...a);",
  "@/lib/ai/vertex-policy": "export class VertexError extends Error{constructor(code,message){super(message);this.code=code;this.name='VertexError'}};export const VERTEX_MAX_OUTPUT=8192;mocks.VertexError=VertexError;",
};

function pipelineResult(label = "抜粋で分析") {
  return { meetingMinutes: { markdown: `## 議事録\n${label}`, json: {}, usedFallback: false }, topSales: { real_intent: "意図", winning_scenario: "仮説" },
    analysis: { issues: [], bant: { budget: "年間300万円", authority: "部長", need: "入力の手間", timeline: "未定" } }, nextActions: { next_actions: [] },
    trace: [], structured: {}, strategy: {}, scores: {}, fallback: false, improved: false };
}

/** 模擬の抽出AI: 区間の発言から、番号が7の倍数の行と予算・判断に関する行を、本文の一部を添えて選ぶ。 */
function fakeExtractor(m, { elapsedMs = 60_000, fail } = {}) {
  return async (opts) => {
    m.extractCalls.push(opts);
    m.clock += elapsedMs;
    const turns = JSON.parse(opts.user.slice(opts.user.indexOf("[")));
    const failure = fail?.(turns, m.extractCalls.length);
    if (failure) throw new m.VertexError(failure, `模擬の失敗: ${failure}`);
    const picked = turns.filter(t => t.id % 7 === 0 || /予算|判断|部長|撤回/.test(t.text));
    return {
      parsed: { selections: [
        ...picked.map(t => ({ id: t.id, topics: /撤回/.test(t.text) ? ["change"] : ["need"], quote: t.text.slice(3, 20) })),
        { id: turns[0].id, topics: ["need"], quote: "要約：顧客は入力の手間を課題としている" },
      ] },
      usage: { promptTokenCount: 5000, candidatesTokenCount: 300, totalTokenCount: 5300 },
    };
  };
}

function chainSetup({ transcript = longMeeting(720), meta = {}, pipeline, processingStatus = "transcribed" } = {}) {
  const row = { id: "meeting", dealId: "deal", minutes: null, transcript, processingStatus, processingStartedAt: null, processingError: null, meta,
    deal: { title: "架空商談", company: { name: "架空企業" }, products: [], nextAction: null, nextActionAt: null, updatedAt: new Date("2026-09-28T00:00:00Z") } };
  const m = { row, env: { LUMA_CLOUD_AI_MODE: "vertex" }, clock: Date.now(), extractCalls: [], pipelineCalls: [], writes: 0 };
  m.pipeline = pipeline ?? (async (text, ctx) => { m.pipelineCalls.push({ text, ctx }); return pipelineResult(); });
  m.prisma = {
    meeting: {
      findUnique: async () => structuredClone(row),
      update: async () => { throw Error("writes must be conditional"); },
      updateMany: async ({ where, data }) => { if (!whereMatches(row, where)) return { count: 0 }; m.writes++; Object.assign(row, structuredClone(data)); return { count: 1 }; },
    },
    aiLog: { findMany: async () => m.edits ?? [], create: async () => ({}) },
    deal: { updateMany: async () => ({ count: 0 }) },
  };
  return m;
}

const loadAnalysis = m => offlineModule(analysisEntry, m, analysisBoundaries, analysisAllowed);
const loadChain = m => offlineModule(longEntry, m, chainBoundaries, [longEntry, ...analysisAllowed]);

async function driveUntilSettled(lib, m, { maxRequests = 30, gapMs = 5_000, options = {} } = {}) {
  const outcomes = [];
  for (let i = 0; i < maxRequests; i++) {
    const result = await lib.advanceLongAnalysis("meeting", { now: () => m.clock, ...options });
    outcomes.push(result.outcome);
    if (!["progressed", "retrying"].includes(result.outcome)) return outcomes;
    m.clock += gapMs;
  }
  throw Error("did not settle: " + outcomes.join(","));
}

test("T04 long analysis end to end: accepted as a job, extracted over several requests, then analyzed from a verbatim excerpt", async () => {
  const transcriptionJob = { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: false };
  const m = chainSetup({ meta: { transcriptionJob, analysisInput: { version: 1, mode: "condensed", promptVersion: "old", sourceField: "transcript", sourceSha256: "stale", sourceLineIds: [1] } } });
  m.edits = [{ input: { minutes: "長".repeat(5000) }, userEdit: { minutes: "編".repeat(5000) } }];
  const analysis = await loadAnalysis(m);
  const accepted = await analysis.runMeetingAnalysis("meeting");
  assert.equal(accepted.kind, "accepted");
  assert.equal(m.row.processingStatus, "analyzing");
  assert.equal(m.row.processingStartedAt, null, "waiting for the continuation");
  assert.equal(m.pipelineCalls.length, 0, "the full transcript is never sent to the pipeline");
  const job = readAnalysisJob(m.row.meta);
  assert.equal(accepted.chunks, job.chunks.length);
  assert.ok(job.chunks.length >= 4);
  assert.deepEqual(m.row.meta.transcriptionJob, transcriptionJob, "other meta is kept");
  // Another click while queued is refused (not stalled), not a second job.
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "in_flight");

  m.extract = fakeExtractor(m);
  const lib = await loadChain(m);
  const outcomes = await driveUntilSettled(lib, m);
  assert.equal(outcomes.at(-1), "analyzed");
  assert.ok(outcomes.filter(o => o === "progressed").length >= Math.ceil(job.chunks.length / 2), "the work is spread over several ~230s requests");
  assert.equal(m.extractCalls.length, job.chunks.length, "one extraction call per chunk");
  for (const call of m.extractCalls) {
    assert.equal(call.feature, "meeting_extract");
    assert.equal(call.json, true);
    assert.equal(call.temperature, 0);
    assert.equal(call.maxTokens, 8192);
    assert.ok(call.responseSchema);
    assert.ok(byteLength(call.system + call.user) + byteLength(JSON.stringify(call.responseSchema)) < VERTEX_INPUT_LIMIT);
  }
  assert.equal(m.pipelineCalls.length, 1);
  const { text, ctx } = m.pipelineCalls[0];
  const originalLines = new Set(m.row.transcript.split("\n"));
  assert.ok(text.length < m.row.transcript.length / 3);
  for (const line of text.split("\n")) assert.ok(line === "" || originalLines.has(line), `not an original line: ${line}`);
  for (const must of ["予算は年間300万円", "最終的な判断はどなたが", "はい、部長です", "条件は撤回します", "10月末までに見積"]) assert.ok(text.includes(must), `excerpt lost: ${must}`);
  assert.ok(!text.includes("要約："), "a paraphrase never enters the excerpt");
  assert.ok(ctx.pastEdits.every(edit => edit.aiOutput.length <= 100 && edit.userEdit.length <= 100), "edit logs are clipped for the excerpt analysis (the 22,000 B budget assumes this)");
  // Lines the fake model chose only through a non-verbatim quote (the first line of each chunk) never enter the excerpt.
  const guardIds = new Set(guardSelections(m.row.transcript).map(guard => guard.id));
  const sourceLines = turnsOf(m.row.transcript);
  const paraphraseOnly = job.chunks.map(chunk => chunk.startId)
    .filter(id => id % 7 !== 0 && !guardIds.has(id) && !/予算|判断|部長|撤回/.test(sourceLines[id - 1].text));
  assert.ok(paraphraseOnly.length > 0);
  for (const id of paraphraseOnly) assert.ok(!m.row.meta.analysisInput.sourceLineIds.includes(id), `line ${id} was selected only by a paraphrase`);

  assert.equal(m.row.processingStatus, "completed");
  assert.equal(m.row.meta.analysisJob, undefined, "the job is cleared on success");
  const input = m.row.meta.analysisInput;
  assert.equal(input.mode, "condensed");
  assert.equal(input.sourceSha256, sha256(m.row.transcript));
  assert.equal(input.originalChars, m.row.transcript.length);
  assert.equal(input.condensedChars, text.length);
  assert.equal(input.chunks, job.chunks.length);
  assert.equal(rebuildCondensedSource(m.row.transcript, input.sourceLineIds), text);
  assert.ok(input.selection.rejected >= job.chunks.length, "every paraphrase was rejected");
  assert.equal("text" in input, false, "the excerpt text itself is not stored");
  assert.deepEqual(m.row.meta.transcriptionJob, transcriptionJob);
  assert.match(m.row.minutes, /抜粋で分析/);

  // Re-running analysis on the same transcript rebuilds the same excerpt without extracting again.
  const rerun = await analysis.runMeetingAnalysis("meeting");
  assert.equal(rerun.ok, true);
  assert.equal(m.extractCalls.length, job.chunks.length);
  assert.equal(m.pipelineCalls.at(-1).text, text);
  assert.deepEqual(m.row.meta.analysisInput.sourceLineIds, input.sourceLineIds);
});

test("T04 long analysis: short meetings in the job environment keep the unchanged single-pass analysis and drop a stale excerpt record", async () => {
  const short = longMeeting(60);
  const m = chainSetup({ transcript: short, meta: { analysisInput: { version: 1, mode: "condensed", promptVersion: LONG_ANALYSIS_EXTRACT_PROMPT_VERSION, sourceField: "transcript", sourceSha256: "other", sourceLineIds: [1] } } });
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).ok, true);
  assert.equal(m.pipelineCalls[0].text, short);
  assert.equal(m.row.meta.analysisInput, undefined);
  assert.equal(m.row.meta.analysisJob, undefined);
});

test("T04 long analysis: a meeting that hits the input limit mid-pipeline switches to the excerpt job, and a retry stays on it", async () => {
  const medium = longMeeting(300);
  assert.equal(exceedsSinglePassLimit(medium), false, "below the up-front check");
  const m = chainSetup({ transcript: medium, pipeline: async () => { m.pipelineCalls.push({}); throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); } });
  const analysis = await loadAnalysis(m);
  const first = await analysis.runMeetingAnalysis("meeting");
  assert.equal(first.kind, "accepted");
  assert.equal(m.pipelineCalls.length, 1);
  assert.equal(m.row.processingStatus, "analyzing");
  assert.equal(m.row.processingStartedAt, null);
  assert.equal(m.row.processingError, null);
  assert.equal(readAnalysisJob(m.row.meta).sourceSha256, sha256(medium));
  // After a failure the user re-runs: the saved job for this text is resumed without another full-text attempt.
  m.row.processingStatus = "error";
  const second = await analysis.runMeetingAnalysis("meeting");
  assert.equal(second.kind, "accepted");
  assert.equal(m.pipelineCalls.length, 1);
});

test("T04 long analysis: the automatic analysis after transcription hands over its claim to the job", async () => {
  const m = chainSetup({ processingStatus: "analyzing" });
  const claimedAt = new Date("2026-09-28T02:00:00Z");
  m.row.processingStartedAt = claimedAt;
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting", { claimedAt: new Date("2026-09-28T02:00:01Z") })).kind, "in_flight", "a lost claim does nothing");
  assert.ok(m.row.processingStartedAt.getTime() === claimedAt.getTime() && !m.row.meta.analysisJob);
  assert.equal((await analysis.runMeetingAnalysis("meeting", { claimedAt })).kind, "accepted");
  assert.equal(m.row.processingStartedAt, null);
  assert.ok(readAnalysisJob(m.row.meta));
});

// ---------------------------------------------------------------- the continuation (extract / pipeline)
function queuedJob(m, patch = {}) {
  const job = createAnalysisJob(m.row.transcript, "transcript", new Date(m.clock));
  m.row.processingStatus = "analyzing";
  m.row.processingStartedAt = null;
  m.row.meta = { ...m.row.meta, analysisJob: { ...job, ...patch } };
  return job;
}

test("T04 long analysis: one continuation at a time — a live lease is respected and an expired one is taken over", async () => {
  const m = chainSetup();
  queuedJob(m);
  m.extract = fakeExtractor(m);
  const lib = await loadChain(m);
  m.row.processingStartedAt = new Date(m.clock - 60_000);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "leased");
  assert.equal(m.extractCalls.length, 0);
  m.row.processingStartedAt = new Date(m.clock - 291_000);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "progressed");
  assert.equal(m.extractCalls.length, 2, "two 60s extraction calls fit one 230s request");
  assert.equal(m.row.processingStartedAt, null, "the lease is released for the next continuation");
  assert.equal(readAnalysisJob(m.row.meta).chunks.filter(chunk => chunk.status === "done").length, 2);
  // Not analyzing, or no job: nothing to do.
  m.row.processingStatus = "completed";
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "idle");
});

test("T04 long analysis: a chunk whose selections hit the output limit is split in half and retried", async () => {
  const m = chainSetup();
  const job = queuedJob(m);
  m.extract = fakeExtractor(m, { elapsedMs: 10_000, fail: (_turns, call) => call === 1 ? "incomplete" : null });
  const lib = await loadChain(m);
  await lib.advanceLongAnalysis("meeting", { now: () => m.clock });
  const saved = readAnalysisJob(m.row.meta);
  assert.equal(saved.chunks.length, job.chunks.length + 1);
  assert.equal(saved.chunks[0].startId, job.chunks[0].startId);
  assert.equal(saved.chunks[1].endId, job.chunks[0].endId);
  assert.equal(saved.chunks[1].startId, saved.chunks[0].endId + 1);
  assert.ok(saved.chunks.every((chunk, i) => chunk.index === i));
  assert.equal(saved.chunks[0].status, "done");
  assert.equal(saved.vertexAttempts, m.extractCalls.length, "the failed call still counts toward the cost cap");
  assert.equal(saved.attemptLimit, job.attemptLimit, "splitting does not raise the cost cap");
});

test("T04 long analysis: transient failures retry the same chunk up to 3 times, then stop with a resumable message", async () => {
  const m = chainSetup();
  queuedJob(m);
  m.extract = fakeExtractor(m, { elapsedMs: 10_000, fail: turns => turns[0].id > 1 ? "timeout" : null });
  const lib = await loadChain(m);
  const outcomes = await driveUntilSettled(lib, m);
  assert.deepEqual(outcomes, ["retrying", "retrying", "error"]);
  assert.equal(m.row.processingStatus, "error");
  assert.match(m.row.processingError, /^区間2\/\d+（発言\d+〜\d+）の発言の抽出に失敗しました: 模擬の失敗: timeout 抽出済みの区間は保存済みです。「分析を実行」で失敗した区間から再開します。$/);
  const failed = readAnalysisJob(m.row.meta);
  assert.equal(failed.chunks[0].status, "done");
  assert.equal(failed.chunks[1].status, "error");
  assert.equal(failed.chunks[1].attempts, 3);
  const firstSelections = failed.chunks[0].selections;

  // 「分析を実行」: the finished chunk is kept, the failed one starts over.
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  const resumed = readAnalysisJob(m.row.meta);
  assert.equal(resumed.chunks[0].status, "done");
  assert.deepEqual(resumed.chunks[0].selections, firstSelections);
  assert.equal(resumed.chunks[1].status, "pending");
  assert.equal(resumed.chunks[1].attempts, 0);
  const callsBefore = m.extractCalls.length;
  m.extract = fakeExtractor(m, { elapsedMs: 10_000 });
  await lib.advanceLongAnalysis("meeting", { now: () => m.clock });
  assert.ok(m.extractCalls.slice(callsBefore).every(call => !call.user.includes(`（発言 1〜`)), "the finished chunk is not extracted again");
});

test("T04 long analysis: the cost cap, a non-retryable error and a changed source stop the job without further AI calls", async () => {
  {
    const m = chainSetup();
    const job = queuedJob(m);
    m.row.meta.analysisJob.vertexAttempts = analysisAttemptLimit(job);
    m.extract = fakeExtractor(m);
    const lib = await loadChain(m);
    assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
    assert.match(m.row.processingError, /費用保護のため停止しました/);
    assert.equal(m.extractCalls.length, 0);
  }
  {
    const m = chainSetup();
    queuedJob(m);
    m.extract = fakeExtractor(m, { fail: () => "budget_exhausted" });
    const lib = await loadChain(m);
    assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
    assert.equal(m.extractCalls.length, 1, "no retry for a non-transient error");
    assert.match(m.row.processingError, /区間1\/\d+/);
  }
  {
    const m = chainSetup();
    queuedJob(m);
    m.row.transcript += "\n顧客：あとから追記した発言です。";
    m.extract = fakeExtractor(m);
    const lib = await loadChain(m);
    assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
    assert.match(m.row.processingError, /変更されました/);
    assert.equal(m.extractCalls.length, 0);
  }
});

test("T04 long analysis: the pipeline starts only with enough time left, and an excerpt still over the limit is rebuilt smaller twice", async () => {
  const m = chainSetup({ pipeline: async (text) => { m.pipelineCalls.push({ text }); throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); } });
  const job = queuedJob(m);
  m.extract = fakeExtractor(m, { elapsedMs: 10_000 });
  const lib = await loadChain(m);
  // All chunks are extracted in one request; less than 200s is left afterwards, so the pipeline waits for the next one.
  assert.ok(job.chunks.length <= 9);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "progressed");
  assert.equal(m.extractCalls.length, job.chunks.length);
  assert.equal(readAnalysisJob(m.row.meta).state, "pipeline");
  // A cron run started late in its window does not start the pipeline.
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock, allowPipeline: false })).outcome, "idle");
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock, budgetMs: 150_000 })).outcome, "idle");
  assert.equal(m.row.processingStartedAt, null, "idle does not take the lease");

  const outcomes = await driveUntilSettled(lib, m);
  assert.deepEqual(outcomes, ["retrying", "retrying", "analysis_failed"]);
  const sizes = m.pipelineCalls.map(call => turnsJsonBytes(turnsOf(call.text)));
  assert.equal(sizes.length, 3);
  // Each rebuild shrinks from the excerpt's actual size, not only from the nominal target.
  assert.ok(sizes[0] <= 22_000 && sizes[1] <= Math.floor(sizes[0] * 0.75) && sizes[2] <= Math.floor(sizes[1] * 0.75), sizes.join(","));
  assert.equal(m.row.processingStatus, "error");
  const canShrinkFurther = Math.floor(sizes[2] * 0.75) >= 8_000;
  assert.match(m.row.processingError, canShrinkFurther ? /抜粋を小さくしても.*さらに小さい抜粋で再試行します/ : /これ以上抜粋を小さくできず/);
  assert.doesNotMatch(m.row.processingError, /分割して要約する等/);
  assert.equal(m.extractCalls.length, job.chunks.length, "rebuilding the excerpt needs no new extraction");
});

// ---------------------------------------------------------------- continuation branch, status, route
test("T04 long analysis: the continuation routes an analyzing job to the long analysis and reports an accepted auto-analysis", async () => {
  const entry = "src/lib/meetings/transcription-continue.ts";
  const job = createAnalysisJob(longMeeting(720), "transcript", new Date());
  const m = { advanced: [], row: { processingStatus: "analyzing", transcript: "本文", meta: { analysisJob: job } } };
  m.prisma = { meeting: { findUnique: async () => structuredClone(m.row), updateMany: async ({ data }) => { Object.assign(m.row, structuredClone(data)); return { count: 1 }; } } };
  const lib = await offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/meetings/analysis": "export const runMeetingAnalysis=async()=>({ok:false,kind:'accepted',chunks:6});",
    "@/lib/meetings/processing": STATUS,
    "./transcription-runner": "export const TRANSCRIPTION_REQUEST_BUDGET_MS=230000;export const advanceMeetingTranscription=async()=>{mocks.transcriptionAdvances=(mocks.transcriptionAdvances??0)+1;return {outcome:'idle'}};",
    "./long-analysis": "export const advanceLongAnalysis=async(id,o)=>{mocks.advanced.push([id,o]);return {outcome:'progressed'}};",
  }, [entry, "src/lib/meetings/transcription-job.ts", "src/lib/meetings/timed-transcript.ts", ...LONG_ANALYSIS_PURE_MODULES]);
  assert.equal((await lib.continueMeetingProcessing("meeting-1", { budgetMs: 100_000, allowAnalysis: false })).outcome, "progressed");
  assert.equal(JSON.stringify(m.advanced), JSON.stringify([["meeting-1", { budgetMs: 100_000, allowPipeline: false }]]));
  // A plain analyzing meeting (single-pass analysis in another request) is not continued here.
  m.row.meta = {};
  await lib.continueMeetingProcessing("meeting-1");
  assert.equal(m.advanced.length, 1);
  assert.equal(m.transcriptionAdvances, 1);
  // The automatic analysis after transcription is accepted as a long-analysis job.
  m.row = { processingStatus: "transcribed", transcript: "本文", meta: { transcriptionJob: { version: 1, state: "done", mode: "segmented", segments: [{ startSec: 0, endSec: 600, status: "done", attempts: 1 }], autoAnalyze: true } } };
  assert.equal((await lib.continueMeetingProcessing("meeting-1")).outcome, "analysis_accepted");
});

test("T04 long analysis: the status payload shows extraction progress and the excerpt summary, never the line ids or text", () => {
  const job = createAnalysisJob(longMeeting(720), "transcript", new Date());
  job.chunks[0].status = "done";
  const base = { id: "meeting", processingError: null, durationSec: null, audioSizeBytes: null, processingCompletedAt: null, transcript: "本文", minutes: null, summary: null, recordingUrl: null };
  const previous = process.env.LUMA_CLOUD_AI_MODE;
  process.env.LUMA_CLOUD_AI_MODE = "vertex";
  let analyzing;
  try {
    analyzing = statusPayload.meetingStatusPayload({ ...base, processingStatus: "analyzing", processingStartedAt: null, meta: { analysisJob: job } });
  } finally {
    if (previous === undefined) delete process.env.LUMA_CLOUD_AI_MODE; else process.env.LUMA_CLOUD_AI_MODE = previous;
  }
  assert.deepEqual(analyzing.analysis, { mode: "long", state: "extract", completed: 1, total: job.chunks.length, waiting: true });
  assert.equal(analyzing.analysisStalled, false, "a queued job (no lease) is not reported as stalled");
  // Without the job environment nothing continues a queued job: no progress, and 分析を実行 is offered again.
  const off = statusPayload.meetingStatusPayload({ ...base, processingStatus: "analyzing", processingStartedAt: null, meta: { analysisJob: job } });
  assert.equal(off.analysis, null);
  assert.equal(off.analysisStalled, true);
  const input = { version: 1, mode: "condensed", promptVersion: LONG_ANALYSIS_EXTRACT_PROMPT_VERSION, sourceField: "transcript", sourceSha256: "x", originalChars: 32000, condensedChars: 5200, condensedTurnsJsonBytes: 19000, chunks: 6, sourceLineIds: [1, 2, 3], selection: {}, completedAt: "2026-09-28T00:00:00.000Z" };
  const done = statusPayload.meetingStatusPayload({ ...base, processingStatus: "completed", processingStartedAt: new Date(), meta: { analysisJob: job, analysisInput: input } });
  assert.equal(done.analysis, null, "no progress once the meeting is no longer analyzing");
  assert.deepEqual(done.analysisInput, { originalChars: 32000, condensedChars: 5200, chunks: 6, omitted: 0, mustKeepMissing: 0 });
  const payloadOf = selection => statusPayload.meetingStatusPayload({ ...base, processingStatus: "completed", processingStartedAt: new Date(), meta: { analysisInput: { ...input, selection } } }).analysisInput;
  // Hint words dropped for size do not count as dropped AI picks; must-keep lines lost to a too-long line are reported separately.
  assert.deepEqual([payloadOf({ droppedForBudget: 90, skippedLongLines: 1, aiDropped: 0, mustKeepMissing: 0 }).omitted, payloadOf({ aiDropped: 2, mustKeepMissing: 1 }).mustKeepMissing], [0, 1]);
  assert.equal(payloadOf({ droppedForBudget: 3, skippedLongLines: 1 }).omitted, 4, "older records fall back to the previous count");
  assert.doesNotMatch(JSON.stringify(done), /sourceLineIds|selections/);
});

test("T04 long analysis: the analyze API answers 202 for an accepted long-analysis job", async () => {
  const entry = "src/app/api/meetings/[id]/analyze/route.ts";
  const m = { session: { userId: "u" }, prisma: { user: { findUnique: async () => ({ permission: "user" }) } } };
  const route = await offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='user';",
    "@/lib/meetings/analysis": "export const runMeetingAnalysis=async()=>({ok:false,kind:'accepted',chunks:6});",
  });
  const response = await route.POST(new Request("http://offline.invalid", { method: "POST" }), { params: Promise.resolve({ id: "meeting" }) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true, mode: "long_analysis", processingStatus: "analyzing", chunks: 6 });
});

// ---------------------------------------------------------------- review follow-ups (state, limits, tests)
function pipelineJob(m, patch = {}, dense = false) {
  const job = queuedJob(m);
  // dense: the model picked every other line, so the excerpt fills its target.
  const selectionsOf = chunk => dense
    ? Array.from({ length: chunk.endId - chunk.startId + 1 }, (_, i) => chunk.startId + i).filter(id => id % 2).map(id => ({ id, topics: ["need"] }))
    : [{ id: chunk.startId + 6, topics: ["need"] }];
  const done = { ...job, state: "pipeline", chunks: job.chunks.map(chunk => ({ ...chunk, status: "done", attempts: 1, selections: selectionsOf(chunk) })), ...patch };
  m.row.meta = { ...m.row.meta, analysisJob: done };
  return done;
}

test("T04 long analysis: a running pipeline keeps its 12-minute lease; only an older one is taken over", async () => {
  const m = chainSetup();
  pipelineJob(m);
  const lib = await loadChain(m);
  m.row.processingStartedAt = new Date(m.clock - 5 * 60_000);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "leased");
  assert.equal(m.pipelineCalls.length, 0);
  m.row.processingStartedAt = new Date(m.clock - 12 * 60_000 - 1_000);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "analyzed");
  assert.equal(m.pipelineCalls.length, 1);
});

test("T04 long analysis: a pipeline started too many times (e.g. cut off at 300 s each time) stops instead of spending again", async () => {
  const m = chainSetup();
  pipelineJob(m, { pipelineRuns: 4 });
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
  assert.match(m.row.processingError, /4回始めましたが、時間内に完了しませんでした/);
  assert.equal(m.pipelineCalls.length, 0);
  // Each start is saved before the pipeline runs, so a request that is cut off still counts.
  const n = chainSetup({ pipeline: async () => { throw Object.assign(new Error("cut off"), { name: "Cutoff" }); } });
  pipelineJob(n);
  const chain = await loadChain(n);
  await chain.advanceLongAnalysis("meeting", { now: () => n.clock });
  assert.equal(readAnalysisJob(n.row.meta).pipelineRuns, 1);
});

test("T04 long analysis: a saved excerpt is reused only for the same text, source field and extraction version", async () => {
  const transcript = longMeeting(720);
  for (const change of [{ promptVersion: "old" }, { sourceField: "minutes" }]) {
    const input = { version: 1, mode: "condensed", promptVersion: LONG_ANALYSIS_EXTRACT_PROMPT_VERSION, sourceField: "transcript", sourceSha256: sha256(transcript), sourceLineIds: [1, 2, 3], selectedUnits: [[1, 3]], ...change };
    const m = chainSetup({ transcript, meta: { analysisInput: input } });
    const analysis = await loadAnalysis(m);
    assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted", JSON.stringify(change));
    assert.equal(m.pipelineCalls.length, 0);
    assert.ok(readAnalysisJob(m.row.meta));
  }
});

test("T04 long analysis: a network failure while reserving (TypeError fetch failed, timeouts) is retried like other transient errors", async () => {
  const m = chainSetup();
  queuedJob(m);
  let calls = 0;
  m.extract = async () => { calls++; m.clock += 10_000; throw new TypeError("fetch failed"); };
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "retrying");
  assert.equal(m.row.processingStatus, "analyzing");
  assert.equal(readAnalysisJob(m.row.meta).chunks[0].attempts, 1);
  m.extract = async () => { m.clock += 10_000; throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "retrying");
  const aborted = chainSetup();
  queuedJob(aborted);
  aborted.extract = async () => { aborted.clock += 10_000; throw Object.assign(new Error("aborted"), { name: "AbortError" }); };
  const abortLib = await loadChain(aborted);
  assert.equal((await abortLib.advanceLongAnalysis("meeting", { now: () => aborted.clock })).outcome, "retrying");
  assert.equal(aborted.row.processingStatus, "analyzing");
  assert.equal(calls, 1);
});

test("T04 long analysis: a job left from an older text is removed when a normal analysis starts, so nobody mistakes it for a long job", async () => {
  const short = longMeeting(60);
  const m = chainSetup({ transcript: short, processingStatus: "error" });
  m.row.meta = { analysisJob: createAnalysisJob(longMeeting(720), "transcript", new Date()), keep: 1 };
  let payloadDuring = null;
  m.pipeline = async (text) => {
    m.pipelineCalls.push({ text });
    const previous = process.env.LUMA_CLOUD_AI_MODE;
    process.env.LUMA_CLOUD_AI_MODE = "vertex";
    try {
      payloadDuring = statusPayload.meetingStatusPayload({ ...m.row, durationSec: null, audioSizeBytes: null, processingCompletedAt: null, summary: null, recordingUrl: null });
    } finally {
      if (previous === undefined) delete process.env.LUMA_CLOUD_AI_MODE; else process.env.LUMA_CLOUD_AI_MODE = previous;
    }
    return pipelineResult();
  };
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).ok, true);
  assert.equal(m.pipelineCalls[0].text, short);
  assert.equal(payloadDuring.analysis, null, "no long-analysis progress while the single pass runs");
  assert.equal(m.row.meta.analysisJob, undefined);
  assert.equal(m.row.meta.keep, 1);
});

test("T04 long analysis: a re-analysis from the saved excerpt that hits the input limit is rebuilt smaller from the saved selections, without extracting again", async () => {
  const m = chainSetup();
  m.edits = [];
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  m.extract = fakeExtractor(m);
  const lib = await loadChain(m);
  assert.equal((await driveUntilSettled(lib, m)).at(-1), "analyzed");
  const extractCalls = m.extractCalls.length;
  const firstBytes = turnsJsonBytes(turnsOf(m.pipelineCalls[0].text));
  // Later the prompt grows (e.g. more edit logs): the same excerpt no longer fits once.
  let failOnce = true;
  m.pipeline = async (text) => {
    m.pipelineCalls.push({ text });
    if (failOnce) { failOnce = false; throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); }
    return pipelineResult("縮めた抜粋で再分析");
  };
  const rerun = await analysis.runMeetingAnalysis("meeting");
  assert.equal(rerun.kind, "accepted", "queued as a smaller excerpt instead of a terminal error");
  assert.equal(m.row.processingStatus, "analyzing");
  assert.equal(m.row.processingError, null);
  assert.equal(readAnalysisJob(m.row.meta).state, "pipeline");
  assert.equal((await driveUntilSettled(lib, m)).at(-1), "analyzed");
  assert.equal(m.extractCalls.length, extractCalls, "no new extraction");
  const smallerBytes = turnsJsonBytes(turnsOf(m.pipelineCalls.at(-1).text));
  assert.ok(smallerBytes <= Math.floor(firstBytes * 0.75), `${smallerBytes} vs ${firstBytes}`);
  assert.equal(m.row.processingStatus, "completed");
  assert.match(m.row.minutes ?? m.row.summary ?? "", /./);
});

test("T04 long analysis: when the excerpt cannot shrink further the error says what was tried, and a re-run starts from the smaller size", async () => {
  const n = chainSetup({ pipeline: async (text) => { n.pipelineCalls.push({ text }); throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); } });
  pipelineJob(n, { targetBytes: 20_000, pipelineAttempts: 2 }, true);
  const chain = await loadChain(n);
  assert.equal((await chain.advanceLongAnalysis("meeting", { now: () => n.clock })).outcome, "analysis_failed");
  const actual = turnsJsonBytes(turnsOf(n.pipelineCalls[0].text));
  assert.ok(actual > 19_000, "the excerpt filled its target");
  const next = Math.floor(Math.min(20_000, actual) * 0.75);
  assert.match(n.row.processingError, /「分析を実行」を押すと、さらに小さい抜粋で再試行します/);
  assert.equal(readAnalysisJob(n.row.meta).targetBytes, next);
  // 分析を実行: the job is resumed (no extraction) from the smaller size.
  const analysis = await loadAnalysis(n);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  const resumed = readAnalysisJob(n.row.meta);
  assert.equal(resumed.state, "pipeline");
  assert.equal(resumed.targetBytes, next);
  assert.equal(resumed.pipelineAttempts, 0);
  // At the floor (8,500 B × 0.75 < 8,000 B) the message no longer suggests a retry and the size is kept.
  const o = chainSetup({ pipeline: async () => { throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); } });
  pipelineJob(o, { targetBytes: 8_500 }, true);
  const floor = await loadChain(o);
  assert.equal((await floor.advanceLongAnalysis("meeting", { now: () => o.clock })).outcome, "analysis_failed");
  assert.match(o.row.processingError, /これ以上抜粋を小さくできず/);
  assert.equal(readAnalysisJob(o.row.meta).targetBytes, 8_500);
});

test("T04 long analysis: a continuation that read the job just before another released it continues from the fresh state", async () => {
  const m = chainSetup();
  const job = queuedJob(m);
  m.extract = fakeExtractor(m);
  const lib = await loadChain(m);
  // Another continuation finished chunk 1 and released the lease between our read and our claim.
  const stale = structuredClone(m.row);
  const fresh = { ...job, chunks: job.chunks.map((chunk, i) => i === 0 ? { ...chunk, status: "done", attempts: 1, selections: [{ id: 7, topics: ["need"] }] } : chunk), vertexAttempts: 1 };
  m.row.meta = { ...m.row.meta, analysisJob: fresh };
  let reads = 0;
  const findUnique = m.prisma.meeting.findUnique;
  m.prisma.meeting.findUnique = async (args) => (reads++ === 0 ? structuredClone(stale) : findUnique(args));
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "progressed");
  assert.ok(m.extractCalls.length > 0 && m.extractCalls[0].user.includes(`区間 2/${job.chunks.length}`), "work continues with chunk 2");
  assert.ok(!m.extractCalls.some(call => call.user.includes("（発言 1〜")), "the finished chunk is not extracted again");
  assert.deepEqual(readAnalysisJob(m.row.meta).chunks[0].selections, [{ id: 7, topics: ["need"] }]);
});

test("T04 long analysis: without the job environment a queued long job can be re-run as a normal analysis", async () => {
  const m = chainSetup({ transcript: longMeeting(720) });
  queuedJob(m);
  m.env = { NODE_ENV: "production" };
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).ok, true);
  assert.equal(m.pipelineCalls[0].text, m.row.transcript, "the full text (no Vertex input limit in this environment)");
  assert.equal(m.row.meta.analysisJob, undefined);
});

test("T04 long analysis: a record beyond the long-analysis limit is refused before any AI call", async () => {
  const huge = Array.from({ length: 2_400 }, (_, i) => `${i % 2 ? "営業" : "顧客"}：議題${i}について、現在の運用と入力の手間、それから現場での確認手順を順番に説明します。`).join("\n");
  const m = chainSetup({ transcript: huge });
  const analysis = await loadAnalysis(m);
  const result = await analysis.runMeetingAnalysis("meeting");
  assert.equal(result.kind, "failed");
  assert.equal(m.row.processingStatus, "error");
  assert.match(m.row.processingError, /記録を分けて登録してください/);
  assert.equal(readAnalysisJob(m.row.meta), null);
  assert.equal(m.pipelineCalls.length, 0);
});

test("T04 long analysis: after the 4-start stop, 分析を実行 resets the counter and the next continuation analyzes", async () => {
  const m = chainSetup();
  pipelineJob(m, { pipelineRuns: 4 });
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  assert.equal(readAnalysisJob(m.row.meta).pipelineRuns, 0);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "analyzed");
  assert.equal(m.pipelineCalls.length, 1);
});

test("T04 long analysis: after the cost cap stops extraction, 分析を実行 gets a fresh budget for the unfinished chunks", async () => {
  const m = chainSetup();
  const job = queuedJob(m);
  // Every finished chunk needed 3 attempts (Vertex was struggling), which used up the whole planned budget.
  const finished = Math.floor(job.attemptLimit / 3);
  m.row.meta.analysisJob = {
    ...job, vertexAttempts: finished * 3,
    chunks: job.chunks.map((chunk, i) => i < finished ? { ...chunk, status: "done", attempts: 3, selections: [{ id: chunk.startId + 6, topics: ["need"] }] } : chunk),
  };
  m.extract = fakeExtractor(m, { elapsedMs: 10_000 });
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
  assert.match(m.row.processingError, /費用保護のため停止しました/);
  assert.equal(m.extractCalls.length, 0);
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  const resumed = readAnalysisJob(m.row.meta);
  assert.ok(resumed.attemptLimit > resumed.vertexAttempts, "room for the unfinished chunks");
  await lib.advanceLongAnalysis("meeting", { now: () => m.clock });
  assert.ok(m.extractCalls.length > 0, "extraction resumes instead of stopping again");
});

test("T04 long analysis: the automatic analysis (pre-claimed) also removes a job left from an older text", async () => {
  const short = longMeeting(60);
  const claimedAt = new Date("2026-09-28T03:00:00Z");
  const m = chainSetup({ transcript: short, processingStatus: "analyzing" });
  m.row.processingStartedAt = claimedAt;
  m.row.meta = { analysisJob: createAnalysisJob(longMeeting(720), "transcript", new Date()) };
  let during = null;
  m.pipeline = async (text) => {
    m.pipelineCalls.push({ text });
    const previous = process.env.LUMA_CLOUD_AI_MODE;
    process.env.LUMA_CLOUD_AI_MODE = "vertex";
    try {
      during = statusPayload.meetingStatusPayload({ ...m.row, durationSec: null, audioSizeBytes: null, processingCompletedAt: null, summary: null, recordingUrl: null });
    } finally {
      if (previous === undefined) delete process.env.LUMA_CLOUD_AI_MODE; else process.env.LUMA_CLOUD_AI_MODE = previous;
    }
    return pipelineResult();
  };
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting", { claimedAt })).ok, true);
  assert.equal(during.analysis, null);
  assert.equal(m.row.meta.analysisJob, undefined);
  assert.equal(m.pipelineCalls[0].text, short);
});

test("T04 long analysis: rebuilding a smaller excerpt from saved selections keeps their priorities", () => {
  const source = longMeeting(720);
  const lines = turnsOf(source);
  const budgetLine = 400; // a line without guard words, picked by the model as budget
  const selections = lines.filter(line => line.id % 2).map(line => ({ id: line.id, topics: ["need"] }));
  selections.push({ id: budgetLine, topics: ["budget"] });
  const chunks = planLongChunks(source);
  const first = buildCondensedSource(source, selections, chunks);
  const input = { version: 1, mode: "condensed", promptVersion: LONG_ANALYSIS_EXTRACT_PROMPT_VERSION, sourceField: "transcript", sourceSha256: sha256(source),
    originalChars: source.length, condensedChars: first.text.length, condensedTurnsJsonBytes: first.condensedTurnsJsonBytes, chunks: chunks.length,
    sourceLineIds: first.sourceLineIds, selectedUnits: first.selectedUnits, selection: {}, completedAt: "2026-09-28T00:00:00.000Z" };
  const job = longAnalysisJob.analysisJobFromInput(source, input, 8_000, new Date());
  const smaller = buildCondensedSource(source, job.chunks.flatMap(chunk => chunk.selections), job.chunks, job.targetBytes);
  assert.ok(smaller.condensedTurnsJsonBytes <= 8_000);
  assert.ok(smaller.sourceLineIds.includes(budgetLine), "the saved budget pick outranks the saved need picks");
  assert.ok(smaller.droppedForBudget > 0);
});

test("T04 long analysis: when the must-keep lines alone exceed the excerpt budget, the record is refused before any extraction", async () => {
  const lines = Array.from({ length: 700 }, (_, i) => i % 2
    ? `営業：第${i}の論点を承知しました。`
    : `顧客：第${i}の論点の予算と導入時期は、社内でもまだ未定です。`);
  const m = chainSetup({ transcript: lines.join("\n") });
  const analysis = await loadAnalysis(m);
  const result = await analysis.runMeetingAnalysis("meeting");
  assert.equal(result.kind, "failed");
  assert.match(m.row.processingError, /必ず残す発言だけで長い記録の分析の上限を超える/);
  assert.equal(readAnalysisJob(m.row.meta), null);
  assert.equal(m.pipelineCalls.length, 0);
});

test("T04 long analysis: an excerpt that cannot shrink further is marked stopped, and 分析を実行 answers without calling AI", async () => {
  const m = chainSetup({ pipeline: async (text) => { m.pipelineCalls.push({ text }); throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); } });
  pipelineJob(m, { targetBytes: 8_500 }, true);
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "analysis_failed");
  assert.equal(readAnalysisJob(m.row.meta).stopped, "input_limit");
  const calls = m.pipelineCalls.length;
  const analysis = await loadAnalysis(m);
  const rerun = await analysis.runMeetingAnalysis("meeting");
  assert.equal(rerun.kind, "failed");
  assert.match(m.row.processingError, /この状態では再実行しても同じ結果になります/);
  assert.equal(m.pipelineCalls.length, calls, "no pipeline call");
  // Editing the text starts over: a stopped job of another text is not reused.
  m.row.transcript += "\n顧客：追記です。";
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
});

test("T04 long analysis: the next excerpt size shrinks from the actual size, never below the must-keep lines, and stops when it cannot shrink", () => {
  const { nextExcerptTarget } = longAnalysisJob;
  assert.deepEqual(nextExcerptTarget(22_000, 20_000, 0), { next: 15_000, canShrink: true });
  assert.deepEqual(nextExcerptTarget(22_000, 11_000, 0), { next: 8_250, canShrink: true }, "from the actual size, not the nominal target");
  assert.deepEqual(nextExcerptTarget(22_000, 20_000, 17_000), { next: 17_000, canShrink: true }, "down to the must-keep lines");
  assert.equal(nextExcerptTarget(22_000, 20_000, 19_500).canShrink, false, "barely smaller is not worth another run");
  assert.equal(nextExcerptTarget(22_000, 9_000, 0).canShrink, false, "below 8,000 B");
});

test("T04 long analysis: a pipeline start is counted even when building the excerpt fails", async () => {
  const m = chainSetup();
  pipelineJob(m);
  // A malformed saved selection makes building the excerpt throw.
  m.row.meta.analysisJob.chunks[0].selections = [{ id: 1, topics: 5 }];
  const lib = await loadChain(m);
  assert.equal((await lib.advanceLongAnalysis("meeting", { now: () => m.clock })).outcome, "error");
  assert.equal(readAnalysisJob(m.row.meta).pipelineRuns, 1);
});

test("T04 long analysis: a saved excerpt that cannot shrink is marked stopped, so the next click does not rerun the same pipeline", async () => {
  const m = chainSetup();
  const analysis = await loadAnalysis(m);
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "accepted");
  m.extract = fakeExtractor(m);
  const lib = await loadChain(m);
  assert.equal((await driveUntilSettled(lib, m)).at(-1), "analyzed");
  // Pretend the saved excerpt is already at the floor: it cannot be rebuilt smaller.
  m.row.meta.analysisInput = { ...m.row.meta.analysisInput, condensedTurnsJsonBytes: 9_000 };
  m.pipeline = async (text) => { m.pipelineCalls.push({ text }); throw Object.assign(new Error("今回のAI検証では入力が長すぎます。"), { code: "input_limit" }); };
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "failed");
  assert.equal(readAnalysisJob(m.row.meta).stopped, "input_limit");
  const calls = m.pipelineCalls.length;
  assert.equal((await analysis.runMeetingAnalysis("meeting")).kind, "failed");
  assert.equal(m.pipelineCalls.length, calls);
});
