import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
class VerificationDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-09-23T00:00:00.000Z"])); }
  static now() { return Date.parse("2026-09-23T00:00:00.000Z"); }
}
const env = { LUMA_DEPLOYMENT_ENV: "development", K_SERVICE: "luma-platform-development", GOOGLE_CLOUD_PROJECT: "lumaagentlist", LUMA_DEVELOPMENT_PROJECT_ID: "lumaagentlist", LUMA_CLOUD_AI_MODE: "vertex", AI_PROVIDER: "vertex", AI_PROVIDER_HEAVY: "vertex", VERTEX_LOCATION: "global", VERTEX_MODEL: "gemini-3.5-flash-lite", LUMA_VERTEX_BUDGET_JPY: "45000", LUMA_DEVELOPMENT_UPLOAD_BUCKET: "lumaagentlist-luma-dev-uploads" };
async function load(file, settings = env, globals = {}) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", logLevel: "silent" });
  const loaded = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module: loaded, exports: loaded.exports, require, process: { env: settings }, Buffer, URL, Date: VerificationDate, setTimeout, clearTimeout, AbortSignal, AbortController,
    console: { info() {}, error() {} }, fetch() { throw Error("REAL_NETWORK_FORBIDDEN"); }, ...globals });
  return loaded.exports;
}
const budget = await load("src/lib/ai/vertex-budget.ts");
const vertex = await load("src/lib/ai/vertex.ts");
function store(initialLedger = { version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: [] }) {
  let generation = 1;
  let ledger = structuredClone(initialLedger);
  return { async read() { return { generation: String(generation), ledger: structuredClone(ledger) }; },
    async write(expected, next) { if (expected !== String(generation)) return false; ledger = structuredClone(next); generation++; return true; } };
}
const opts = { system: "test", user: "fictional only", json: true };
const result = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } };
function transport(overrides = {}) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (url.endsWith(":countTokens")) return Response.json({ totalTokens: 5 });
    return overrides.response?.() ?? Response.json(result);
  };
  return { request, calls };
}
function retryTiming() {
  const delays = [];
  return { delays, sleep: async ms => { delays.push(ms); }, random: () => 0 };
}
const busyMessage = "AIサービスが混み合っているか、呼び出し制限に達しています（429）。少し待ってから再実行してください。";
test("configuration and input rejection make no network/ledger calls", async () => {
  for (const changes of [{ GOOGLE_CLOUD_PROJECT: "other-project" }, { K_SERVICE: "sales-agent" }, { LUMA_CLOUD_AI_MODE: "off" }, { VERTEX_MODEL: "unpriced-model" }, ...["500", "1000", "2000", "25001", "30000"].map(LUMA_VERTEX_BUDGET_JPY => ({ LUMA_VERTEX_BUDGET_JPY }))]) {
    const checked = await load("src/lib/ai/vertex.ts", { ...env, ...changes });
    await assert.rejects(checked.vertexGenerate(opts), /設定/);
  }
  await assert.rejects(vertex.vertexGenerate({ ...opts, user: "x".repeat(65537) }), /長すぎ/);
});
test("concurrent reservations never exceed budget and persist after restart", async () => {
  const prior = Array.from({ length: 2245 }, (_, index) => ({
    id: `prior-${index}`, feature: "minutes", model: "gemini-2.5-flash", reservedJpy: 20,
    startedAt: "2026-09-23T00:00:00.000Z", status: ["reserved", "success", "error"][index % 3],
  }));
  const s = store({ version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: prior });
  const initial = (await s.read()).ledger;
  assert.doesNotThrow(() => budget.validateLedger(initial));
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserveVertexAttempt(s, "minutes", "gemini-2.5-flash")));
  const full = (await s.read()).ledger;
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 5);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 15);
  assert.equal(full.attempts.length, 2250);
  assert.deepEqual(full.attempts.slice(0, prior.length), prior);
  assert.doesNotThrow(() => budget.validateLedger(full));
  assert.equal(full.attempts.reduce((total, attempt) => total + attempt.reservedJpy, 0), 45000);
  const restarted = await load("src/lib/ai/vertex-budget.ts");
  await assert.rejects(restarted.reserveVertexAttempt(s, "bant", "gemini-2.5-flash"), /利用枠/);
  const t = transport();
  await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s }), /利用枠/);
  assert.equal(t.calls.length, 0);
  assert.deepEqual((await s.read()).ledger, full);
});
test("search reserves its larger worst-case allowance", async () => {
  const prior = Array.from({ length: 449 }, (_, index) => ({
    id: `prior-search-${index}`, feature: "brief", model: "gemini-2.5-flash", reservedJpy: 100,
    startedAt: "2026-09-23T00:00:00.000Z", status: "success",
  }));
  const s = store({ version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: prior });
  const initial = (await s.read()).ledger;
  assert.doesNotThrow(() => budget.validateLedger(initial));
  await budget.reserveVertexAttempt(s, "brief", "gemini-2.5-flash", true);
  const full = (await s.read()).ledger;
  assert.equal(full.attempts.at(-1).reservedJpy, 100);
  assert.equal(full.attempts.reduce((total, attempt) => total + attempt.reservedJpy, 0), 45000);
  await assert.rejects(budget.reserveVertexAttempt(s, "brief", "gemini-2.5-flash"), /利用枠/);
  await assert.rejects(budget.reserveVertexAttempt(s, "brief", "gemini-2.5-flash", true), /利用枠/);
  assert.deepEqual((await s.read()).ledger, full);
});
test("expanded allowance retains all 21 historical reservations and only adds the remaining 44,500 JPY", async () => {
  const historical = Array.from({ length: 21 }, (_, index) => ({
    id: `historical-${index}`, feature: index === 0 ? "brief" : "context", model: "gemini-2.5-flash",
    reservedJpy: index === 0 ? 100 : 20, startedAt: "2026-09-23T00:00:00.000Z", status: "success",
    usage: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
  }));
  assert.equal(historical.reduce((total, attempt) => total + attempt.reservedJpy, 0), 500);
  const s = store({ version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: historical });
  for (let i = 0; i < 445; i++) await budget.reserveVertexAttempt(s, "brief", "gemini-2.5-flash", true);
  const full = (await s.read()).ledger;
  assert.deepEqual(full.attempts.slice(0, historical.length), historical);
  assert.equal(full.attempts.length, historical.length + 445);
  assert.equal(full.attempts.reduce((total, attempt) => total + attempt.reservedJpy, 0), 45000);
  await assert.rejects(budget.reserveVertexAttempt(s, "transcription", "gemini-2.5-flash"), /利用枠/);
  for (const limitJpy of [500, 1000, 25000, 45001]) {
    const stale = store({ ...full, limitJpy });
    await assert.rejects(budget.reserveVertexAttempt(stale, "transcription", "gemini-2.5-flash"), /利用記録/);
    assert.deepEqual((await stale.read()).ledger, { ...full, limitJpy });
  }
});
test("JSON uses fixed Vertex endpoint, token count, bounded output, minimal thinking, usage ledger", async () => {
  const s = store(), t = transport();
  const value = await vertex.vertexGenerate({ ...opts, maxTokens: 20000, temperature: 0 }, { ...t, store: s });
  assert.equal(value.text, '{"ok":true}');
  assert.equal(value.model, "gemini-3.5-flash-lite");
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[0].url, /\/publishers\/google\/models\/gemini-3\.5-flash-lite:countTokens$/);
  assert.match(t.calls[1].url, /^https:\/\/aiplatform.googleapis.com\/v1\/projects\/lumaagentlist\/locations\/global\/publishers\/google\/models\/gemini-3\.5-flash-lite:generateContent$/);
  const config = t.calls[1].body.generationConfig;
  assert.equal(config.maxOutputTokens, 8192);
  // Gemini 3: thinking by level only (a numeric budget is unsupported and rejected together with a level).
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  // Custom sampling is ignored by 3.5 Flash-Lite and discouraged for Gemini 3; a caller's temperature is not sent.
  for (const key of ["temperature", "topP", "topK", "candidateCount"]) assert.equal(key in config, false, key);
  assert.equal(config.responseMimeType, "application/json");
  assert.equal((await s.read()).ledger.attempts[0].status, "success");
});
test("JSON schema reaches Vertex without relaxing output or input limits", async () => {
  const responseSchema = { type: "OBJECT", properties: { score: { type: "INTEGER", minimum: 1, maximum: 5 } }, required: ["score"] };
  const s = store(), t = transport();
  await vertex.vertexGenerate({ ...opts, maxTokens: 400, responseSchema }, { ...t, store: s });
  assert.deepEqual(t.calls[1].body.generationConfig.responseSchema, responseSchema);
  assert.equal(t.calls[1].body.generationConfig.maxOutputTokens, 400);
  assert.equal(t.calls[1].body.generationConfig.responseMimeType, "application/json");
  for (const changes of [{json:false}, {search:true}, {user:"x".repeat(65530)}]) {
    const rejectedStore=store(), rejectedTransport=transport();
    await assert.rejects(vertex.vertexGenerate({...opts,responseSchema,...changes},{...rejectedTransport,store:rejectedStore}));
    assert.equal(rejectedTransport.calls.length,0);
    assert.equal((await rejectedStore.read()).ledger.attempts.length,0);
  }
  const cappedStore=store();let requests=0;
  await assert.rejects(vertex.vertexGenerate({...opts,responseSchema},{store:cappedStore,request:async url=>{
    requests++;
    assert.ok(url.endsWith(":countTokens"));
    return Response.json({totalTokens:32768});
  }}),/長すぎ/);
  assert.equal(requests,1,"Schema headroom prevents generation at the source token cap");
  assert.equal((await cappedStore.read()).ledger.attempts[0].status,"error");
});
test("429 then success counts input once and retains a fresh reservation for each generation", async () => {
  for (const search of [false, true]) {
    const s = store(), timing = retryTiming();
    const attemptsAtGeneration = [];
    const t = transport({ response: async () => {
      attemptsAtGeneration.push((await s.read()).ledger.attempts);
      return attemptsAtGeneration.length === 1
        ? new Response("PRIVATE_TOKEN_AND_PROMPT", { status: 429 })
        : Response.json(result);
    } });
    const value = await vertex.vertexGenerate({ ...opts, json: !search, search }, { ...t, store: s, ...timing });
    assert.equal(value.text, '{"ok":true}');
    assert.deepEqual(timing.delays, [2000]);
    assert.equal(t.calls.filter(call => call.url.endsWith(":countTokens")).length, 1);
    assert.equal(t.calls.filter(call => call.url.endsWith(":generateContent")).length, 2);
    assert.deepEqual(attemptsAtGeneration.map(attempts => attempts.map(a => a.status)), [["reserved"], ["error", "reserved"]]);
    const attempts = (await s.read()).ledger.attempts;
    assert.equal(new Set(attempts.map(a => a.id)).size, 2);
    assert.deepEqual(attempts.map(a => a.reservedJpy), [search ? 100 : 20, search ? 100 : 20]);
    assert.deepEqual(attempts.map(a => a.status), ["error", "success"]);
    assert.equal(attempts[0].errorCode, "http_429");
    assert.equal(attempts[1].usage.totalTokenCount, 9);
    assert.ok(!JSON.stringify(attempts).includes("PRIVATE"));
  }
});
test("three 429 responses stop after two bounded retries with a congestion message", async () => {
  const s = store(), timing = retryTiming();
  const t = transport({ response: () => new Response("PRIVATE_TOKEN_AND_PROMPT", { status: 429 }) });
  await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...timing }), error => {
    assert.equal(error.name, "VertexError");
    assert.equal(error.code, "http_429");
    assert.equal(error.message, busyMessage);
    assert.ok(!error.message.includes("認証"));
    return true;
  });
  assert.deepEqual(timing.delays, [2000, 4000]);
  assert.equal(t.calls.filter(call => call.url.endsWith(":countTokens")).length, 1);
  assert.equal(t.calls.filter(call => call.url.endsWith(":generateContent")).length, 3);
  const attempts = (await s.read()).ledger.attempts;
  assert.equal(new Set(attempts.map(a => a.id)).size, 3);
  assert.deepEqual(attempts.map(a => [a.status, a.reservedJpy, a.errorCode]), Array.from({ length: 3 }, () => ["error", 20, "http_429"]));
  assert.ok(!JSON.stringify(attempts).includes("PRIVATE"));
});
test("maxAttempts 1 (an optional call) stops at the first 429 with a single reservation; invalid values never reach the network", async () => {
  const s = store(), timing = retryTiming();
  const t = transport({ response: () => new Response("PRIVATE_TOKEN_AND_PROMPT", { status: 429 }) });
  await assert.rejects(vertex.vertexGenerate({ ...opts, maxAttempts: 1 }, { ...t, store: s, ...timing }), error => error.code === "http_429" && error.message === busyMessage);
  assert.deepEqual(timing.delays, []);
  assert.equal(t.calls.filter(call => call.url.endsWith(":generateContent")).length, 1);
  assert.deepEqual((await s.read()).ledger.attempts.map(a => [a.status, a.reservedJpy, a.errorCode]), [["error", 20, "http_429"]]);
  // maxAttempts 2 retries once.
  const s2 = store(), timing2 = retryTiming();
  const t2 = transport({ response: () => new Response("busy", { status: 429 }) });
  await assert.rejects(vertex.vertexGenerate({ ...opts, maxAttempts: 2 }, { ...t2, store: s2, ...timing2 }), error => error.code === "http_429");
  assert.deepEqual(timing2.delays, [2000]);
  assert.equal((await s2.read()).ledger.attempts.length, 2);
  // Success on the single attempt is unchanged.
  const s3 = store();
  const t3 = transport();
  assert.equal((await vertex.vertexGenerate({ ...opts, maxAttempts: 1 }, { ...t3, store: s3, ...retryTiming() })).text, '{"ok":true}');
  for (const maxAttempts of [0, 4, 1.5, Number.NaN]) {
    const s4 = store();
    const t4 = transport();
    await assert.rejects(vertex.vertexGenerate({ ...opts, maxAttempts }, { ...t4, store: s4, ...retryTiming() }), error => error.code === "request_invalid");
    assert.equal(t4.calls.length, 0);
    assert.equal((await s4.read()).ledger.attempts.length, 0);
  }
});
test("a retry cannot generate when the prior attempt exhausts the allowance", async () => {
  const prior = Array.from({ length: 2249 }, (_, index) => ({
    id: `prior-retry-${index}`, feature: "minutes", model: "gemini-2.5-flash", reservedJpy: 20,
    startedAt: "2026-09-23T00:00:00.000Z", status: "success",
  }));
  const s = store({ version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: prior });
  const t = transport({ response: () => new Response("busy", { status: 429 }) });
  await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...retryTiming() }), /利用枠/);
  assert.equal(t.calls.length, 2);
  const attempts = (await s.read()).ledger.attempts;
  assert.deepEqual(attempts.slice(0, prior.length), prior);
  assert.equal(attempts.length, 2250);
  assert.equal(attempts.at(-1).status, "error");
  assert.equal(attempts.at(-1).errorCode, "http_429");
  assert.equal(attempts.reduce((sum, attempt) => sum + attempt.reservedJpy, 0), 45000);
});
test("429 honors numeric and HTTP-date Retry-After within the logical call deadline", async () => {
  for (const [retryAfter, expectedDelay] of [["7", 7000], ["Wed, 23 Sep 2026 00:00:09 GMT", 9000]]) {
    const s = store(), timing = retryTiming();
    let generated = 0;
    const t = transport({ response: () => ++generated === 1
      ? new Response("busy", { status: 429, headers: { "Retry-After": retryAfter } })
      : Response.json(result) });
    await vertex.vertexGenerate(opts, { ...t, store: s, ...timing });
    assert.deepEqual(timing.delays, [expectedDelay]);
    assert.equal(generated, 2);
    assert.deepEqual((await s.read()).ledger.attempts.map(a => a.status), ["error", "success"]);
  }
});
test("429 stops when Retry-After would exceed the total 120-second deadline", async () => {
  for (const retryAfter of ["121", "Wed, 23 Sep 2026 00:02:01 GMT"]) {
    const s = store(), timing = retryTiming();
    const t = transport({ response: () => new Response("busy", { status: 429, headers: { "Retry-After": retryAfter } }) });
    await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...timing }), error => error.message === busyMessage);
    assert.deepEqual(timing.delays, []);
    assert.equal(t.calls.length, 2);
    assert.deepEqual((await s.read()).ledger.attempts.map(a => a.status), ["error"]);
  }
});
test("the retry deadline includes time already spent waiting", async () => {
  let now = VerificationDate.now();
  class MovingDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const checked = await load("src/lib/ai/vertex.ts", env, { Date: MovingDate });
  const s = store(), delays = [];
  const t = transport({ response: () => new Response("busy", { status: 429, headers: { "Retry-After": "61" } }) });
  await assert.rejects(checked.vertexGenerate(opts, { ...t, store: s,
    sleep: async ms => { delays.push(ms); now += ms; }, random: () => 0,
  }), error => error.message === busyMessage);
  assert.deepEqual(delays, [61000]);
  assert.equal(t.calls.length, 3);
  assert.deepEqual((await s.read()).ledger.attempts.map(a => a.status), ["error", "error"]);
});
test("countTokens consumes the same 120-second deadline as generation", async () => {
  let now = VerificationDate.now();
  class MovingDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const checked = await load("src/lib/ai/vertex.ts", env, { Date: MovingDate });
  const s = store(), timing = retryTiming(), urls = [];
  await assert.rejects(checked.vertexGenerate(opts, { store: s, ...timing, request: async url => {
    urls.push(url);
    now += 120000;
    return Response.json({ totalTokens: 5 });
  } }), error => error.code === "timeout");
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith(":countTokens"));
  assert.deepEqual(timing.delays, []);
  const attempts = (await s.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "error");
  assert.equal(attempts[0].reservedJpy, 20);
});
test("authentication, server, network and timeout failures never retry or release reservation", async () => {
  const responses = [401, 403, 500, 503].map(status => () => new Response("PRIVATE_TOKEN_AND_PROMPT", { status }));
  responses.push(() => { throw Error("PRIVATE_TOKEN_AND_PROMPT"); }, () => { throw new DOMException("PRIVATE_TOKEN_AND_PROMPT", "TimeoutError"); });
  for (const response of responses) {
    const s = store(), t = transport({ response }), timing = retryTiming();
    await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...timing }), e => !e.message.includes("PRIVATE") && e.name === "VertexError");
    assert.equal(t.calls.length, 2);
    assert.deepEqual(timing.delays, []);
    const attempts = (await s.read()).ledger.attempts;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "error");
    assert.equal(attempts[0].reservedJpy, 20);
    assert.ok(!JSON.stringify(attempts).includes("PRIVATE"));
  }
});
test("countTokens 429 stops without generation or retry", async () => {
  const s = store(), timing = retryTiming(), urls = [];
  await assert.rejects(vertex.vertexGenerate(opts, { store: s, ...timing, request: async url => {
    urls.push(url); return new Response("PRIVATE_TOKEN_AND_PROMPT", { status: 429 });
  } }), error => error.code === "count_429" && !error.message.includes("PRIVATE"));
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith(":countTokens"));
  assert.deepEqual(timing.delays, []);
  const attempts = (await s.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "error");
  assert.equal(attempts[0].reservedJpy, 20);
});
test("failed 429 ledger finalization prevents further generation", async () => {
  const persisted = store(), timing = retryTiming();
  const s = {
    read: persisted.read,
    write: async (generation, ledger) => {
      if (ledger.attempts.some(a => a.status === "error")) throw Error("PRIVATE_LEDGER_FAILURE");
      return persisted.write(generation, ledger);
    },
  };
  const t = transport({ response: () => new Response("busy", { status: 429 }) });
  await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...timing }), error => error.name === "VertexError" && !error.message.includes("PRIVATE"));
  assert.equal(t.calls.length, 2);
  assert.deepEqual(timing.delays, []);
  const attempts = (await persisted.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "reserved");
  assert.equal(attempts[0].reservedJpy, 20);
});
test("transport retains the 120-second cap and caller cancellation", async () => {
  const timeoutDurations = [];
  const timeoutController = new AbortController();
  const checked = await load("src/lib/ai/vertex.ts", env, { AbortSignal: {
    timeout: ms => { timeoutDurations.push(ms); return timeoutController.signal; },
    any: signals => AbortSignal.any(signals),
  } });
  const signals = [];
  const request = checked.vertexTransport(async () => "offline-fake-token", async (_url, init) => {
    signals.push(init.signal); return Response.json({ ok: true });
  });
  const caller = new AbortController();
  await request("https://example.test/offline", { signal: caller.signal });
  assert.equal(signals[0].aborted, false);
  caller.abort();
  assert.equal(signals[0].aborted, true);
  await request("https://example.test/offline");
  assert.equal(signals[1].aborted, false);
  timeoutController.abort();
  assert.equal(signals[1].aborted, true);
  assert.ok(timeoutDurations.length >= 2);
  assert.ok(timeoutDurations.every(ms => ms === 120000));
});
test("transport aborts a stalled ADC token wait without reaching fetch", async () => {
  let releaseToken;
  let tokenCalls = 0, fetchCalls = 0;
  const request = vertex.vertexTransport(() => {
    tokenCalls++;
    return new Promise(resolve => { releaseToken = resolve; });
  }, async () => { fetchCalls++; return Response.json({ ok: true }); });
  const caller = new AbortController();
  const pending = request("https://example.test/offline", { signal: caller.signal })
    .then(() => ({ status: "fulfilled" }), error => ({ status: "rejected", error }));
  caller.abort();
  let timer;
  try {
    const outcome = await Promise.race([pending, new Promise(resolve => {
      timer = setTimeout(() => resolve({ status: "still-pending" }), 100);
    })]);
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.error.name, "AbortError");
    assert.equal(tokenCalls, 1);
    assert.equal(fetchCalls, 0);
  } finally {
    clearTimeout(timer);
    releaseToken?.("offline-fake-token");
    await pending;
  }
  await Promise.resolve();
  assert.equal(fetchCalls, 0, "a late ADC result must not restart the aborted request");
});
test("transport rejects an already-aborted signal before ADC or fetch", async () => {
  let tokenCalls = 0, fetchCalls = 0;
  const request = vertex.vertexTransport(async () => { tokenCalls++; return "offline-fake-token"; },
    async () => { fetchCalls++; return Response.json({ ok: true }); });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(request("https://example.test/offline", { signal: caller.signal }), error => error.name === "AbortError");
  assert.equal(tokenCalls, 0);
  assert.equal(fetchCalls, 0);
});
test("output cut off while thinking is incomplete (so callers can split), not missing usage", async () => {
  for (const usageMetadata of [{ promptTokenCount: 5, thoughtsTokenCount: 8192, totalTokenCount: 8197 }, undefined]) {
    for (const search of [false, true]) {
      const payload = { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "", thoughtSignature: "signature" }] } }], usageMetadata };
      const s = store(), t = transport({ response: () => Response.json(payload) }), timing = retryTiming();
      await assert.rejects(vertex.vertexGenerate(search ? { ...opts, json: false, search: true, feature: "brief" } : opts, { ...t, store: s, ...timing }), error => error.code === "incomplete");
      assert.equal(t.calls.length, 2, "no automatic retry");
      assert.deepEqual(timing.delays, []);
      const attempts = (await s.read()).ledger.attempts;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "error");
      assert.equal(attempts[0].errorCode, "incomplete");
      assert.equal(attempts[0].reservedJpy, search ? 100 : 20, "the reservation is kept");
    }
  }
});
test("usage missing or truncated output is not a successful AI call", async () => {
  for (const payload of [{ candidates: result.candidates }, { ...result, candidates: [{ ...result.candidates[0], finishReason: "MAX_TOKENS" }] }]) {
    const s = store(), t = transport({ response: () => Response.json(payload) }), timing = retryTiming();
    await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s, ...timing }));
    assert.equal(t.calls.length, 2);
    assert.deepEqual(timing.delays, []);
    assert.equal((await s.read()).ledger.attempts[0].status, "error");
  }
});
const searchOpts = { ...opts, json: false, search: true, feature: "brief" };
function zeroSearchResponse() {
  return {
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 187, totalTokenCount: 187, trafficType: "ON_DEMAND", promptTokensDetails: [{ modality: "TEXT", tokenCount: 187 }] },
  };
}
async function rejectsSearch(payload, expectedCode = "usage_missing") {
  const s = store(), t = transport({ response: () => Response.json(payload) }), timing = retryTiming();
  await assert.rejects(vertex.vertexGenerate(searchOpts, { ...t, store: s, ...timing }), error => error.code === expectedCode);
  assert.equal(t.calls.length, 2, "a failed zero-result check must not start an additional generation");
  assert.deepEqual(timing.delays, []);
  const attempts = (await s.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "error");
  assert.equal(attempts[0].reservedJpy, 100, "failed search keeps the whole conservative reservation");
}
test("search-only empty STOP with provably zero output succeeds and retains its 100 JPY reservation", async () => {
  for (const content of [undefined, {}, { role: "model" }, { parts: [] }, { parts: [{ text: "" }] }, { role: "model", parts: [{ text: "", thought: false }] },
    { role: "model", parts: [{ text: "", thoughtSignature: "opaque-signature" }] }]) {
    for (const explicitZero of [false, true]) {
      const payload = zeroSearchResponse();
      payload.candidates[0].content = content;
      const grounding = { searchEntryPoint: { renderedContent: "<div>Google</div>" }, groundingChunks: [{ web: { uri: "https://example.test/search-candidate" } }] };
      payload.candidates[0].groundingMetadata = grounding;
      if (explicitZero) Object.assign(payload.usageMetadata, {
        candidatesTokenCount: 0, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0, cachedContentTokenCount: 12,
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 0 }], toolUsePromptTokensDetails: [], cacheTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
      });
      const s = store(), t = transport({ response: () => Response.json(payload) });
      const value = await vertex.vertexGenerate(searchOpts, { ...t, store: s });
      assert.equal(value.noSearchResult, true);
      assert.equal(value.text, "");
      assert.equal(value.usage.candidatesTokenCount, 0);
      assert.equal(value.usage.promptTokenCount, 187);
      assert.equal(value.usage.totalTokenCount, 187);
      assert.deepEqual(value.groundingMetadata, grounding);
      assert.equal(t.calls.length, 2);
      const attempts = (await s.read()).ledger.attempts;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "success");
      assert.equal(attempts[0].reservedJpy, 100);
      assert.equal(attempts[0].usage.candidatesTokenCount, 0);
    }
  }
});
test("search-only empty STOP after minimal thinking keeps the thinking tokens as output usage", async () => {
  const payload = zeroSearchResponse();
  payload.candidates[0].content = { role: "model", parts: [{ text: "", thoughtSignature: "opaque-signature" }] };
  Object.assign(payload.usageMetadata, { thoughtsTokenCount: 24, totalTokenCount: 211 });
  const s = store(), t = transport({ response: () => Response.json(payload) });
  const value = await vertex.vertexGenerate(searchOpts, { ...t, store: s });
  assert.equal(value.noSearchResult, true);
  assert.equal(value.text, "");
  const usage = JSON.parse(JSON.stringify(value.usage));
  assert.deepEqual(usage, { promptTokenCount: 187, candidatesTokenCount: 0, thoughtsTokenCount: 24, totalTokenCount: 211 });
  const attempts = (await s.read()).ledger.attempts;
  assert.equal(attempts[0].status, "success");
  assert.deepEqual(attempts[0].usage, usage);
});
test("normal nonempty search preserves usage and non-search never infers missing output tokens", async () => {
  const s = store(), t = transport();
  const value = await vertex.vertexGenerate(searchOpts, { ...t, store: s });
  assert.equal(value.noSearchResult, false);
  assert.equal(value.text, '{"ok":true}');
  assert.deepEqual(JSON.parse(JSON.stringify(value.usage)), result.usageMetadata);
  for (const explicitZero of [false, true]) {
    const payload = zeroSearchResponse();
    if (explicitZero) payload.usageMetadata.candidatesTokenCount = 0;
    const s = store(), t = transport({ response: () => Response.json(payload) });
    await assert.rejects(vertex.vertexGenerate(opts, { ...t, store: s }), error => error.code === (explicitZero ? "empty" : "usage_missing"));
    const attempts = (await s.read()).ledger.attempts;
    assert.equal(attempts[0].status, "error");
    assert.equal(attempts[0].reservedJpy, 20);
    assert.equal(t.calls.length, 2);
  }
  assert.equal(vertex.safeVertexUsage(zeroSearchResponse().usageMetadata), null);
});
test("search requests record how many search queries ran (Gemini 3 grounding is billed per query), never the queries", async () => {
  const logs = [];
  const checked = await load("src/lib/ai/vertex.ts", env, { console: { info: line => logs.push(line), error() {} } });
  const measuredFor = async (groundingMetadata, options = searchOpts) => {
    logs.length = 0;
    const payload = structuredClone(result);
    if (groundingMetadata !== undefined) payload.candidates[0].groundingMetadata = groundingMetadata;
    await checked.vertexGenerate(options, { ...transport({ response: () => Response.json(payload) }), store: store() });
    return JSON.parse(logs.find(line => line.startsWith("[ai-usage] ")).slice("[ai-usage] ".length));
  };
  assert.equal((await measuredFor({ webSearchQueries: ["PRIVATE_QUERY_1", "PRIVATE_QUERY_2", "PRIVATE_QUERY_3"] })).searchQueries, 3);
  assert.ok(!logs.join("\n").includes("PRIVATE_QUERY"));
  assert.equal((await measuredFor({ webSearchQueries: [] })).searchQueries, 0);
  // Unknown is recorded as null so the cost report does not price it as zero queries.
  for (const unknown of [undefined, {}, { webSearchQueries: "PRIVATE_QUERY" }, { webSearchQueries: [1] }, { webSearchQueries: null }]) {
    assert.equal((await measuredFor(unknown)).searchQueries, null);
  }
  const nonSearch = await measuredFor({ webSearchQueries: ["PRIVATE_QUERY"] }, opts);
  assert.equal(nonSearch.search, false);
  assert.equal("searchQueries" in nonSearch, false);
});
test("the ledger keeps each search request's query count, and a count beyond the 100 JPY reservation is flagged", async () => {
  const errors = [], allErrors = [];
  const checked = await load("src/lib/ai/vertex.ts", env, { console: { info() {}, error: line => { errors.push(line); allErrors.push(line); } } });
  assert.equal(checked.SEARCH_QUERIES_WITHIN_RESERVATION, 33);
  const queries = n => Array.from({ length: n }, (_, i) => `PRIVATE_QUERY_${i}`);
  const run = async (payload, options = searchOpts) => {
    errors.length = 0;
    const s = store();
    const outcome = await checked.vertexGenerate(options, { ...transport({ response: () => Response.json(payload) }), store: s }).then(() => "ok", error => error.code);
    return { outcome, attempt: (await s.read()).ledger.attempts[0], flagged: errors.filter(line => line.startsWith("[vertex-search-queries] ")).map(line => JSON.parse(line.slice("[vertex-search-queries] ".length))) };
  };
  const withQueries = (grounding, base = result) => { const payload = structuredClone(base); payload.candidates[0].groundingMetadata = grounding; return payload; };
  let r = await run(withQueries({ webSearchQueries: queries(33) }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.attempt.status, "success");
  assert.equal(r.attempt.searchQueries, 33);
  assert.deepEqual(r.flagged, []);
  r = await run(withQueries({ webSearchQueries: queries(34) }));
  assert.equal(r.attempt.searchQueries, 34);
  assert.deepEqual(JSON.parse(JSON.stringify(r.flagged)), [{ attemptId: r.attempt.id, searchQueries: 34, withinReservation: 33 }]);
  r = await run(withQueries(undefined));
  assert.equal(r.attempt.searchQueries, null);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].searchQueries, null);
  // A no-result search and a search rejected after the response still record the billed queries.
  const zero = zeroSearchResponse();
  zero.candidates[0].groundingMetadata = { webSearchQueries: queries(2) };
  r = await run(zero);
  assert.equal(r.outcome, "ok");
  assert.equal(r.attempt.searchQueries, 2);
  r = await run(withQueries({ webSearchQueries: queries(40) }, { ...result, candidates: [{ ...result.candidates[0], finishReason: "MAX_TOKENS" }] }));
  assert.equal(r.outcome, "incomplete");
  assert.equal(r.attempt.status, "error");
  assert.equal(r.attempt.searchQueries, 40);
  assert.equal(r.flagged.length, 1);
  // Requests that fail before a response, and non-search requests, carry no query count.
  errors.length = 0;
  const failed = store();
  await assert.rejects(checked.vertexGenerate(searchOpts, { ...transport({ response: () => new Response("", { status: 500 }) }), store: failed }));
  assert.equal("searchQueries" in (await failed.read()).ledger.attempts[0], false);
  assert.equal(errors.filter(line => line.startsWith("[vertex-search-queries] ")).length, 0);
  // A 200 response whose body cannot be read was billed for queries that are now unknown.
  errors.length = 0;
  const unreadable = store();
  await assert.rejects(checked.vertexGenerate(searchOpts, { ...transport({ response: () => new Response('{"candidates":[', { status: 200 }) }), store: unreadable }), error => error.code === "transport");
  const unreadableAttempt = (await unreadable.read()).ledger.attempts[0];
  assert.equal(unreadableAttempt.status, "error");
  assert.equal(unreadableAttempt.searchQueries, null);
  const unreadableFlags = errors.filter(line => line.startsWith("[vertex-search-queries] ")).map(line => JSON.parse(line.slice("[vertex-search-queries] ".length)));
  assert.deepEqual(JSON.parse(JSON.stringify(unreadableFlags)), [{ attemptId: unreadableAttempt.id, searchQueries: null, withinReservation: 33 }]);
  // A response over the limit that is then rejected is flagged once, not again on the error path.
  r = await run(withQueries({ webSearchQueries: queries(35) }, { ...result, candidates: [{ ...result.candidates[0], content: { parts: [{ text: "" }] } }] }));
  assert.equal(r.outcome, "empty");
  assert.equal(r.attempt.searchQueries, 35);
  assert.equal(r.flagged.length, 1);
  r = await run(withQueries({ webSearchQueries: queries(40) }), opts);
  assert.equal("searchQueries" in r.attempt, false);
  assert.deepEqual(r.flagged, []);
  assert.ok(allErrors.length >= 3);
  assert.ok(!allErrors.join("\n").includes("PRIVATE_QUERY"));
});
test("missing, multiple, malformed and unfinished candidates never become a no-result success", async () => {
  for (const candidates of [undefined, null, {}, [], [null], [{ finishReason: "STOP" }, { finishReason: "STOP" }],
    [{}], [{ finishReason: "MAX_TOKENS" }], [{ finishReason: "SAFETY" }], [{ finishReason: "UNKNOWN_REASON" }]]) {
    await rejectsSearch({ ...zeroSearchResponse(), candidates }, candidates?.[0]?.finishReason === "MAX_TOKENS" ? "incomplete" : "usage_missing");
  }
  for (const content of [null, [], { role: "user" }, { unexpected: "value" }, { parts: null }, { parts: {} }]) {
    await rejectsSearch({ ...zeroSearchResponse(), candidates: [{ finishReason: "STOP", content }] });
  }
});
test("partial text, whitespace, thoughts and other output parts prevent zero-output inference", async () => {
  for (const parts of [[{ text: "a" }], [{ text: " " }], [{ text: "\n" }], [{ text: "", thought: true }],
    [{ text: "hidden", thought: true }], [{ text: "", thought: null }], [{ text: "", thought: true, thoughtSignature: "signature" }],
    [{ text: "", thoughtSignature: "" }], [{ text: "", thoughtSignature: 1 }], [{ text: "", thoughtSignature: null }], [{ text: " ", thoughtSignature: "signature" }],
    [{ functionCall: { name: "tool" } }], [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
    [{ text: "", unknown: true }], [{}], [null], [{ text: 0 }], [{ text: "" }, { text: "partial" }]]) {
    await rejectsSearch({ ...zeroSearchResponse(), candidates: [{ finishReason: "STOP", content: { parts } }] });
  }
});
test("zero-output inference requires positive, finite, consistent scalar and detail token counts", async () => {
  const changes = [
    { promptTokenCount: undefined }, { promptTokenCount: 0, totalTokenCount: 0 }, { promptTokenCount: -1, totalTokenCount: -1 },
    { promptTokenCount: 1.5, totalTokenCount: 1.5 }, { promptTokenCount: Number.MAX_SAFE_INTEGER + 1, totalTokenCount: Number.MAX_SAFE_INTEGER + 1 },
    { promptTokenCount: "187" }, { totalTokenCount: undefined }, { totalTokenCount: 188 }, { totalTokenCount: 186 },
    { candidatesTokenCount: 1 }, { candidatesTokenCount: null }, { candidatesTokenCount: -1 },
    { thoughtsTokenCount: 1 }, { thoughtsTokenCount: "0" }, { toolUsePromptTokenCount: 1 },
    { thoughtsTokenCount: 5, totalTokenCount: 191 }, { thoughtsTokenCount: 5, totalTokenCount: 193 }, { thoughtsTokenCount: -5, totalTokenCount: 182 },
    { thoughtsTokenCount: 5, totalTokenCount: 192, candidatesTokenCount: 1 }, { toolUsePromptTokenCount: 5, totalTokenCount: 192 },
    { cachedContentTokenCount: -1 }, { cachedContentTokenCount: 188 },
    { promptTokensDetails: [{ tokenCount: -1 }] }, { promptTokensDetails: [{ tokenCount: 1.5 }] },
    { promptTokensDetails: [{ tokenCount: 188 }] }, { promptTokensDetails: null },
    { cacheTokensDetails: [{ tokenCount: -1 }] }, { candidatesTokensDetails: [{ tokenCount: 1 }] },
    { toolUsePromptTokensDetails: [{ tokenCount: 1 }] }, { toolUsePromptTokensDetails: {} },
  ];
  for (const change of changes) {
    const payload = zeroSearchResponse();
    Object.assign(payload.usageMetadata, change);
    await rejectsSearch(payload, change.candidatesTokenCount === 1 ? "empty" : "usage_missing");
  }
  for (const usageMetadata of [undefined, null, [], {}, "invalid"]) {
    await rejectsSearch({ ...zeroSearchResponse(), usageMetadata });
  }
});
test("blocked feedback, malformed safety and unknown block enums remain failures", async () => {
  for (const promptFeedback of [null, [], { blockReason: "SAFETY" }, { blockReason: "BLOCK_REASON_UNSPECIFIED" },
    { blockReason: "UNKNOWN_REASON" }, { blockReasonMessage: "blocked" }, { safetyRatings: [{ blocked: true }] },
    { safetyRatings: [{ blocked: "false" }] }, { safetyRatings: null }, { safetyRatings: [null] }]) {
    await rejectsSearch({ ...zeroSearchResponse(), promptFeedback });
  }
  for (const safetyRatings of [null, {}, [null], [{ blocked: true }], [{ blocked: 0 }]]) {
    const payload = zeroSearchResponse();
    payload.candidates[0].safetyRatings = safetyRatings;
    await rejectsSearch(payload);
  }
  for (const promptFeedback of [{}, { blockReason: "BLOCKED_REASON_UNSPECIFIED", blockReasonMessage: "", safetyRatings: [{ blocked: false }] }]) {
    const payload = zeroSearchResponse();
    payload.promptFeedback = promptFeedback;
    payload.candidates[0].safetyRatings = [{ blocked: false }];
    const value = await vertex.vertexGenerate(searchOpts, { ...transport({ response: () => Response.json(payload) }), store: store() });
    assert.equal(value.noSearchResult, true);
  }
});
test("search diagnostics expose only safe metadata and zero inference is consistent with usage accounting", async () => {
  const logs = [];
  const checked = await load("src/lib/ai/vertex.ts", env, { console: { info: line => logs.push(line), error() {} } });
  const payload = zeroSearchResponse();
  const s = store(), t = transport({ response: () => Response.json(payload) });
  await checked.vertexGenerate(searchOpts, { ...t, store: s });
  const diagnostic = JSON.parse(logs.find(line => line.startsWith("[vertex-search-response] ")).slice("[vertex-search-response] ".length));
  const measured = JSON.parse(logs.find(line => line.startsWith("[ai-usage] ")).slice("[ai-usage] ".length));
  assert.equal(diagnostic.candidateCount, 1);
  assert.deepEqual(diagnostic.finishReasons, ["STOP"]);
  assert.equal(diagnostic.textCharacters, 0);
  assert.equal(diagnostic.blockedOrInvalidSafety, false);
  assert.equal(diagnostic.inferredZeroOutput, true);
  assert.deepEqual(diagnostic.usage.candidatesTokenCount, { present: false, value: null });
  assert.deepEqual(diagnostic.usage.promptTokenCount, { present: true, value: 187 });
  assert.equal(measured.status, "success");
  assert.equal(measured.usage.candidatesTokenCount, 0);
  assert.deepEqual(measured.usage, (await s.read()).ledger.attempts[0].usage);
  logs.length = 0;
  const privateMarker = "PRIVATE_NAME_URL_AUTH_PROMPT";
  const invalid = { ...result, candidates: [{ finishReason: privateMarker, content: { parts: [{ text: privateMarker }] }, groundingMetadata: { url: "https://private.test/" + privateMarker } }] };
  await assert.rejects(checked.vertexGenerate({ ...searchOpts, system: privateMarker, user: privateMarker }, { ...transport({ response: () => Response.json(invalid) }), store: store() }), error => error.code === "incomplete");
  const invalidLog = JSON.parse(logs.find(line => line.startsWith("[vertex-search-response] ")).slice("[vertex-search-response] ".length));
  assert.deepEqual(invalidLog.finishReasons, ["UNKNOWN_OR_MISSING"]);
  assert.equal(invalidLog.textCharacters, privateMarker.length);
  assert.equal(invalidLog.inferredZeroOutput, false);
  assert.ok(!logs.join("\n").includes(privateMarker));
  assert.ok(!logs.join("\n").includes("private.test"));
});
test("search HTTP and malformed JSON responses log no raw error content or invented usage", async () => {
  const logs = [];
  const checked = await load("src/lib/ai/vertex.ts", env, { console: { info: line => logs.push(line), error() {} } });
  for (const status of [403, 500, 200]) {
    logs.length = 0;
    const s = store(), t = transport({ response: () => new Response("PRIVATE_RESPONSE_BODY", { status }) });
    await assert.rejects(checked.vertexGenerate(searchOpts, { ...t, store: s }), error => error.code === (status === 200 ? "transport" : `http_${status}`));
    const diagnostic = JSON.parse(logs.find(line => line.startsWith("[vertex-search-response] ")).slice("[vertex-search-response] ".length));
    assert.equal(diagnostic.httpStatus, status);
    assert.equal(diagnostic.candidateCount, 0);
    assert.equal(diagnostic.inferredZeroOutput, false);
    assert.deepEqual(diagnostic.usage.candidatesTokenCount, { present: false, value: null });
    assert.ok(!logs.join("\n").includes("PRIVATE_RESPONSE_BODY"));
    assert.equal((await s.read()).ledger.attempts[0].status, "error");
  }
});
test("audio input count over cap never reaches generateContent", async () => {
  const s = store(); let requests = 0;
  await assert.rejects(vertex.vertexGenerate({ ...opts, audio: { mimeType: "audio/wav", data: Buffer.from("fake offline audio").toString("base64") } }, {
    store: s, request: async url => { requests++; assert.ok(url.endsWith(":countTokens")); return Response.json({ totalTokens: 32769 }); },
  }), /長すぎ/);
  assert.equal(requests, 1);
});
test("missing GCS ledger fails closed, generation conflict is distinguishable", async () => {
  const missing = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async () => new Response("", { status: 404 }));
  await assert.rejects(missing.read(), /停止/);
  const urls = [];
  const cas = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async url => { urls.push(url); return new Response("", { status: 412 }); });
  assert.equal(await cas.write("123", (await store().read()).ledger), false);
  assert.ok(urls[0].includes("ifGenerationMatch=123"));
});
test("QG26-03 a ledger read that loses its generation to a concurrent write waits and reads again (bounded)", async () => {
  const ledger = { version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: [] };
  for (const raceStatus of [404, 412]) {
    let generation = 5;
    const urls = [], waits = [];
    const request = async url => {
      urls.push(url);
      if (url.includes("?fields=generation")) return Response.json({ generation: String(generation) });
      if (url.includes("alt=media")) {
        // The first data read asks for a generation that another request has just replaced.
        if (url.endsWith("generation=5")) { generation = 6; return new Response("", { status: raceStatus }); }
        return Response.json(structuredClone(ledger));
      }
      throw Error("unexpected request " + url);
    };
    const s = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, request, async ms => { waits.push(ms); });
    const read = await s.read();
    assert.equal(read.generation, "6", `HTTP ${raceStatus}`);
    assert.deepEqual(read.ledger.attempts, []);
    assert.equal(urls.filter(url => url.includes("?fields=generation")).length, 2, "metadata read again");
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 0);
  }
  // The retry is bounded: a ledger that keeps changing still stops with the same message.
  const waits = [];
  let generation = 1, metaReads = 0;
  const churning = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async url => {
    if (url.includes("?fields=generation")) { metaReads++; return Response.json({ generation: String(generation++) }); }
    return new Response("", { status: 404 });
  }, async ms => { waits.push(ms); });
  await assert.rejects(churning.read(), error => error.code === "ledger_unavailable" && /取得できませんでした/.test(error.message));
  assert.ok(metaReads >= 2 && metaReads <= 5, `bounded attempts (${metaReads})`);
  assert.equal(waits.length, metaReads - 1);
  // Not a race: a missing ledger (metadata 404) and other data errors stop at once, without waiting.
  for (const [metaStatus, dataStatus] of [[404, 200], [200, 500], [200, 403]]) {
    const noWaits = [];
    const failing = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async url => url.includes("?fields=generation")
      ? (metaStatus === 200 ? Response.json({ generation: "3" }) : new Response("", { status: metaStatus }))
      : new Response("", { status: dataStatus }), async ms => { noWaits.push(ms); });
    await assert.rejects(failing.read(), error => error.code === "ledger_unavailable");
    assert.deepEqual(noWaits, [], `${metaStatus}/${dataStatus}`);
  }
});
test("a rate-limited ledger write (GCS 429) waits and retries; other write failures still stop", async () => {
  const errors = [];
  const checked = await load("src/lib/ai/vertex.ts", env, { console: { info() {}, error: line => errors.push(line) } });
  const waits = [];
  const limited = checked.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async () => new Response("", { status: 429 }), async ms => { waits.push(ms); });
  assert.equal(await limited.write("7", (await store().read()).ledger), false, "not written: the caller re-reads and retries");
  assert.deepEqual(waits, [1100]);
  assert.ok(errors.some(line => line.includes("429")));
  for (const status of [500, 503, 403]) {
    const failing = checked.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, async () => new Response("", { status }), async ms => { waits.push(ms); });
    await assert.rejects(failing.write("7", (await store().read()).ledger), error => error.code === "ledger_unavailable");
  }
  assert.deepEqual(waits, [1100], "only 429 waits");
  // End to end: two 429s on the reservation write, then the reservation succeeds once.
  const backing = store();
  let limitedWrites = 2;
  const flaky = { read: backing.read, async write(generation, ledger) { if (limitedWrites-- > 0) return false; return backing.write(generation, ledger); } };
  const id = await budget.reserveVertexAttempt(flaky, "minutes", "gemini-3.5-flash-lite");
  const attempts = (await backing.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].id, id);
});
test("a reservation whose write landed but was reported as not applied is not recorded twice", async () => {
  const backing = store();
  let first = true;
  const ambiguous = { read: backing.read, async write(generation, ledger) { const ok = await backing.write(generation, ledger); if (first) { first = false; return false; } return ok; } };
  const id = await budget.reserveVertexAttempt(ambiguous, "minutes", "gemini-3.5-flash-lite");
  const attempts = (await backing.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].id, id);
  assert.equal(attempts[0].status, "reserved");
});
test("finishing an attempt survives rate-limited and ambiguous ledger writes without duplicating it", async () => {
  const backing = store();
  const id = await budget.reserveVertexAttempt(backing, "minutes", "gemini-3.5-flash-lite");
  let calls = 0;
  const flaky = { read: backing.read, async write(generation, ledger) {
    calls++;
    if (calls === 1) { await backing.write(generation, ledger); return false; } // landed, reported as not applied
    if (calls === 2) return false; // rate-limited, not applied
    return backing.write(generation, ledger);
  } };
  await budget.finishVertexAttempt(flaky, id, { status: "success", usage: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 } });
  const attempts = (await backing.read()).ledger.attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "success");
  assert.equal(attempts[0].usage.totalTokenCount, 9);
  assert.equal(attempts[0].reservedJpy, 20);
});
test("back-to-back calls through the real ledger store succeed when GCS rate-limits each first write", async () => {
  let generation = 1, ledger = { version: 1, scope: "luma-platform-development", limitJpy: 45000, attempts: [] }, limitNext = true;
  const waits = [];
  const request = async (url, init = {}) => {
    if (url.includes(":countTokens")) return Response.json({ totalTokens: 5 });
    if (url.includes(":generateContent")) return Response.json(result);
    if (url.includes("/upload/")) {
      if (limitNext) { limitNext = false; return new Response("", { status: 429 }); }
      limitNext = true;
      if (!url.includes(`ifGenerationMatch=${generation}`)) return new Response("", { status: 412 });
      ledger = JSON.parse(init.body); generation++;
      return Response.json({});
    }
    if (url.includes("?fields=generation")) return Response.json({ generation: String(generation) });
    if (url.includes("alt=media")) return Response.json(structuredClone(ledger));
    throw Error("unexpected request " + url);
  };
  const realStore = vertex.vertexLedgerStore(env.LUMA_DEVELOPMENT_UPLOAD_BUCKET, request, async ms => { waits.push(ms); });
  for (let i = 0; i < 3; i++) {
    const value = await vertex.vertexGenerate(opts, { request, store: realStore });
    assert.equal(value.text, '{"ok":true}');
  }
  assert.equal(ledger.attempts.length, 3);
  assert.ok(ledger.attempts.every(a => a.status === "success" && a.usage?.totalTokenCount === 9));
  assert.equal(new Set(ledger.attempts.map(a => a.id)).size, 3);
  assert.deepEqual(waits, Array(6).fill(1100), "one wait per reserve and per finish write");
});
test("invalid provider is rejected; heavy provider inherits Vertex", async () => {
  const provider = await load("src/lib/ai/provider.ts", { ...env, AI_PROVIDER_HEAVY: undefined });
  assert.equal(provider.getHeavyTextProvider(), "vertex");
  const bad = await load("src/lib/ai/provider.ts", { AI_PROVIDER: "vertxe" });
  assert.throws(() => bad.getTextProvider(), /Invalid AI/);
});
test("grounding accepts only cited metadata URLs and rejects invented source URLs", async () => {
  const grounding = await load("src/lib/ai/vertex-grounding.ts");
  const g = grounding.extractVertexGrounding("根拠付き本文", {
    groundingChunks: [{ web: { title: "公式", uri: "https://example.test/verified" } }],
    groundingSupports: [{ segment: { text: "根拠付き本文" }, groundingChunkIndices: [0] }],
    searchEntryPoint: { renderedContent: "<div>Google</div>" },
  });
  const checked = grounding.constrainVertexSources({ industry_summary: "偽の事実", sources: [{ url: "https://invented.test" }], hiring_insights: { media: "架空媒体", sources: [] }, pain_hypotheses: [{ source_url: "https://invented.test", confidence: "high" }] }, g);
  assert.equal(checked.industry_summary, "確認できず");
  assert.equal(checked.hiring_insights.media, "確認できず");
  assert.equal(checked.pain_hypotheses[0].source_url, "");
  assert.equal(checked.pain_hypotheses[0].confidence, "low");
  assert.throws(() => grounding.extractVertexGrounding("本文", { groundingChunks: [{ web: { uri: "https://example.test" } }] }), /表示情報/);
});
test("expired verification policy is blocked before any AI request", async () => {
  const policy = await load("src/lib/ai/vertex-policy.ts");
  // Extended on 2026-09-28 until 2026-10-20 00:00 JST (then the day before gemini-2.5-flash was scheduled to retire);
  // kept after the switch to gemini-3.5-flash-lite.
  // Extended again on 2026-10-19 for the Vercel verification preview: until 2026-11-01 00:00 JST (end of October).
  assert.ok(policy.vertexConfiguration(env, Date.parse("2026-10-31T14:59:59Z")));
  assert.throws(() => policy.vertexConfiguration(env, Date.parse("2026-10-31T15:00:00Z")), /利用期間/);
});
test("Vercel の検証用 Preview でも同じ Vertex 経路を使え、Production とそれ以外の実行先では使えない", async () => {
  const policy = await load("src/lib/ai/vertex-policy.ts");
  const at = Date.parse("2026-10-19T14:59:59Z");
  const { K_SERVICE: _cloudRun, ...vercelBase } = env;
  const preview = { ...vercelBase, VERCEL: "1", VERCEL_ENV: "preview" };
  assert.deepEqual(policy.vertexConfiguration(preview, at), policy.vertexConfiguration(env, at));
  for (const host of [{ ...vercelBase, VERCEL: "1", VERCEL_ENV: "production" }, { ...vercelBase, VERCEL: "1" }, vercelBase,
    { ...preview, K_SERVICE: "sales-agent" }, { ...preview, LUMA_DEPLOYMENT_ENV: "production" }]) {
    assert.throws(() => policy.vertexConfiguration(host, at), /設定/);
  }
});
test("利用期間は LUMA_VERTEX_POLICY_EXPIRES で延長でき、読めない値は期限切れとして止める", async () => {
  const policy = await load("src/lib/ai/vertex-policy.ts");
  const extended = { ...env, LUMA_VERTEX_POLICY_EXPIRES: "2026-11-30T15:00:00.000Z" };
  assert.ok(policy.vertexConfiguration(extended, Date.parse("2026-11-30T14:59:59Z")));
  assert.throws(() => policy.vertexConfiguration(extended, Date.parse("2026-11-30T15:00:00Z")), /利用期間/);
  assert.throws(() => policy.vertexConfiguration({ ...env, LUMA_VERTEX_POLICY_EXPIRES: "not-a-date" }, Date.parse("2026-10-01T00:00:00Z")), /利用期間/);
});
