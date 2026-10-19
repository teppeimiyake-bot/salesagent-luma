import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";
test("T09 legacy and V2 generation both require edit permission before AI calls",async()=>{
 for(const flag of [false,true]) for(const permission of [null,"viewer"]){
  const m={flag,permission,prisma:{user:{findUnique:async()=>({permission})}}};
  const route=await offlineModule("src/app/api/deals/[id]/preparation/route.ts",m,{
   "@/lib/db":"export const prisma=mocks.prisma;",
   "@/lib/auth":"export const getSession=async()=>mocks.permission?{userId:'demo'}:null;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='user';",
   "@/lib/feature-flags":"export const isPreparationV2Enabled=()=>mocks.flag;",
   "@/lib/ai/anthropic":"export const callClaudeJSON=()=>{throw Error('no AI allowed')};",
   "@/lib/ai/text-style":"export const JP_TEXT_STYLE_RULE='';export const JP_JSON_TEXT_STYLE_RULE='';",
   "@/lib/ai/luma-context":"export const formatLumaContextForPrompt=()=>'';export const getLumaContextText=()=>'';",
   "@/lib/ai/preparation":"export const PREPARATION_DISCLAIMER='';export const canCreatePreparationBrief=()=>true;export const runPreparationBrief=()=>{throw Error('no AI allowed')};",
   "@/lib/preparation-cron":"export const getTokyoDayRange=()=>({});",
  });
  const r=await route.POST(new Request("http://offline.invalid"),{params:Promise.resolve({id:"deal"})});assert.equal(r.status,permission?403:401);
 }
});

const MINUTE = 60 * 1000;
const preparationHelpers = await offlineModule("src/lib/ai/preparation.ts", {}, {
  "./vertex-grounding": "export const vertexPreparation=()=>{throw Error('AI forbidden')};export const preparationFormattingWorstCaseBytes=()=>0;",
  "@/lib/ai/anthropic": "export const callClaudeHeavyJSONWithTools=()=>{throw Error('AI forbidden')};export const formatAnthropicDebug=()=>'';export const getAnthropicModelName=()=>'';",
  "@/lib/ai/provider": "export const getHeavyTextProvider=()=>'vertex';export const hasAnthropicKey=()=>false;",
  "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=x=>x;export const getLumaContextText=async()=>'';",
  "@/lib/db": "export const prisma=new Proxy({}, {get(){throw Error('DB access forbidden')}});",
}, ["src/lib/ai/preparation.ts", "src/lib/ai/bant-definitions.ts", "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/vertex-policy.ts"]);

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (condition.in && !condition.in.includes(value)) return false;
      if ("not" in condition && value === condition.not) return false;
      if (condition.lt !== undefined && !(value < condition.lt)) return false;
      if (condition.gte !== undefined && !(value >= condition.gte)) return false;
      return true;
    }
    return value === condition;
  });
}

function briefRow(id, status, ageMs) {
  return {
    id, dealId: "deal", status, error: null, industrySummary: null, hiringInsights: null, painHypotheses: null,
    proposalStory: null, talkingPoints: null, sources: null, model: null, createdById: "demo",
    createdAt: new Date(Date.now() - ageMs),
  };
}

// A Postgres advisory transaction lock as the mock DB sees it: a second holder of
// the same key waits until the first transaction ends. Every DB call yields, so two
// requests interleave the way two Cloud Run requests do.
function advisoryLocks() {
  const queues = new Map();
  const keys = [];
  return {
    keys,
    async acquire(key) {
      keys.push(key);
      const previous = queues.get(key) ?? Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      queues.set(key, previous.then(() => current));
      await previous;
      return release;
    },
  };
}
const yieldTick = () => new Promise((resolve) => setImmediate(resolve));

async function loadV2Route(rows, { refuseRecovery = false, permission = "user", signedIn = true, userExists = true, holdRuns = false } = {}) {
  const newest = (where) => rows.filter((row) => matchesWhere(row, where)).sort((a, b) => b.createdAt - a.createdAt);
  const locks = advisoryLocks();
  const m = {
    rows, recoveries: [], runs: [], signedIn, locks, heldRuns: [], holdRuns,
    prisma: {
      user: { findUnique: async () => (userExists ? { permission } : null) },
      deal: { findUnique: async () => ({ id: "deal", deletedAt: null, company: { deletedAt: null } }) },
      preparationBrief: {
        updateMany: async ({ where, data }) => {
          m.recoveries.push({ where, data });
          if (refuseRecovery) throw Error("全社統合ビューでは書き込みできません");
          const matched = rows.filter((row) => matchesWhere(row, where));
          for (const row of matched) Object.assign(row, data);
          return { count: matched.length };
        },
        findMany: async ({ where }) => newest(where),
        findFirst: async ({ where }) => { await yieldTick(); return newest(where)[0] ?? null; },
        count: async ({ where }) => { await yieldTick(); return rows.filter((row) => matchesWhere(row, where)).length; },
        create: async ({ data }) => {
          await yieldTick();
          const row = { ...briefRow(`brief-${rows.length + 1}`, "pending", 0), ...data };
          rows.push(row);
          return row;
        },
        findUnique: async ({ where }) => rows.find((row) => row.id === where.id) ?? null,
      },
    },
  };
  // Interactive transaction: the same client plus $executeRaw; advisory locks end with it.
  m.prisma.$transaction = async (fn) => {
    const releases = [];
    const tx = {
      ...m.prisma,
      $executeRaw: async (strings, ...values) => {
        const sql = strings.join("$");
        if (sql.includes("pg_advisory_xact_lock")) releases.push(await locks.acquire(values.join("|")));
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  };
  const route = await offlineModule("src/app/api/deals/[id]/preparation/route.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    // Same ranking as hasPermission in src/lib/auth.ts (a missing permission counts as viewer).
    "@/lib/auth": "export const getSession=async()=>mocks.signedIn?{userId:'demo'}:null;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};const rank={viewer:1,user:2,admin:3};export const hasPermission=(p,required)=>(rank[p??'viewer']??0)>=rank[required];",
    "@/lib/feature-flags": "export const isPreparationV2Enabled=()=>true;",
    "@/lib/ai/anthropic": "export const callClaudeJSON=()=>{throw Error('no AI allowed')};",
    "@/lib/ai/text-style": "export const JP_TEXT_STYLE_RULE='';export const JP_JSON_TEXT_STYLE_RULE='';",
    "@/lib/ai/luma-context": "export const formatLumaContextForPrompt=()=>'';export const getLumaContextText=()=>'';",
    "@/lib/ai/preparation": "export const PREPARATION_DISCLAIMER='';export const canCreatePreparationBrief=({createdToday,isAdmin,limit})=>isAdmin||createdToday<limit;export const runPreparationBrief=async(id,dealId)=>{mocks.runs.push({id,dealId});if(mocks.holdRuns)await new Promise(r=>mocks.heldRuns.push(r));};",
    // The day range is not under test; every seeded brief counts as today.
    "@/lib/preparation-cron": "export const getTokyoDayRange=()=>({});",
  });
  return { route, m };
}

const params = { params: Promise.resolve({ id: "deal" }) };

test("T09 GET marks briefs unfinished after 10 minutes as interrupted and leaves recent or finished briefs alone", async () => {
  const rows = [
    briefRow("stale-researching", "researching", 11 * MINUTE),
    briefRow("stale-pending", "pending", 30 * MINUTE),
    briefRow("recent-generating", "generating", 9 * MINUTE),
    briefRow("finished", "done", 24 * 60 * MINUTE),
  ];
  const { route, m } = await loadV2Route(rows);
  const latest = await (await route.GET(new Request("http://offline.invalid"), params)).json();
  assert.equal(latest.brief.id, "recent-generating");
  assert.equal(latest.brief.status, "generating");
  assert.equal(latest.brief.interrupted, false);
  const history = await (await route.GET(new Request("http://offline.invalid?history=1"), params)).json();
  const byId = Object.fromEntries(history.briefs.map((brief) => [brief.id, brief]));
  for (const id of ["stale-researching", "stale-pending"]) {
    assert.equal(byId[id].status, "error");
    assert.equal(byId[id].error, preparationHelpers.PREPARATION_INTERRUPTED_MESSAGE);
  }
  // Once the recovery write has landed, nothing is left for the panel to reinterpret.
  assert.ok(history.briefs.every((brief) => brief.interrupted === false));
  assert.equal(byId["recent-generating"].status, "generating");
  assert.equal(byId.finished.status, "done");
  assert.equal(byId.finished.error, null);
  assert.equal(m.recoveries[0].where.dealId, "deal");
  assert.deepEqual(Array.from(m.recoveries[0].where.status.in), ["pending", "researching", "generating"]);
  // The route keeps the shared threshold locally; both agree at the boundary.
  for (const row of rows) {
    const interrupted = row.id.startsWith("stale-");
    assert.equal(preparationHelpers.isInterruptedPreparationBrief({ status: interrupted ? "researching" : row.status, createdAt: row.createdAt }), interrupted);
  }
  assert.equal(preparationHelpers.PREPARATION_STALE_AFTER_MS, 10 * MINUTE);
  assert.equal(m.runs.length, 0);
});

test("T09 POST recovers interrupted briefs before the daily limit but still limits active briefs", async () => {
  const stale = [1, 2, 3].map((i) => briefRow(`stale-${i}`, "researching", (10 + i) * MINUTE));
  const { route, m } = await loadV2Route([...stale]);
  const accepted = await route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
  assert.equal(accepted.status, 202);
  assert.deepEqual(m.runs.map((run) => run.dealId), ["deal"]);
  for (const row of stale) {
    assert.equal(row.status, "error");
    assert.equal(row.error, preparationHelpers.PREPARATION_INTERRUPTED_MESSAGE);
  }

  const active = [1, 2, 3].map((i) => briefRow(`active-${i}`, "researching", i * MINUTE));
  const limited = await loadV2Route([...active]);
  const refused = await limited.route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
  assert.equal(refused.status, 429);
  assert.ok(active.every((row) => row.status === "researching"));
  assert.equal(limited.m.runs.length, 0);
});

test("QG26-04 two simultaneous POSTs create one brief and one generation; the second gets the running brief", async () => {
  for (const permission of ["user", "admin"]) {
    const rows = [];
    // holdRuns: the inline generation (Cloud Run) is still running when the second tab posts.
    const { route, m } = await loadV2Route(rows, { permission, holdRuns: true });
    const post = () => route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
    const first = post();
    const second = post();
    // Let both requests reach the generation (or the in-progress answer) before finishing it.
    for (let i = 0; i < 50 && m.heldRuns.length < 1; i++) await yieldTick();
    for (let i = 0; i < 20; i++) await yieldTick();
    for (const resume of m.heldRuns.splice(0)) resume();
    const answers = await Promise.all([first, second]);
    for (let i = 0; i < 20; i++) await yieldTick();
    for (const resume of m.heldRuns.splice(0)) resume();
    assert.equal(rows.length, 1, `${permission}: one brief`);
    assert.equal(m.runs.length, 1, `${permission}: one AI generation`);
    const bodies = await Promise.all(answers.map((response) => response.json()));
    assert.deepEqual(answers.map((response) => response.status), [202, 202], permission);
    assert.deepEqual(bodies.map((body) => body.brief.id), [rows[0].id, rows[0].id], permission);
    assert.equal(bodies.filter((body) => body.in_progress === true).length, 1, permission);
    // The check and the creation run under one advisory lock per deal.
    assert.ok(m.locks.keys.length >= 2 && m.locks.keys.every((key) => key.includes("deal")), permission);
  }
});

test("QG26-04 a POST while a brief is still in progress returns that brief without creating or generating", async () => {
  for (const permission of ["user", "admin"]) {
    const rows = [briefRow("running", "generating", 2 * MINUTE), briefRow("finished", "done", 60 * MINUTE)];
    const { route, m } = await loadV2Route(rows, { permission });
    const response = await route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
    assert.equal(response.status, 202, permission);
    const body = await response.json();
    assert.equal(body.brief.id, "running", permission);
    assert.equal(body.in_progress, true, permission);
    assert.equal(body.accepted, false, permission);
    assert.equal(rows.length, 2, permission);
    assert.equal(m.runs.length, 0, permission);
  }
  // An interrupted (10 minutes+) brief is recovered first and does not block a new one.
  const rows = [briefRow("stuck", "researching", 11 * MINUTE)];
  const { route, m } = await loadV2Route(rows);
  const response = await route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
  assert.equal(response.status, 202);
  assert.equal(rows.length, 2);
  assert.equal(m.runs.length, 1);
  assert.equal(rows[0].status, "error");
});

test("T09 GET still answers when the recovery write is refused and flags the stale brief with the server clock", async () => {
  const { route, m } = await loadV2Route([
    briefRow("stale", "researching", 20 * MINUTE),
    briefRow("recent", "generating", 9 * MINUTE),
    briefRow("finished", "done", 60 * MINUTE),
  ], { refuseRecovery: true });
  const response = await route.GET(new Request("http://offline.invalid"), params);
  assert.equal(response.status, 200);
  const latest = (await response.json()).brief;
  assert.equal(latest.id, "recent");
  assert.equal(latest.status, "generating");
  assert.equal(latest.interrupted, false);
  const history = await (await route.GET(new Request("http://offline.invalid?history=1"), params)).json();
  const byId = Object.fromEntries(history.briefs.map((brief) => [brief.id, brief]));
  // The write was refused, so the status is unchanged but the panel is told it was interrupted.
  assert.equal(byId.stale.status, "researching");
  assert.equal(byId.stale.error, null);
  assert.equal(byId.stale.interrupted, true);
  assert.equal(byId.finished.interrupted, false);
  assert.equal(m.recoveries.length, 2);
});

test("T09 viewers read saved briefs but only user or above writes, including the interrupted-brief recovery", async () => {
  const seed = () => [
    briefRow("stale", "researching", 20 * MINUTE),
    briefRow("finished", "done", 60 * MINUTE),
  ];
  const viewerRows = seed();
  const viewer = await loadV2Route(viewerRows, { permission: "viewer" });
  const latestResponse = await viewer.route.GET(new Request("http://offline.invalid"), params);
  assert.equal(latestResponse.status, 200);
  const latest = await latestResponse.json();
  assert.equal(latest.can_create, false);
  // No recovery write for a viewer; the stale brief is still reported with the server clock.
  assert.equal(latest.brief.id, "stale");
  assert.equal(latest.brief.status, "researching");
  assert.equal(latest.brief.interrupted, true);
  const historyResponse = await viewer.route.GET(new Request("http://offline.invalid?history=1"), params);
  assert.equal(historyResponse.status, 200);
  assert.deepEqual((await historyResponse.json()).briefs.map((brief) => [brief.id, brief.interrupted]), [["stale", true], ["finished", false]]);
  const refused = await viewer.route.POST(new Request("http://offline.invalid", { method: "POST" }), params);
  assert.equal(refused.status, 403);
  assert.equal(viewer.m.recoveries.length, 0);
  assert.equal(viewer.m.runs.length, 0);
  assert.deepEqual(viewerRows.map((row) => [row.id, row.status]), [["stale", "researching"], ["finished", "done"]]);

  for (const permission of ["user", "admin"]) {
    const rows = seed();
    const member = await loadV2Route(rows, { permission });
    const body = await (await member.route.GET(new Request("http://offline.invalid"), params)).json();
    assert.equal(body.can_create, true, permission);
    assert.equal(body.brief.id, "stale", permission);
    assert.equal(body.brief.status, "error", permission);
    assert.equal(member.m.recoveries.length, 1, permission);
  }

  for (const [options, status] of [
    [{ signedIn: false }, 401],
    [{ userExists: false }, 403],
    [{ permission: "guest" }, 403],
  ]) {
    const denied = await loadV2Route(seed(), options);
    const response = await denied.route.GET(new Request("http://offline.invalid"), params);
    assert.equal(response.status, status, JSON.stringify(options));
    assert.equal(denied.m.recoveries.length, 0, JSON.stringify(options));
  }
});

async function loadCronRoute(dealsByTenant, { secondsPerBrief = 0, refuseRecovery = false } = {}) {
  const m = {
    tenant: null, runs: [], created: [], recoveries: [], clock: null,
    prep: preparationHelpers,
    run: async (id, dealId) => {
      m.runs.push({ id, dealId, tenant: m.tenant });
      if (m.clock !== null) m.clock += secondsPerBrief * 1000;
    },
    prismaUnscoped: { tenant: { findMany: async () => Object.keys(dealsByTenant).map((code) => ({ code })) } },
    prisma: {
      deal: { findMany: async () => dealsByTenant[m.tenant] },
      preparationBrief: {
        create: async ({ data }) => {
          const row = { id: `new-${m.created.length + 1}`, ...data };
          m.created.push({ ...row, tenant: m.tenant });
          return row;
        },
        updateMany: async (args) => {
          m.recoveries.push({ ...args, tenant: m.tenant });
          if (refuseRecovery) throw Error("transient DB error");
          return { count: args.where.id.in.length };
        },
      },
    },
  };
  const route = await offlineModule("src/app/api/cron/preparation-briefs/route.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;export const prismaUnscoped=mocks.prismaUnscoped;",
    "@/lib/agent-auth": "export const isValidCronSecret=()=>true;",
    "@/lib/feature-flags": "export const isPreparationCronEnabled=()=>true;export const isPreparationV2Enabled=()=>true;",
    "@/lib/ai/preparation": "export const runPreparationBrief=(...args)=>mocks.run(...args);export const PREPARATION_INTERRUPTED_MESSAGE=mocks.prep.PREPARATION_INTERRUPTED_MESSAGE;export const isInterruptedPreparationBrief=(...args)=>mocks.prep.isInterruptedPreparationBrief(...args);",
    "@/lib/tenant-context": "export const runAsTenant=async(code,fn)=>{mocks.tenant=code;return await fn();};",
  }, ["src/app/api/cron/preparation-briefs/route.ts", "src/lib/preparation-cron.ts"]);
  return { route, m };
}

// Always inside tomorrow's JST day: now is within today, so now + 24h is within tomorrow.
const tomorrowMeeting = () => new Date(Date.now() + 24 * 60 * MINUTE);
const cronDeal = (id, briefs = []) => ({ id, deletedAt: null, meetingStartAt: tomorrowMeeting(), preparationBriefs: briefs });

test("T10 cron stops starting new deals after about 150 seconds and reports the skipped deals", async () => {
  const { route, m } = await loadCronRoute({
    luma: ["d1", "d2", "d3", "d4"].map((id) => cronDeal(id)),
    second: ["s1", "s2"].map((id) => cronDeal(id)),
  }, { secondsPerBrief: 60 });
  const realNow = Date.now;
  m.clock = realNow();
  Date.now = () => m.clock;
  let body;
  try {
    body = await (await route.GET(new Request("http://offline.invalid/api/cron/preparation-briefs"))).json();
  } finally {
    Date.now = realNow;
  }
  // Starts at 0s, 60s and 120s; the fourth deal would start at 180s.
  assert.deepEqual(m.runs.map((run) => run.dealId), ["d1", "d2", "d3"]);
  assert.deepEqual(body, {
    skipped: false,
    created: 3,
    skippedForTimeBudget: 3,
    tenants: [
      { tenant: "luma", selected: 4, created: 3, skippedForTimeBudget: 1 },
      { tenant: "second", selected: 2, created: 0, skippedForTimeBudget: 2 },
    ],
  });
});

test("T10 cron treats an interrupted brief as an error instead of an in-progress block", async () => {
  const eightDays = 8 * 24 * 60 * MINUTE;
  const { route, m } = await loadCronRoute({
    luma: [
      cronDeal("stuck", [{ id: "stuck-brief", status: "researching", createdAt: new Date(Date.now() - eightDays) }]),
      cronDeal("running", [{ id: "running-brief", status: "generating", createdAt: new Date(Date.now() - 5 * MINUTE) }]),
    ],
  });
  const body = await (await route.POST(new Request("http://offline.invalid/api/cron/preparation-briefs", { method: "POST" }))).json();
  assert.equal(m.recoveries.length, 1);
  assert.deepEqual(Array.from(m.recoveries[0].where.id.in), ["stuck-brief"]);
  assert.deepEqual(Array.from(m.recoveries[0].where.status.in), ["pending", "researching", "generating"]);
  assert.deepEqual({ ...m.recoveries[0].data }, { status: "error", error: preparationHelpers.PREPARATION_INTERRUPTED_MESSAGE });
  assert.deepEqual(m.runs.map((run) => run.dealId), ["stuck"]);
  assert.equal(body.created, 1);
  assert.equal(body.skippedForTimeBudget, 0);
});

test("T10 cron keeps creating briefs for every tenant when the interrupted-brief cleanup write fails", async () => {
  const eightDays = 8 * 24 * 60 * MINUTE;
  const stuck = (id) => cronDeal(id, [{ id: `${id}-brief`, status: "researching", createdAt: new Date(Date.now() - eightDays) }]);
  const { route, m } = await loadCronRoute({ luma: [stuck("stuck")], second: [stuck("other")] }, { refuseRecovery: true });
  const response = await route.GET(new Request("http://offline.invalid/api/cron/preparation-briefs"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(m.recoveries.map((recovery) => recovery.tenant), ["luma", "second"]);
  assert.deepEqual(m.runs.map((run) => [run.tenant, run.dealId]), [["luma", "stuck"], ["second", "other"]]);
  assert.equal(body.created, 2);
});
