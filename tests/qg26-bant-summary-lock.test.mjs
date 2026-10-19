import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

// QG26-03: AI再集約（POST /api/deals/[id]/summarize-bant）を2タブで同時に押しても、
// AI（summarizeDealBant）は1回だけ。2本目は AI を呼ばずに 409。
// 処理中の印は期限付きで、失敗しても・期限が切れても残り続けない。
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));
const MINUTE = 60 * 1000;

function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (condition.gte !== undefined && !(value >= condition.gte)) return false;
      if (condition.lt !== undefined && !(value < condition.lt)) return false;
      return true;
    }
    return value === condition;
  });
}

async function loadRoute({ logs = [], failSummary = false } = {}) {
  const queues = new Map();
  const m = {
    logs, summaries: [], held: [], lockKeys: [], failSummary,
    prisma: {
      user: { findUnique: async () => ({ permission: "user" }) },
      deal: { findUnique: async () => ({ id: "deal-1", deletedAt: null, company: { deletedAt: null } }) },
      aiLog: {
        findFirst: async ({ where }) => {
          await yieldTick();
          return logs.filter((row) => matches(row, where)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
        },
        create: async ({ data }) => {
          await yieldTick();
          const row = { id: `log-${logs.length + 1}`, createdAt: new Date(), ...data };
          logs.push(row);
          return row;
        },
        deleteMany: async ({ where }) => {
          await yieldTick();
          const removed = logs.filter((row) => matches(row, where));
          for (const row of removed) logs.splice(logs.indexOf(row), 1);
          return { count: removed.length };
        },
      },
    },
  };
  m.prisma.$transaction = async (fn) => {
    const releases = [];
    const tx = {
      ...m.prisma,
      $executeRaw: async (strings, ...values) => {
        if (strings.join("$").includes("pg_advisory_xact_lock")) {
          const key = values.join("|");
          m.lockKeys.push(key);
          const previous = queues.get(key) ?? Promise.resolve();
          let release;
          const current = new Promise((resolve) => { release = resolve; });
          queues.set(key, previous.then(() => current));
          await previous;
          releases.push(release);
        }
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  const route = await offlineModule("src/app/api/deals/[id]/summarize-bant/route.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>({userId:'demo'});export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='user';",
    "@/lib/ai/summarize-bant": `export const summarizeDealBant=async(dealId,options)=>{
      mocks.summaries.push({dealId,options});
      await new Promise(r=>mocks.held.push(r));
      if(mocks.failSummary) throw Error('AI failed');
      return {bant:{summary:'集約済み'},fallback:false};
    };`,
  }, ["src/app/api/deals/[id]/summarize-bant/route.ts", "src/lib/ai/bant-summary-lock.ts"]);
  return { route, m };
}

const params = { params: Promise.resolve({ id: "deal-1" }) };
const post = (route) => route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
async function finishHeld(m) {
  for (let i = 0; i < 50 && m.held.length === 0; i++) await yieldTick();
  for (const resume of m.held.splice(0)) resume();
}

test("QG26-03 two simultaneous AI再集約 requests call the AI once; the second gets 409 without an AI call", async () => {
  const { route, m } = await loadRoute();
  const first = post(route);
  const second = post(route);
  // The second request is answered while the first is still waiting for the AI.
  for (let i = 0; i < 50; i++) await yieldTick();
  await finishHeld(m);
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const conflict = [a, b].find((response) => response.status === 409);
  assert.match((await conflict.json()).error, /AI再集約が処理中/);
  assert.equal(m.summaries.length, 1);
  assert.equal(m.summaries[0].options.trigger, "manual_button");
  assert.ok(m.lockKeys.length >= 2 && m.lockKeys.every((key) => key.includes("deal-1")));
  // The in-flight marker is removed when the run ends, so the next press runs again.
  assert.equal(m.logs.length, 0);
  const again = post(route);
  await finishHeld(m);
  assert.equal((await again).status, 200);
  assert.equal(m.summaries.length, 2);
});

test("QG26-03 a failed run releases the marker, and an expired marker does not block", async () => {
  const failing = await loadRoute({ failSummary: true });
  const failed = post(failing.route);
  await finishHeld(failing.m);
  assert.equal((await failed).status, 500);
  assert.equal(failing.m.logs.length, 0, "marker released after a failure");

  // A marker left by a crashed instance expires; it is cleaned up and the run proceeds.
  const stale = { id: "stale", dealId: "deal-1", step: "bant_summary_in_flight", createdAt: new Date(Date.now() - 30 * MINUTE), input: {}, output: {} };
  const { route, m } = await loadRoute({ logs: [stale] });
  const response = post(route);
  await finishHeld(m);
  assert.equal((await response).status, 200);
  assert.equal(m.summaries.length, 1);
  assert.ok(!m.logs.some((row) => row.id === "stale"));

  // A recent marker (another tab still running) blocks without calling the AI.
  const running = { id: "running", dealId: "deal-1", step: "bant_summary_in_flight", createdAt: new Date(Date.now() - 20 * 1000), input: {}, output: {} };
  const blocked = await loadRoute({ logs: [running] });
  assert.equal((await post(blocked.route)).status, 409);
  assert.equal(blocked.m.summaries.length, 0);
  assert.deepEqual(blocked.m.logs.map((row) => row.id), ["running"]);
});

// S-4: 会議後の自動集約（scheduleDealBantSummary）も同じ印を使う。実行中の集約があれば
// 終わるまで待ち、その後に入力の指紋で判断する（同じ入力ならAIを呼ばず、新しい会議が
// 増えていれば集約し直す）。待つだけなので、新しい会議の内容が反映されない経路はない。
async function loadAggregate({ meetings }) {
  const logs = [];
  const queues = new Map();
  const m = {
    logs, aiCalls: [], held: [], holdAi: false,
    deal: {
      id: "deal-1", title: "架空の商談", status: "HEARING", bant: null, bantUpdatedAt: null,
      company: { name: "架空株式会社", industry: null }, products: [], meetings,
    },
    generate: async () => {
      m.aiCalls.push(m.deal.meetings.map((meeting) => meeting.id));
      if (m.holdAi) await new Promise((resolve) => m.held.push(resolve));
      return { parsed: { summary: "架空の集約" }, usedFallback: false };
    },
  };
  m.prisma = {
    deal: {
      findUnique: async () => { await yieldTick(); return structuredClone(m.deal); },
      update: async ({ data }) => { await yieldTick(); Object.assign(m.deal, data); return m.deal; },
    },
    aiLog: {
      findFirst: async ({ where }) => {
        await yieldTick();
        return logs.filter((row) => matches(row, where)).sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)[0] ?? null;
      },
      create: async ({ data }) => {
        await yieldTick();
        const row = { id: `log-${logs.length + 1}`, seq: logs.length, createdAt: new Date(), ...data };
        logs.push(row);
        return row;
      },
      deleteMany: async ({ where }) => {
        await yieldTick();
        const removed = logs.filter((row) => matches(row, where));
        for (const row of removed) logs.splice(logs.indexOf(row), 1);
        return { count: removed.length };
      },
    },
  };
  m.prisma.$transaction = async (fn) => {
    const releases = [];
    const tx = {
      ...m.prisma,
      $executeRaw: async (strings, ...values) => {
        if (strings.join("$").includes("pg_advisory_xact_lock")) {
          const key = values.join("|");
          const previous = queues.get(key) ?? Promise.resolve();
          let release;
          const current = new Promise((resolve) => { release = resolve; });
          queues.set(key, previous.then(() => current));
          await previous;
          releases.push(release);
        }
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  const aggregate = await offlineModule("src/lib/ai/summarize-bant.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/ai/anthropic": "export const callClaudeHeavyJSON=(...a)=>mocks.generate(...a);export const buildSystemText=({system})=>system;",
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=>'vertex';",
    "@/lib/ai/luma-context": "export const getLumaContextText=async()=>'';export const getCachedLumaContextText=()=>'';export const formatLumaContextForPrompt=x=>x;",
    "next/server": "export const after=()=>{throw Error('Unexpected scheduling')};",
  }, ["src/lib/ai/summarize-bant.ts", "src/lib/ai/bant-summary-lock.ts", "src/components/deals/bant-summary-utils.ts",
    ...["bant-definitions", "bant-withdrawal", "bant-reconciliation", "timeline-evidence", "customer-conditions", "offer-evidence", "vertex-policy"].map((name) => `src/lib/ai/${name}.ts`)]);
  const lock = await offlineModule("src/lib/ai/bant-summary-lock.ts", m, { "@/lib/db": "export const prisma=mocks.prisma;" });
  return { aggregate, lock, m };
}
const meetingRow = (id) => ({
  id, title: `架空の会議${id}`, meetingDate: new Date("2026-09-30T00:00:00Z"), minutes: `${id}の議事録`, minutesJson: null,
  transcript: null, sourceType: "manual_text", bantBudget: null, bantAuthority: null, bantNeed: null, bantTimeline: null,
});
async function waitFor(condition) {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "timed out");
}

test("S-4 the automatic aggregation waits for a running manual one and does not call the AI again for the same input", async () => {
  const { aggregate, lock, m } = await loadAggregate({ meetings: [meetingRow("m1")] });
  m.holdAi = true;
  // 手動ボタンの route と同じ手順（印を取って集約し、終わったら消す）。
  const lease = await lock.acquireBantSummaryLock("deal-1", "manual_button");
  const manual = aggregate.summarizeDealBant("deal-1", { trigger: "manual_button" })
    .finally(() => lock.releaseBantSummaryLock(lease));
  const auto = aggregate.scheduleDealBantSummary("deal-1", "meeting_analyze_completed");
  await waitFor(() => m.held.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(m.aiCalls.length, 1, "the automatic run is waiting, not calling the AI");
  m.holdAi = false;
  m.held.splice(0).forEach((resume) => resume());
  await manual;
  await auto;
  assert.equal(m.aiCalls.length, 1, "same input: skipped after the manual run");
  assert.ok(m.logs.some((row) => row.step === "bant_summary_skipped"));
  assert.ok(!m.logs.some((row) => row.step === "bant_summary_in_flight"), "every marker released");
});

test("S-4 a meeting added during a running aggregation is aggregated afterwards, and simultaneous automatic runs call the AI once", async () => {
  const { aggregate, lock, m } = await loadAggregate({ meetings: [meetingRow("m1")] });
  m.holdAi = true;
  const lease = await lock.acquireBantSummaryLock("deal-1", "manual_button");
  const manual = aggregate.summarizeDealBant("deal-1", { trigger: "manual_button" })
    .finally(() => lock.releaseBantSummaryLock(lease));
  await waitFor(() => m.held.length === 1);
  // 実行中に新しい会議が保存され、その分析の後の自動集約が2本（分析・議事録保存）同時に来る。
  m.deal.meetings = [meetingRow("m2"), meetingRow("m1")];
  const autos = [
    aggregate.scheduleDealBantSummary("deal-1", "meeting_analyze_completed"),
    aggregate.scheduleDealBantSummary("deal-1", "meeting_minutes_saved"),
  ];
  m.holdAi = false;
  m.held.splice(0).forEach((resume) => resume());
  await manual;
  await Promise.all(autos);
  assert.deepEqual(m.aiCalls, [["m1"], ["m2", "m1"]], "the new meeting is aggregated once, after the running one");
  assert.ok(!m.logs.some((row) => row.step === "bant_summary_in_flight"), "every marker released");
});
