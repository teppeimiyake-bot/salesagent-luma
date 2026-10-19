// T22/T04: 32MiB を超える録画の分割アップロード、ffmpeg の起動引数、区間用の Vertex 呼び出し、
// 画面側の送信・継続処理。外部通信・AI・実際の ffmpeg は使わない。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offlineModule } from "./helpers/offline-module.mjs";
import meetingUpload from "../src/components/deals/meeting-upload.ts";

const DEAL = "00000000-0000-4000-8000-000000000001";
const auth = "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>['user','admin'].includes(p);";
const storage = "export const localStoragePath=k=>mocks.localPath(k);";

async function sessionRoutes(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t22-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const m = {
    root, session: { userId: "user-1" }, permission: "user", jobMode: true, tools: true, created: [],
    deal: { deletedAt: null, company: { deletedAt: null } },
    localPath: key => key?.startsWith("/uploads/") ? path.join(root, key.slice("/uploads/".length)) : null,
    ...overrides,
  };
  m.prisma = {
    user: { findUnique: async () => ({ permission: m.permission }) },
    deal: { findUnique: async () => m.deal },
    meeting: {
      create: async ({ data }) => { const row = { id: `meeting-${m.created.length + 1}`, ...data }; m.created.push(row); return row; },
      findUnique: async ({ where }) => m.created.find(row => row.id === where.id) ?? null,
      findFirst: async ({ where }) => m.created.find(row => row.recordingUrl === where.recordingUrl) ?? null,
    },
  };
  const common = { "@/lib/db": "export const prisma=mocks.prisma;", "@/lib/auth": auth, "@/lib/storage": storage };
  const externals = ["next/server", "zod", "node:crypto", "node:fs/promises", "node:path"];
  const init = await offlineModule("src/app/api/meetings/upload-sessions/route.ts", m, {
    ...common,
    "@/lib/meetings/transcription-job": "export const isTranscriptionJobMode=()=>mocks.jobMode;",
    "@/lib/meetings/audio-segments": "export const mediaToolsAvailable=async()=>mocks.tools;",
  }, ["src/app/api/meetings/upload-sessions/route.ts", "src/lib/meetings/upload-formats.ts", "src/lib/meetings/upload-sessions.ts"], externals);
  const partEntry = "src/app/api/meetings/upload-sessions/[uploadId]/parts/[index]/route.ts";
  const part = await offlineModule(partEntry, m, common, [partEntry, "src/lib/meetings/upload-sessions.ts"], externals);
  const completeEntry = "src/app/api/meetings/upload-sessions/[uploadId]/complete/route.ts";
  const complete = await offlineModule(completeEntry, m, { ...common, "@/lib/meetings/processing": "export const MEETING_PROCESSING_STATUS={UPLOADED:'uploaded'};" },
    [completeEntry, "src/lib/meetings/upload-sessions.ts"], externals);
  const json = (body) => new Request("http://offline.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    m,
    start: body => init.POST(json(body)),
    put: (uploadId, index, bytes) => part.PUT(new Request("http://offline.invalid", { method: "PUT", body: bytes }), { params: Promise.resolve({ uploadId, index: String(index) }) }),
    finish: uploadId => complete.POST(new Request("http://offline.invalid", { method: "POST" }), { params: Promise.resolve({ uploadId }) }),
  };
}

test("T22 split upload: 8MiB parts are verified and completed once into a 202 job-mode meeting", async t => {
  const { m, start, put, finish } = await sessionRoutes(t);
  const size = 8 * 1024 * 1024 * 2 + 1234;
  const started = await start({ dealId: DEAL, filename: "商談録画.mp4", size, durationSec: 3120 });
  assert.equal(started.status, 201);
  const { uploadId, partBytes, totalParts } = await started.json();
  assert.equal(partBytes, 8 * 1024 * 1024);
  assert.equal(totalParts, 3);
  assert.equal((await finish(uploadId)).status, 409, "missing parts are reported, no meeting is created");
  assert.equal(m.created.length, 0);
  assert.equal((await put(uploadId, 0, new Uint8Array(100))).status, 400, "wrong size is rejected");
  assert.equal((await put(uploadId, 3, new Uint8Array(1234))).status, 400, "index out of range");
  for (let index = 0; index < totalParts; index++) {
    const bytes = new Uint8Array(index === totalParts - 1 ? 1234 : partBytes).fill(index + 1);
    assert.equal((await put(uploadId, index, bytes)).status, 200);
  }
  assert.equal((await put(uploadId, 2, new Uint8Array(1234).fill(9))).status, 200, "a retried part overwrites");
  const done = await finish(uploadId);
  assert.equal(done.status, 202);
  const body = await done.json();
  assert.equal(body.transcriptionMode, "job");
  assert.equal(body.meeting.recordingUrl, `/uploads/recordings/parts/${uploadId}/manifest.json`);
  assert.equal(body.meeting.audioSizeBytes, size);
  assert.equal(body.meeting.durationSec, 3120);
  assert.equal(body.meeting.processingStatus, "uploaded");
  const again = await finish(uploadId);
  assert.equal(again.status, 202);
  assert.equal((await again.json()).meeting.id, body.meeting.id, "a repeated completion does not create a duplicate");
  assert.equal(m.created.length, 1);
  assert.equal((await put(uploadId, 0, new Uint8Array(partBytes))).status, 409, "completed uploads accept no more parts");
  const files = await readdir(path.join(m.root, `recordings/parts/${uploadId}`));
  assert.deepEqual(files.sort(), ["complete.lock", "manifest.json", "part-00000", "part-00001", "part-00002"]);
  assert.equal((await readFile(path.join(m.root, `recordings/parts/${uploadId}/part-00002`)))[0], 9);
});

test("T22 split upload guards: permission, environment, type, size, deal, other users and expiry", async t => {
  const cases = [
    [{ permission: "viewer" }, { dealId: DEAL, filename: "a.mp4", size: 30e6 }, 403],
    [{ jobMode: false }, { dealId: DEAL, filename: "a.mp4", size: 30e6 }, 409],
    [{ tools: false }, { dealId: DEAL, filename: "a.mp4", size: 30e6 }, 409],
    [{}, { dealId: DEAL, filename: "minutes.docx", size: 30e6 }, 415],
    [{}, { dealId: DEAL, filename: "a.pdf", size: 30e6 }, 415],
    [{}, { dealId: DEAL, filename: "a.mp4", size: 2001 * 1024 * 1024 }, 413],
    [{}, { dealId: "not-a-uuid", filename: "a.mp4", size: 30e6 }, 400],
    [{ deal: null }, { dealId: DEAL, filename: "a.mp4", size: 30e6 }, 404],
  ];
  for (const [overrides, body, status] of cases) {
    const { start } = await sessionRoutes(t, overrides);
    assert.equal((await start(body)).status, status, JSON.stringify({ overrides, body }));
  }
  const { m, start, put, finish } = await sessionRoutes(t);
  const { uploadId } = await (await start({ dealId: DEAL, filename: "a.mov", size: 10 })).json();
  m.session = { userId: "someone-else" };
  assert.equal((await put(uploadId, 0, new Uint8Array(10))).status, 404);
  assert.equal((await finish(uploadId)).status, 404);
  m.session = { userId: "user-1" };
  assert.equal((await put("../../etc", 0, new Uint8Array(10))).status, 404, "path-like upload ids are rejected");
  const manifestPath = path.join(m.root, `recordings/parts/${uploadId}/manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, createdAt: "2026-09-20T00:00:00.000Z" }));
  assert.equal((await put(uploadId, 0, new Uint8Array(10))).status, 410);
});

// ---------------------------------------------------------------- ffmpeg invocation
function fakeChild({ code = 0, stdout = "", stderr = "", hang = false } = {}) {
  const handlers = {};
  const stream = data => ({ on: (event, fn) => { if (event === "data" && data) setTimeout(() => fn(Buffer.from(data)), 0); } });
  const child = {
    stdout: stream(stdout), stderr: stream(stderr), killed: null,
    kill(signal) { child.killed = signal; setTimeout(() => handlers.close?.(null), 0); return true; },
    once(event, fn) { handlers[event] = fn; if (event === "close" && !hang) setTimeout(() => fn(code), 5); return child; },
  };
  return child;
}

async function mediaTools(m) {
  return offlineModule("src/lib/meetings/audio-segments.ts", m, { "node:child_process": "export const spawn=(...a)=>mocks.spawn(...a);" });
}

test("T04 ffmpeg: no shell, first audio track only, mono 16kHz 32kbps MP3, parts via concat, stderr not shown to users", async () => {
  const m = { runs: [], next: [] };
  m.spawn = (command, args, options) => { m.runs.push({ command, args, options }); return fakeChild(m.next.shift()); };
  const lib = await mediaTools(m);
  assert.equal(await lib.mediaToolsAvailable(), true);
  assert.deepEqual(m.runs.map(r => r.command), ["ffmpeg", "ffprobe"]);
  assert.ok(m.runs.every(r => r.options.shell === false));

  await lib.normalizeToSpeechMp3(["/u/a.mp4"], "/u/out.mp3", { extension: "mp4" });
  let args = m.runs.at(-1).args;
  for (const expected of [["-protocol_whitelist", "file"], ["-f", "mov"], ["-i", "/u/a.mp4"], ["-map", "0:a:0"], ["-ac", "1"], ["-ar", "16000"], ["-c:a", "libmp3lame"], ["-b:a", "32k"], ["-threads", "1"]]) {
    const at = args.indexOf(expected[0]);
    assert.ok(at >= 0 && args[at + 1] === expected[1], expected.join(" "));
  }
  assert.ok(args.includes("-vn") && args.includes("-nostdin"));
  // The demuxer is forced before -i so a playlist disguised as media cannot pull in other files.
  assert.ok(args.indexOf("-f") < args.indexOf("-i"));
  await lib.normalizeToSpeechMp3(["/u/p/part-00000", "/u/p/part-00001"], "/u/out.mp3", { extension: "webm" });
  args = m.runs.at(-1).args;
  assert.equal(args[args.indexOf("-i") + 1], "concat:/u/p/part-00000|/u/p/part-00001");
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,concat");
  assert.equal(args[args.indexOf("-f") + 1], "matroska");
  await assert.rejects(lib.normalizeToSpeechMp3(["/u/a|b"], "/u/out.mp3", { extension: "mp4" }), { code: "media_input" });
  await assert.rejects(lib.normalizeToSpeechMp3(["/u/a.m3u8"], "/u/out.mp3", { extension: "m3u8" }), { code: "media_input" });

  m.next.push({ code: 1, stderr: "Stream map '0:a:0' matches no streams. /secret/path" });
  await assert.rejects(lib.normalizeToSpeechMp3(["/u/silent.mp4"], "/u/out.mp3", { extension: "mp4" }), error => {
    assert.equal(error.code, "media_no_audio");
    assert.doesNotMatch(error.message, /secret|matches no streams/);
    return true;
  });
  m.next.push({ code: 0, stdout: "3600.512000\n" });
  assert.equal(await lib.probeDurationSec("/u/out.mp3"), 3600.512);
  args = m.runs.at(-1).args;
  assert.equal(args[args.indexOf("-f") + 1], "mp3");
  m.next.push({ code: 0, stdout: "12.5\n" });
  assert.equal(await lib.probeDurationSec("/u/in.webm", "webm"), 12.5);
  assert.equal(m.runs.at(-1).args[m.runs.at(-1).args.indexOf("-f") + 1], "matroska");
  m.next.push({ code: 0, stdout: "N/A\n" });
  await assert.rejects(lib.probeDurationSec("/u/out.mp3"), { code: "media_duration" });

  await lib.cutSegment("/u/out.mp3", "/u/seg.mp3", 600, 602);
  args = m.runs.at(-1).args;
  assert.deepEqual([...args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)], ["-ss", "600.000", "-t", "602.000"]);
  assert.equal(args[args.indexOf("-c") + 1], "copy");

  const hung = fakeChild({ hang: true });
  m.spawn = () => hung;
  await assert.rejects(lib.normalizeToSpeechMp3(["/u/a.mp4"], "/u/out.mp3", { extension: "mp4", timeoutMs: 20 }), { code: "media_timeout" });
  assert.equal(hung.killed, "SIGKILL");
});

test("T04 ffmpeg missing: availability is false instead of throwing, and is checked again after a minute", async t => {
  const m = { installed: false, spawns: 0 };
  m.spawn = () => {
    m.spawns++;
    if (m.installed) return fakeChild();
    const child = fakeChild({ hang: true });
    return Object.assign(child, { once(event, fn) { if (event === "error") setTimeout(() => fn(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" })), 0); return child; } });
  };
  const lib = await mediaTools(m);
  assert.equal(await lib.mediaToolsAvailable(), false);
  m.installed = true;
  assert.equal(await lib.mediaToolsAvailable(), false, "a failure is cached briefly");
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  t.after(() => { Date.now = realNow; });
  assert.equal(await lib.mediaToolsAvailable(), true, "and re-checked after 60 seconds");
  const spawns = m.spawns;
  assert.equal(await lib.mediaToolsAvailable(), true);
  assert.equal(m.spawns, spawns, "success is cached");
});

// ---------------------------------------------------------------- Vertex segment request
test("T04 Vertex segment request: 8192 output tokens, position and previous tail; single short recordings unchanged", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t04-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "segment.mp3");
  await writeFile(file, Buffer.from("fake mp3"));
  const m = { requests: [] };
  const lib = await offlineModule("src/lib/ai/vertex-audio.ts", m, {
    "./vertex": "export const vertexGenerate=async o=>{mocks.requests.push(o);return {text:'本文',usage:{totalTokenCount:1}}};",
    "./vertex-policy": "export const vertexConfiguration=()=>({model:'gemini-2.5-flash'});export class VertexError extends Error{constructor(c,m){super(m);this.code=c}};export const VERTEX_MAX_OUTPUT=8192;",
  }, ["src/lib/ai/vertex-audio.ts", "src/lib/meetings/timed-transcript.ts"], ["node:fs/promises", "node:path"]);
  await lib.vertexTranscribeWithMetrics(file);
  await lib.vertexTranscribeWithMetrics(file, { segment: { index: 1, total: 9, startSec: 600, endSec: 1210, overlapSec: 10 }, previousTail: "話者1：予算は80万円です。" });
  await lib.vertexTranscribeWithMetrics(file, { segment: { index: 0, total: 9, startSec: 0, endSec: 610, overlapSec: 0 } });
  // A job started by the previous version: the saved previous segment has no times, so its overlap cannot be deduplicated.
  await lib.vertexTranscribeWithMetrics(file, { segment: { index: 1, total: 9, startSec: 600, endSec: 1202, overlapSec: 2, previousTimed: false }, previousTail: "話者1：予算は80万円です。" });
  // The optional completeness retry makes one attempt only (no new reservation on 429).
  await lib.vertexTranscribeWithMetrics(file, { segment: { index: 1, total: 9, startSec: 600, endSec: 1210, overlapSec: 10, previousTimed: true }, maxAttempts: 1 });
  const [single, segment, firstSegment, legacy, retry] = m.requests;
  assert.equal(single.maxTokens, 4096);
  // T04: the direct (unsegmented) request also asks for one utterance per line; evidence grounding reads one line as one utterance.
  assert.match(single.user, /^この音声の文字起こし本文だけを出力してください。/);
  assert.match(single.user, /話者が変わるごと、または発話の区切りごとに改行し、1行に1つの発話を書いてください。/);
  assert.match(single.user, /「話者1: 発話」/);
  assert.equal(segment.maxTokens, 8192);
  assert.equal(segment.system, single.system);
  assert.match(segment.user, /区間2\/9（録音全体の10:00〜20:10）/);
  assert.match(segment.user, /話者1：予算は80万円です。/);
  assert.match(segment.user, /参考文自体は出力しないでください/);
  assert.match(segment.user, /話者の番号をこれに合わせてください/);
  assert.match(segment.user, /1行に1つの発話を書いてください/);
  // Times relative to this audio file, used by the app for overlap removal and the completeness check.
  assert.match(segment.user, /「\[MM:SS\] 話者1: 発話」/);
  assert.match(segment.user, /録音全体の時刻ではなく、この区間の音声の先頭からの経過時間/);
  // The overlap is transcribed as well (the app removes duplicates); the old "do not repeat" instruction is gone.
  assert.match(segment.user, /最初の約10秒は、直前の区間の終わりと重なっています。重なっている部分の発話も省かずに書いてください（重複はアプリ側で取り除きます）。/);
  assert.doesNotMatch(segment.user, /繰り返さないでください/);
  assert.match(segment.user, /区間の最後（この音声の終わり）まで、聞こえた発話をすべて書いてください。途中で書くのをやめたり、省略・要約したりしないでください。/);
  assert.match(segment.user, /同じ話者が続けて話した発話や、短い返事も省かないでください。/);
  assert.doesNotMatch(firstSegment.user, /重なっています/, "the first segment has no previous overlap");
  assert.doesNotMatch(firstSegment.user, /直前の区間の末尾/);
  assert.match(firstSegment.user, /\[MM:SS\]/);
  assert.doesNotMatch(single.user, /MM:SS|重なって|区間/, "the single-call prompt asks for no segment position or times");
  assert.equal(segment.audio.mimeType, "audio/mpeg");
  assert.equal(segment.feature, "transcription");
  assert.match(legacy.user, /直前の区間と重なる冒頭の数秒で同じ発話が聞こえる場合は繰り返さないでください。/);
  assert.doesNotMatch(legacy.user, /省かずに書いてください（重複はアプリ側で取り除きます）/);
  assert.match(legacy.user, /「\[MM:SS\] 話者1: 発話」/, "the new segment is still timed for the next boundary and the completeness check");
  assert.match(legacy.user, /話者の番号をこれに合わせてください/);
  assert.match(retry.user, /省かずに書いてください（重複はアプリ側で取り除きます）/);
  assert.doesNotMatch(retry.user, /繰り返さないでください/);
  assert.deepEqual([single.maxAttempts, segment.maxAttempts, firstSegment.maxAttempts, legacy.maxAttempts, retry.maxAttempts], [undefined, undefined, undefined, undefined, 1]);
  assert.ok(!("maxAttempts" in segment), "normal calls keep vertexGenerate's default");
});

// ---------------------------------------------------------------- browser helpers
function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("T22 browser upload: small files use one POST; over 24MB media is split; unavailable sessions fall back", async t => {
  {
    const calls = stubFetch(t, () => reply(202, { meeting: { id: "m1" }, transcriptionMode: "job" }));
    const result = await meetingUpload.uploadMeetingMedia({ dealId: DEAL, file: new File([new Uint8Array(10)], "short.webm"), durationSec: 30 });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(c => c.url), ["/api/meetings"]);
    assert.equal(calls[0].init.body.get("durationSec"), "30");
  }
  {
    const size = 25 * 1024 * 1024;
    const progress = [];
    const calls = stubFetch(t, (url, init) => {
      if (url === "/api/meetings/upload-sessions") return reply(201, { uploadId: "u-1", partBytes: 8 * 1024 * 1024, totalParts: 4 });
      if (url.includes("/parts/")) return reply(200, { received: Number(url.split("/").pop()) });
      if (url.endsWith("/complete")) return reply(202, { meeting: { id: "m2" }, transcriptionMode: "job" });
      throw Error("unexpected " + url + init.method);
    });
    const result = await meetingUpload.uploadMeetingMedia({ dealId: DEAL, file: new File([new Uint8Array(size)], "meeting.mp4"), onPartProgress: (sent, total) => progress.push(`${sent}/${total}`) });
    assert.equal(result.ok, true);
    assert.equal(result.json.meeting.id, "m2");
    const parts = calls.filter(c => c.url.includes("/parts/"));
    assert.deepEqual(parts.map(c => c.url.split("/").pop()), ["0", "1", "2", "3"]);
    assert.deepEqual(parts.map(c => c.init.body.size), [8388608, 8388608, 8388608, 1048576]);
    assert.deepEqual(progress, ["1/4", "2/4", "3/4", "4/4"]);
    assert.equal(JSON.parse(calls[0].init.body).size, size);
  }
  {
    const calls = stubFetch(t, (url) => url === "/api/meetings/upload-sessions"
      ? reply(409, { code: "UPLOAD_SESSION_UNAVAILABLE", error: "x" })
      : reply(202, { meeting: { id: "m3" } }));
    const result = await meetingUpload.uploadMeetingMedia({ dealId: DEAL, file: new File([new Uint8Array(25 * 1024 * 1024)], "meeting.mp4") });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map(c => c.url), ["/api/meetings/upload-sessions", "/api/meetings"]);
  }
  {
    stubFetch(t, (url) => url === "/api/meetings/upload-sessions"
      ? reply(201, { uploadId: "u-2", partBytes: 8 * 1024 * 1024, totalParts: 4 })
      : reply(400, { error: "パートのサイズが一致しません。" }));
    const result = await meetingUpload.uploadMeetingMedia({ dealId: DEAL, file: new File([new Uint8Array(25 * 1024 * 1024)], "meeting.mp4") });
    assert.equal(result.ok, false);
    assert.match(result.error, /分割アップロードに失敗しました（1\/4）: パートのサイズが一致しません。/);
  }
});

test("T22 split upload completion: concurrent completes create one meeting; a deleted meeting is not recreated; stale sessions are cleaned", async t => {
  const { m, start, put, finish } = await sessionRoutes(t);
  const { uploadId } = await (await start({ dealId: DEAL, filename: "a.mp4", size: 10 })).json();
  await put(uploadId, 0, new Uint8Array(10));
  const [first, second] = await Promise.all([finish(uploadId), finish(uploadId)]);
  const statuses = [first.status, second.status].sort();
  assert.ok(JSON.stringify(statuses) === "[202,202]" || JSON.stringify(statuses) === "[202,409]", String(statuses));
  assert.equal(m.created.length, 1, "only one meeting for concurrent completes");
  m.created.length = 0;
  assert.equal((await finish(uploadId)).status, 410, "the meeting was deleted: do not rebuild it from the parts");

  const old = await (await start({ dealId: DEAL, filename: "b.mp4", size: 10 })).json();
  const manifestPath = path.join(m.root, `recordings/parts/${old.uploadId}/manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, createdAt: "2026-09-20T00:00:00.000Z" }));
  await start({ dealId: DEAL, filename: "c.mp4", size: 10 });
  // The cleanup runs after the response; wait for it briefly.
  let left = await readdir(path.join(m.root, "recordings/parts"));
  for (let i = 0; i < 50 && left.includes(old.uploadId); i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    left = await readdir(path.join(m.root, "recordings/parts"));
  }
  assert.ok(!left.includes(old.uploadId), "expired unfinished upload is removed");
  assert.ok(left.includes(uploadId), "completed uploads are kept (they are the recording)");
});

test("T22 browser upload retries transient part failures with backoff and waits for a concurrent completion", async t => {
  const waits = [];
  let partCalls = 0;
  let completeCalls = 0;
  stubFetch(t, (url) => {
    if (url === "/api/meetings/upload-sessions") return reply(201, { uploadId: "u-3", partBytes: 8 * 1024 * 1024, totalParts: 4 });
    if (url.includes("/parts/")) return ++partCalls === 2 ? reply(503, { error: "busy" }) : reply(200, {});
    if (url.endsWith("/complete")) return ++completeCalls === 1 ? reply(409, { code: "UPLOAD_COMPLETING", error: "完了処理中です。" }) : reply(202, { meeting: { id: "m9" }, transcriptionMode: "job" });
    throw Error("unexpected " + url);
  });
  const result = await meetingUpload.uploadMeetingMedia({ dealId: DEAL, file: new File([new Uint8Array(25 * 1024 * 1024)], "meeting.mp4"), sleep: async ms => { waits.push(ms); } });
  assert.equal(result.ok, true);
  assert.equal(result.json.meeting.id, "m9");
  assert.equal(partCalls, 5, "the failed part is sent again");
  assert.deepEqual(waits, [1000, 1000]);
});

test("T22 cleanup never deletes completed, locked, unreadable or still-valid uploads", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "luma-t22-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const m = { localPath: key => key?.startsWith("/uploads/") ? path.join(root, key.slice("/uploads/".length)) : null };
  const lib = await offlineModule("src/lib/meetings/upload-sessions.ts", m, { "@/lib/storage": storage }, ["src/lib/meetings/upload-sessions.ts"], ["node:fs/promises", "node:path"]);
  const old = "2026-09-20T00:00:00.000Z";
  const ids = {
    abandoned: "11111111-1111-4111-8111-111111111111",
    completed: "22222222-2222-4222-8222-222222222222",
    locked: "33333333-3333-4333-8333-333333333333",
    unreadable: "44444444-4444-4444-8444-444444444444",
    fresh: "55555555-5555-4555-8555-555555555555",
  };
  const manifest = (uploadId, extra = {}) => ({ version: 1, uploadId, dealId: DEAL, userId: "u", filename: "a.mp4", extension: "mp4", size: 10, partBytes: 8 * 1024 * 1024, totalParts: 1, durationSec: null, createdAt: old, ...extra });
  for (const [key, id] of Object.entries(ids)) {
    const dir = path.join(root, "recordings/parts", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "part-00000"), "0123456789");
    if (key === "unreadable") await writeFile(path.join(dir, "manifest.json"), "{broken");
    else await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest(id, key === "completed" ? { completedMeetingId: "m1" } : key === "fresh" ? { createdAt: new Date().toISOString() } : {})));
    if (key === "locked") await writeFile(path.join(dir, "complete.lock"), "");
  }
  assert.equal(await lib.removeExpiredUploadSessions(Date.now(), 30, 0), 1);
  const left = (await readdir(path.join(root, "recordings/parts"))).sort();
  assert.deepEqual(left, [ids.completed, ids.locked, ids.unreadable, ids.fresh].sort());
});
