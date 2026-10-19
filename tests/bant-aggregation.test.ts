import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import type { DealForBant } from "../src/lib/ai/summarize-bant";
import { resolveBantCardView } from "../src/components/deals/bant-summary-utils";
import { BANT_UNKNOWN_VALUES } from "../src/lib/ai/bant-definitions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRequire = createRequire(import.meta.url);
const moduleFiles = {
  aggregate: "src/lib/ai/summarize-bant.ts",
  route: "src/app/api/deals/[id]/route.ts",
};
const allowedFiles = new Set([
  ...Object.values(moduleFiles),
  "src/lib/ai/bant-withdrawal.ts", "src/lib/ai/bant-reconciliation.ts", "src/lib/ai/timeline-evidence.ts", "src/lib/ai/customer-conditions.ts", "src/lib/ai/offer-evidence.ts", "src/lib/ai/bant-definitions.ts",
  "src/lib/ai/vertex-policy.ts",
  "src/components/deals/bant-summary-utils.ts", "src/lib/meeting-datetime.ts",
  "src/lib/meetings/meeting-owner.ts",
].map(file => path.join(root, file)));
const mocks: Record<string, string> = {
  "@/lib/db": "export const prisma = globalThis.mocks.prisma;",
  "@/lib/ai/anthropic": `
    export const callClaudeHeavyJSON = globalThis.mocks.generate;
    export const buildSystemText = ({ system, cacheableSystem }) => cacheableSystem?.trim() ? cacheableSystem.trim() + "\\n\\n" + system : system;`,
  // 入力の上限で縮める経路（Vertex）でも、上限内のプロンプトは変わらないことを確かめる。
  "@/lib/ai/provider": "export const getHeavyTextProvider = () => 'vertex';",
  "@/lib/ai/luma-context": `
    export const getLumaContextText = async () => 'デモ商材';
    export const getCachedLumaContextText = () => 'デモ商材';
    export const formatLumaContextForPrompt = value => value;`,
  "next/server": `
    export const after = () => { throw new Error('Unexpected scheduling'); };
    export const NextResponse = { json: (data, init) => Response.json(data, init) };`,
  "@/lib/auth": `
    export const getCurrentPermission = async () => 'user';
    export const hasPermission = () => true;`,
  // 書き込みの 403 の文言（src/lib/write-guard.ts）。ここでは権限は通るので呼ばれない。
  "@/lib/write-guard": `
    export const writeForbidden = async () => Response.json({ error: '閲覧のみの権限では、この操作はできません。' }, { status: 403 });
    export const requireWriter = async () => null;`,
  "@/lib/notion-sync": "export const syncDealAppointmentDateToNotion = () => { throw new Error('Notion forbidden'); };",
  "@/lib/deal-title": "export const buildDealTitle = () => null;",
  // QG26 S-4: 集約中の印（DB の advisory lock）は tests/qg26-bant-summary-lock.test.mjs で確かめる。
  "@/lib/ai/bant-summary-lock": 'export const waitForBantSummaryLock=async()=>({id:"lease"});export const acquireBantSummaryLock=async()=>({id:"lease"});export const releaseBantSummaryLock=async()=>{};',
  "@prisma/client": `export const DealStatus = Object.fromEntries(
    ['LEAD','HEARING','PROPOSAL','NEGOTIATION','CLOSING','WON','LOST'].map(x => [x,x]));`,
};

const bundles = new Map<string, Promise<string>>();
function bundle(kind: keyof typeof moduleFiles) {
  const entry = path.join(root, moduleFiles[kind]);
  if (!bundles.has(kind)) bundles.set(kind, build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    format: "cjs", platform: "node", tsconfigRaw: { compilerOptions: {} },
    plugins: [{ name: "offline-only", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.path in mocks) return { path: args.path, namespace: "mock" };
        if (["node:crypto", "zod"].includes(args.path)) return { path: args.path, external: true };
        let resolved = args.path.startsWith("@/")
          ? path.join(root, "src", args.path.slice(2))
          : path.resolve(args.resolveDir || root, args.path);
        if (!resolved.endsWith(".ts")) resolved += ".ts";
        if (!allowedFiles.has(resolved)) throw new Error(`Forbidden dependency: ${args.path}`);
        return { path: resolved };
      });
      builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  }).then(result => result.outputFiles[0].text));
  return bundles.get(kind)!;
}

function fixture(): DealForBant & { deletedAt: null } {
  return {
    id: "demo-deal", title: "架空企業の採用商談", status: "PROPOSAL", deletedAt: null,
    bant: { budget: "未確定: 予算", authority: "未確定: 決裁", need: "未確認: 課題", timeline: "未確定: 日程" },
    bantUpdatedAt: null, company: { name: "デモ会社", industry: "食品" }, products: [],
    meetings: [{
      id: "demo-meeting", title: "デモ商談", meetingDate: new Date("2026-08-30T01:00:00Z"),
      transcript: "顧客: 予算は300万円です。最終決裁は代表取締役です。採用が課題です。9月15日に判断します。",
      minutes: "採用商談の議事録", minutesJson: { summary: "採用商談" },
      bantBudget: "300万円", bantAuthority: "代表取締役", bantNeed: "採用", bantTimeline: "9月15日",
    }],
  };
}

async function harness(initial = fixture()) {
  const state = {
    deal: structuredClone(initial) as typeof initial | null,
    writes: [] as Record<string, unknown>[], logs: [] as Record<string, unknown>[],
    latestInput: null as unknown, aiCalls: 0, aiResult: null as unknown,
    onGenerate: undefined as (() => void) | undefined,
    /** 商材名の確認に使う、案件の全会議（未指定なら deal.meetings）。 */
    allMeetings: undefined as unknown[] | undefined,
    beforeWrite: undefined as (() => void) | undefined,
  };
  const dependencies = {
    generate: async () => { state.aiCalls++; state.onGenerate?.(); return state.aiResult; },
    prisma: {
      deal: {
        findUnique: async () => structuredClone(state.deal),
        update: async ({ data, where }: { data: Record<string, unknown>; where: { bantUpdatedAt?: Date | null } }) => {
          state.beforeWrite?.();
          if ("bantUpdatedAt" in where && where.bantUpdatedAt?.getTime() !== state.deal!.bantUpdatedAt?.getTime()) {
            throw Object.assign(new Error("BANT changed concurrently"), { code: "P2025" });
          }
          state.writes.push(data);
          Object.assign(state.deal!, data);
          return structuredClone(state.deal);
        },
      },
      meeting: {
        findMany: async () => structuredClone(state.allMeetings ?? state.deal?.meetings ?? []),
      },
      aiLog: {
        findFirst: async () => state.latestInput ? { input: state.latestInput } : null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.logs.push(data);
          if (data.step === "bant_summary") state.latestInput = data.input;
        },
      },
    },
  };
  async function load<T>(kind: keyof typeof moduleFiles): Promise<T> {
    const loadedModule = { exports: {} };
    vm.runInNewContext(await bundle(kind), {
      module: loadedModule, exports: loadedModule.exports, mocks: dependencies, Date, TextDecoder, Response, Buffer,
      process: { env: { NODE_ENV: "test" } }, console,
      require: (name: string) => {
        if (!["node:crypto", "zod"].includes(name)) throw new Error(`Unexpected require: ${name}`);
        return localRequire(name);
      },
      fetch: () => { throw new Error("Network access forbidden"); },
    });
    return loadedModule.exports as T;
  }
  return {
    state,
    aggregate: await load<typeof import("../src/lib/ai/summarize-bant")>("aggregate"),
    route: await load<typeof import("../src/app/api/deals/[id]/route")>("route"),
  };
}

test("stale deal GET exposes repaired history values through the actual card resolver, without writes or AI", async () => {
  const { state, route } = await harness();
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: "demo-deal" }) });
  const { deal } = await response.json();
  for (const [key, expected] of Object.entries({ budget: "300万円", authority: "代表取締役", need: "採用", timeline: "9月15日" })) {
    const card = resolveBantCardView(deal.bant, key as "budget", deal.meetings);
    assert.equal(card.value, expected);
    assert.equal(card.status, "estimated");
    assert.equal(card.source?.href, "#meeting-demo-meeting");
  }
  assert.equal(state.aiCalls, 0);
  assert.equal(state.writes.length, 0);
  assert.equal((state.deal!.bant as Record<string, unknown>).budget, "未確定: 予算");
});

test("AI uncertainty is normalized before persistence and remains unknown after actual GET", async () => {
  const data = fixture();
  const need = "新卒採用への応募数が不足しているか未集計のため不明。今回は情報交換が目的。";
  const quote = "応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。";
  data.meetings[0] = { ...data.meetings[0], bantNeed: need, transcript: quote };
  const { aggregate, route, state } = await harness(data);
  state.aiResult = { parsed: { items: { need: { value: need, status: "confirmed", source_meeting_id: "demo-meeting", quote } }, confidence: 0 }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.need.status, "unknown");
  assert.equal(result.bant.items.need.value, need);
  assert.equal(result.bant.items.need.quote, quote);
  assert.equal(state.writes.length, 1);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.need, need);
  assert.equal(saved.bant.items.need.status, "unknown");
  assert.equal(resolveBantCardView(saved.bant, "need", saved.meetings).status, "unknown");
  assert.equal(state.aiCalls, 1);
  assert.equal(state.writes.length, 1, "GET does not persist a projection");
});

test("AI provisional budget retains amount and approval condition with estimated status on save and GET", async () => {
  const data = fixture();
  const budget = "制作費は80万円を目安に検討中。正式な社内承認は未取得。";
  const quote = "制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。";
  data.meetings[0] = { ...data.meetings[0], bantBudget: budget, transcript: quote };
  const { aggregate, route, state } = await harness(data);
  state.aiResult = { parsed: { items: { budget: { value: budget, status: "confirmed", source_meeting_id: "demo-meeting", quote } }, confidence: 0 }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.budget, budget);
  assert.equal(result.bant.items.budget.status, "estimated");
  assert.equal(result.bant.items.budget.quote, quote);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.budget, budget);
  assert.equal(saved.bant.items.budget.status, "estimated");
  assert.equal(resolveBantCardView(saved.bant, "budget", saved.meetings).status, "estimated");
});

test("known contact but unknown final authority is saved and displayed as unknown; manual certainty is preserved", async () => {
  const data=fixture();
  const value="採用実務担当者。最終決裁者、承認経路は未確認。まず上長に相談する予定だが、上長だけで決められるかは不明。";
  const quote="私は採用実務の担当で、今回の費用を最終決裁する人はまだ確認できていません。誰が最終決裁者か、正式な承認経路は未確認です。";
  data.meetings[0]={...data.meetings[0],bantAuthority:value,transcript:`顧客：${quote}`};
  const {aggregate,route,state}=await harness(data);
  const item={value,status:"estimated",quote,source_meeting_id:"demo-meeting"};
  state.aiResult={parsed:{items:{authority:item}},usedFallback:false};
  const result=await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.authority,value);
  assert.equal(result.bant.items.authority.status,"unknown");
  assert.equal(result.bant.items.authority.quote,quote);
  const response=await route.GET(new Request("http://offline.invalid"),{params:Promise.resolve({id:data.id})});
  const saved=(await response.json()).deal;
  assert.equal(saved.bant.items.authority.status,"unknown");
  assert.equal(resolveBantCardView(saved.bant,"authority",saved.meetings).status,"unknown");
  const manual=aggregate.normalizeDealBant({authority:value,manualFields:{authority:true},items:{authority:{...item,status:"confirmed"}}});
  assert.equal(manual.items.authority.status,"confirmed");
});

test("quote reference IDs restore untouched primary passages during actual aggregation save and GET", async () => {
  const data=fixture();
  const transcript=readFileSync(new URL("./fixtures/uat/t18-long-transcript.txt",import.meta.url),"utf8");
  data.meetings[0]={...data.meetings[0],sourceType:"manual_text",transcript,bantBudget:"150万円（目安）。正式な社内承認は未了。"};
  const {aggregate,route,state}=await harness(data);
  const refs=aggregate.bantQuoteReferences(data.meetings[0]);
  const entries=Object.entries(refs) as [string,string][];
  assert.ok(entries.length>5);
  assert.ok(entries.every(([,quote])=>transcript.includes(quote) && quote.startsWith("顧客：")));
  const [quote_ref,quote]=entries.find(([,text])=>text.includes("現在の予算目安は150万円です。"))!;
  state.aiResult={parsed:{items:{budget:{value:data.meetings[0].bantBudget,status:"estimated",source_meeting_id:"demo-meeting",quote_ref,quote:"モデルが勝手に言い換えた文章"}}},usedFallback:false};
  const result=await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.budget.quote,quote);
  assert.ok(quote.includes("正式な社内承認はまだ取れていません。"));
  assert.equal("quote_ref" in result.bant.items.budget,false);
  const response=await route.GET(new Request("http://offline.invalid"),{params:Promise.resolve({id:data.id})});
  assert.equal((await response.json()).deal.bant.items.budget.quote,quote);
  for(const ref of ["q9999",5,null]) {
    const raw={items:{budget:{value:"150万円",source_meeting_id:"demo-meeting",quote_ref:ref,quote:"untrusted"}}};
    assert.equal((aggregate.resolveBantQuoteReferences(raw,data.meetings) as {items:{budget:{quote:string}}}).items.budget.quote,"");
    assert.equal(raw.items.budget.quote,"untrusted");
  }
  const foreign={items:{budget:{quote_ref,source_meeting_id:"foreign",quote:"untrusted"}}};
  assert.equal((aggregate.resolveBantQuoteReferences(foreign,data.meetings) as {items:{budget:{quote:string}}}).items.budget.quote,"");
  const wrapped={...data.meetings[0],transcript:"営業：採用状況は？\n  顧客：新卒採用の応募数不\n  足が課題です。\n営業：分かりました。"};
  assert.equal(Object.values(aggregate.bantQuoteReferences(wrapped))[0],"顧客：新卒採用の応募数不\n  足が課題です。");
  const derived={...data.meetings[0],transcript:null,sourceType:"recording",minutes:"生成議事録",minutesJson:{summary:"生成議事録"}};
  assert.equal(Object.keys(aggregate.bantQuoteReferences(derived)).length,0);
});

test("T04: a one-line recording transcript is quoted per speaker turn, not as the whole transcript", async () => {
  const data=fixture();
  const turns=["話者1: ご予算の目安はありますか。","話者2: 予算は、180万円を上限に考えています。","話者1: 最終的なご判断は、どなたがされますか。","話者2: 決裁は、工場長の石田です。"];
  const oneLine=turns.join(" ");
  const {aggregate}=await harness(data);
  const refs=aggregate.bantQuoteReferences({...data.meetings[0],sourceType:"recording",minutesJson:{summary:"生成"},transcript:oneLine});
  assert.deepEqual(Object.values(refs),turns);
  assert.ok(Object.values(refs).every(quote=>oneLine.includes(quote) && quote.length<oneLine.length));
  // Without speaker labels there is no safe boundary; the passage is kept whole rather than split by guess.
  const unlabelled="予算は180万円です。決裁は石田です。";
  assert.deepEqual(Object.values(aggregate.bantQuoteReferences({...data.meetings[0],sourceType:"recording",minutesJson:{summary:"生成"},transcript:unlabelled})),[unlabelled]);
});

test("normalization and merging preserve manual certainty while normalizing only the new proposal", async () => {
  const { aggregate } = await harness();
  const need = "応募数が不足しているか未集計のため不明。";
  const budget = "制作費は80万円を目安に検討中。正式な社内承認は未取得。";
  const existing = { need, budget, manualFields: { need: true, budget: true }, items: {
    need: { value: need, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." },
    budget: { value: budget, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." },
  } };
  const normalized = aggregate.normalizeDealBant(existing);
  assert.equal(normalized.items.need.status, "confirmed");
  assert.equal(normalized.items.budget.status, "confirmed");
  const merged = aggregate.mergeDealBant(existing, { items: existing.items });
  assert.equal(merged.need, need);
  assert.equal(merged.budget, budget);
  assert.equal(merged.items.need.status, "confirmed");
  assert.equal(merged.items.budget.status, "confirmed");
  assert.equal(merged.aiSuggestion?.need?.status, "unknown");
  assert.equal(merged.aiSuggestion?.budget?.status, "estimated");
});

test("aggregation prompt distinguishes an explicit unknown from established BANT and preserves provisional amounts", async () => {
  const { aggregate } = await harness();
  const { system } = aggregate.buildBantAggregationPrompt(fixture(), "デモ商材");
  assert.match(system, /explicitly says something is unknown does not confirm/u);
  assert.match(system, /approval still pending is estimated/u);
  assert.match(system, /Do not erase a provisional amount/u);
});

test("derived unknown BANT quotations are removed before persistence and stay empty on actual GET", async () => {
  const data = fixture();
  const budget = "80万円を目安に検討中。正式な社内承認は未取得。";
  const budgetQuote = "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。";
  const authority = "未確認: 制作費の社内承認プロセスや決裁者が不明。承認が必要な段階。";
  const timeline = "未確認: 導入時期は未決定。";
  data.meetings[0] = { ...data.meetings[0], sourceType: "manual_text", transcript: `${budgetQuote}\n顧客：導入はまだ決めていません。今日は情報交換です。`, bantBudget: budget, bantAuthority: authority, bantTimeline: timeline, bantNeed: "未確認", minutes: "制作費80万円を目安に検討中。社内承認は未取得。", minutesJson: { summary: "制作費80万円を目安に検討中。社内承認は未取得。" } };
  const { aggregate, route, state } = await harness(data);
  state.aiResult = { parsed: { items: {
    budget: { value: budget, status: "estimated", source_meeting_id: "demo-meeting", quote: budgetQuote },
    authority: { value: authority, status: "unknown", source_meeting_id: "demo-meeting", quote: authority },
    timeline: { value: timeline, status: "unknown", source_meeting_id: "demo-meeting", quote: timeline },
  } }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.budget.quote, budgetQuote);
  assert.equal(result.bant.items.budget.status, "estimated");
  for (const key of ["authority", "timeline"] as const) {
    assert.equal(result.bant.items[key].quote, "");
    assert.equal(result.bant.items[key].status, "unknown");
    assert.equal(result.bant.items[key].source_meeting_id, "demo-meeting");
  }
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.items.budget.quote, budgetQuote);
  assert.equal(saved.bant.items.authority.quote, "");
  assert.equal(saved.bant.items.timeline.quote, "");
  assert.equal(resolveBantCardView(saved.bant, "authority", saved.meetings).source?.quote, "");
  assert.equal(state.aiCalls, 1);
  assert.equal(state.writes.length, 1);
});

test("a derived Need hypothesis cannot replace model unknown during save, fallback, or GET", async () => {
  const data = fixture();
  const hypothesis = "新卒採用の応募数に関する現状把握が必要な可能性あり（顧客は不足しているか未集計で不明と回答）";
  const quote = "応募数が不足しているかは、まだ集計していないので分かりません。今回は情報交換です。";
  data.meetings[0] = { ...data.meetings[0], bantNeed: hypothesis, transcript: `顧客：${quote}` };
  for (const value of ["未確定: ニーズ課題を確認する必要あり", hypothesis]) {
    const { aggregate, route, state } = await harness(data);
    state.aiResult = { parsed: { items: { need: { value, status: value === hypothesis ? "estimated" : "unknown", source_meeting_id: "demo-meeting", quote } } }, usedFallback: false };
    const result = await aggregate.summarizeDealBant(data.id);
    assert.match(result.bant.need, /^未確定/u);
    assert.equal(result.bant.items.need.status, "unknown");
    assert.equal(result.bant.items.need.quote, quote);
    const saved = (await (await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) })).json()).deal;
    assert.match(saved.bant.need, /^未確定/u);
    assert.equal(saved.bant.items.need.status, "unknown");
    assert.equal(resolveBantCardView(saved.bant, "need", saved.meetings).status, "unknown");
    assert.equal(aggregate.fallbackBantFromMeetings(data).items.need.status, "unknown");
    const priorHypothesis = { ...data, bant: { need: hypothesis, items: { need: { value: hypothesis, status: "estimated", source_meeting_id: "demo-meeting", quote } } } };
    assert.equal(aggregate.fallbackBantFromMeetings(priorHypothesis).items.need.status, "unknown");
    assert.match(aggregate.fallbackBantFromMeetings(priorHypothesis).need, /^未確定/u);
    assert.equal(state.aiCalls, 1);
  }
});

test("generic information stages cannot become concrete Need in persistence, fallback, or GET", async () => {
  for (const value of ["情報収集", "情報交換", "情報収集段階", "情報交換段階"]) {
    const data = fixture();
    const quote = "今日は情報交換です。";
    data.meetings[0] = { ...data.meetings[0], bantNeed: value, bantBudget: "80万円を目安に検討中。正式な社内承認は未取得。", transcript: `顧客：制作費は80万円を目安に検討中です。正式な社内承認は未取得です。${quote}` };
    const { aggregate, route, state } = await harness(data);
    state.aiResult = { parsed: { items: { need: { value, status: "confirmed", source_meeting_id: "demo-meeting", quote } } }, usedFallback: false };
    const result = await aggregate.summarizeDealBant(data.id);
    assert.equal(result.bant.need, BANT_UNKNOWN_VALUES.need);
    assert.equal(result.bant.items.need.value, BANT_UNKNOWN_VALUES.need);
    assert.equal(result.bant.items.need.status, "unknown");
    assert.equal(result.bant.items.need.quote, quote);
    assert.match(result.bant.budget, /80万円/u);
    assert.equal(result.bant.items.budget.status, "estimated");
    const saved = (await (await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) })).json()).deal;
    assert.equal(saved.bant.need, BANT_UNKNOWN_VALUES.need);
    assert.equal(saved.bant.items.need.status, "unknown");
    assert.equal(resolveBantCardView(saved.bant, "need", saved.meetings).status, "unknown");
    const fallback = aggregate.fallbackBantFromMeetings({ ...data, bant: { need: value } });
    assert.equal(fallback.need, BANT_UNKNOWN_VALUES.need);
    assert.equal(fallback.items.need.status, "unknown");
    assert.equal(state.aiCalls, 1);
  }
});

test("Need normalization keeps manual stages and concrete information-tool issues", async () => {
  const { aggregate } = await harness();
  const item = { value: "情報収集", status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." };
  const existing = { need: item.value, items: { need: item }, manualFields: { need: true }, custom: 42 };
  const normalized = aggregate.normalizeDealBant(existing);
  assert.equal(normalized.need, existing.need);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.items.need)), item);
  const merged = aggregate.mergeDealBant(existing, { need: "情報交換" });
  assert.equal(merged.need, existing.need);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.items.need)), item);
  assert.equal(merged.custom, 42);
  assert.equal(merged.aiSuggestion?.need?.value, BANT_UNKNOWN_VALUES.need);
  assert.equal(merged.aiSuggestion?.need?.status, "unknown");
  assert.equal(aggregate.normalizeDealBant({ need: "情報収集" }).need, BANT_UNKNOWN_VALUES.need);
  for (const value of ["情報収集ツールを統一したい", "情報交換に時間がかかる", "情報収集段階。採用難を解決したい。"] ) {
    assert.equal(aggregate.normalizeBantAiOutput({ need: value }).need, value);
    assert.equal(aggregate.normalizeDealBant({ need: value }).need, value);
  }
});

test("aggregation prompt labels primary manual records and excludes derived records as quotation sources", async () => {
  const { aggregate } = await harness();
  const data = fixture();
  const generated = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.match(generated.system, /meeting BANT, and previous aggregates are secondary context/u);
  assert.match(generated.system, /set quote to an empty string/u);
  assert.doesNotMatch(generated.user, /derived minutesJson \(secondary context/u);
  assert.match(generated.user, /complete transcript \(primary evidence\)/u);
  assert.match(generated.user, /meeting BANT \(derived values; not a quotation source\)/u);
  assert.doesNotMatch(generated.user, /manual minutes \(primary/u);
  data.meetings[0].transcript = null;
  const derivedOnly = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.match(derivedOnly.user, /derived minutesJson \(secondary context/u);
  data.meetings[0] = { ...data.meetings[0], sourceType: "manual_text", minutesJson: null, transcript: null, minutes: "手入力記録: 予算80万円は承認待ち。" };
  const manual = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.match(manual.user, /manual minutes \(primary written record; literal quotation allowed\)/u);
  assert.match(manual.user, /手入力記録: 予算80万円は承認待ち。/u);
});

test("read projection preserves manual unknowns and unrelated metadata", async () => {
  const data = fixture();
  data.bant = { budget: "未確認: 手動保留", manualFields: { budget: true }, industry: "食品", custom: 123 };
  const { route, state } = await harness(data);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const { deal } = await response.json();
  assert.equal(deal.bant.budget, "未確認: 手動保留");
  assert.equal(deal.bant.authority, "代表取締役");
  assert.equal(deal.bant.custom, 123);
  assert.equal(state.writes.length, 0);
});

test("GET retains missing/deleted deal responses", async () => {
  const { route, state } = await harness();
  state.deal = null;
  const get = () => route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: "missing" }) });
  assert.equal((await get()).status, 404);
  state.deal = { ...fixture(), deletedAt: new Date() } as never;
  assert.equal((await get()).status, 410);
});

test("fallback aggregation persists concrete BANT while keeping manual fields and metadata", async () => {
  const data = fixture();
  data.bant = { budget: "手動200万円", manualFields: { budget: true }, industry: "食品" };
  const { state, aggregate } = await harness(data);
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.budget, "手動200万円");
  assert.equal(result.bant.authority, "代表取締役");
  assert.equal(result.bant.aiSuggestion?.budget?.value, "300万円");
  assert.equal(result.bant.industry, "食品");
  assert.equal(state.writes.length, 1);
  assert.equal((state.deal!.bant as Record<string, unknown>).timeline, "9月15日");
});

test("new unknown placeholders do not erase the previous concrete meeting evidence", async () => {
  const { aggregate } = await harness();
  const data = fixture();
  data.meetings.unshift({ ...data.meetings[0], id: "newer", meetingDate: new Date("2026-08-31T01:00:00Z"), bantBudget: "未確認: 予算なし" });
  const value = aggregate.fallbackBantFromMeetings(data);
  assert.equal(value.budget, "300万円");
  assert.equal(value.items.budget.source_meeting_id, "demo-meeting");
  assert.equal(aggregate.normalizeBantAiOutput({ need: "未確認: 明示なし" }).items.need.status, "unknown");
  assert.equal(resolveBantCardView({ need: "未確認: 明示なし" }, "need").status, "unknown");
});

test("repeated notification is skipped, but changed meeting input within five minutes is processed", async () => {
  const { aggregate, state } = await harness();
  const first = await aggregate.summarizeDealBant("demo-deal", { debounce: true });
  assert.equal(first.bant.budget, "300万円");
  const repeated = await aggregate.summarizeDealBant("demo-deal", { debounce: true });
  assert.equal(repeated.skipped, true);
  assert.equal(state.aiCalls, 1);
  state.deal!.meetings[0].bantBudget = "250万円";
  const changed = await aggregate.summarizeDealBant("demo-deal", { debounce: true });
  assert.equal(changed.skipped, undefined);
  assert.equal(changed.bant.budget, "250万円");
  assert.equal(state.aiCalls, 2);
});

test("legacy debounce logs without an input fingerprint do not suppress repairs", async () => {
  const { aggregate, state } = await harness();
  state.latestInput = { trigger: "auto" };
  const result = await aggregate.summarizeDealBant("demo-deal", { debounce: true });
  assert.equal(result.bant.budget, "300万円");
  assert.equal(result.skipped, undefined);
});

test("AI unknown output is supplemented by saved meeting BANT", async () => {
  const { state, aggregate } = await harness();
  state.aiResult = { parsed: { budget: "未確定: 予算", authority: "未確認: 決裁" }, usedFallback: false };
  const result = await aggregate.summarizeDealBant("demo-deal");
  assert.equal(result.bant.budget, "300万円");
  assert.equal(result.bant.items.authority.source_meeting_id, "demo-meeting");
});

test("prompt includes primary transcript even when both minutes formats exist and keeps the five-meeting limit", async () => {
  const { aggregate } = await harness();
  const data = fixture();
  data.meetings = Array.from({ length: 6 }, (_, index) => ({ ...data.meetings[0], id: `demo-${index}`, title: `demo-${index}` }));
  const prompt = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.match(prompt.user, /complete transcript \(primary evidence\)/);
  assert.match(prompt.user, /予算は300万円です/);
  assert.doesNotMatch(prompt.user, /demo-5/);
});

test("long meeting aggregation receives the complete primary source including late corrections and qualifications", async () => {
  const data = fixture();
  const transcript = readFileSync(path.join(root, "tests/fixtures/uat/t18-long-transcript.txt"), "utf8").trim();
  assert.ok(transcript.length > 6000);
  assert.ok(transcript.indexOf("現在の予算目安は150万円") > 800);
  data.meetings[0].transcript = transcript;
  const before = structuredClone(data);
  const { aggregate } = await harness(data);
  const prompt = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.ok(prompt.user.includes(transcript), "The full original, not only the initial superseded amount, must reach aggregation");
  assert.doesNotMatch(prompt.user, /generated\/derived minutesJson/u, "Do not duplicate the full source with a derived summary");
  assert.ok(Buffer.byteLength(`${prompt.cacheableSystem}\n\n${prompt.system}${prompt.user}`, "utf8") < 65536);
  assert.deepEqual(data, before, "Prompt construction preserves the stored original");
});

// Byte-identical prompt lock for inputs that already fit the 65,536-byte provider
// check. Hashes were taken from the implementation before input budgeting existed.
// An intentional prompt change must update BANT_AGGREGATION_PROMPT_VERSION too.
// 2026-10-01: system の指示（商材名・confidence の尺度）を足したため全件 +903 バイト。会議の入力部分は変えていない。
const PROMPT_LOCK: Record<string, { sha256: string; bytes: number }> = {
  demo: { sha256: "a08657979e5d8e7a3c35efe9e44ad49dc307118ebd5dbaa90dc7d902da5bc856", bytes: 7870 },
  t18Manual: { sha256: "4884c30ff5d87fa57a339937d895c088a2e9da9b924ff5996470c506c6d11d28", bytes: 39340 },
  withdrawal: { sha256: "d218c4e81a8119dcf3d002b8a8ca215e75fd566e0fbdc1e8dca137d51581efa2", bytes: 10016 },
  sixMeetings: { sha256: "f1791cc9eb822fc77504922e9255a80f038ce46d00dbe4f84e89e70109555d7d", bytes: 10050 },
  derivedOnly: { sha256: "84f742438f22fec373f9f48da5c62b1514b58183a37ec02578f7875e9c5bd6f6", bytes: 7676 },
  manualMinutes: { sha256: "123b396e44d8ef6b019ce21c95d631005379f4552a1ad057ac28e3e1b1b0cab4", bytes: 14061 },
  manualEdits: { sha256: "b1743d982ee9aa0dff63f27612194906ff3996dbc99954ef0cfd076de6916a34", bytes: 8065 },
};

function promptLockFixtures(): Record<string, DealForBant> {
  const t18 = readFileSync(path.join(root, "tests/fixtures/uat/t18-long-transcript.txt"), "utf8");
  const t18Manual = fixture();
  t18Manual.meetings[0] = { ...t18Manual.meetings[0], sourceType: "manual_text", transcript: t18, bantBudget: "150万円（目安）。正式な社内承認は未了。" };
  const sixMeetings = fixture();
  sixMeetings.meetings = Array.from({ length: 6 }, (_, index) => ({ ...sixMeetings.meetings[0], id: `demo-${index}`, title: `demo-${index}` }));
  const derivedOnly = fixture();
  derivedOnly.meetings[0].transcript = null;
  const manualMinutes = fixture();
  manualMinutes.meetings[0] = { ...manualMinutes.meetings[0], transcript: null, sourceType: "manual_text", minutesJson: null,
    minutes: `顧客：予算は95万円を目安にしています。\n${"営業：採用の説明内容について確認します。\n".repeat(100)}顧客：訂正します。予算の目安は150万円で、正式な社内承認はまだです。` };
  const manualEdits = fixture();
  manualEdits.bant = {
    budget: "以前の手動予算200万円", authority: "代表取締役", manualFields: { budget: true },
    items: {
      budget: { value: "以前の手動予算200万円", quote: "User edited this BANT field manually.", status: "confirmed" },
      authority: { value: "代表取締役", quote: "最終決裁は代表取締役です。", source_meeting_id: "demo-meeting", status: "confirmed" },
    },
    aiSuggestion: { budget: { value: "古い提案999万円", quote: "古い提案の引用" } },
  };
  return { demo: fixture(), t18Manual, withdrawal: withdrawalFixture().data, sixMeetings, derivedOnly, manualMinutes, manualEdits };
}

test("prompts that already fit the provider input check stay byte-identical", async () => {
  const { aggregate } = await harness();
  const actual = Object.fromEntries(Object.entries(promptLockFixtures()).map(([name, deal]) => {
    const prompt = aggregate.buildBantAggregationPrompt(deal, "デモ商材");
    const serialized = JSON.stringify([prompt.cacheableSystem, prompt.system, prompt.user]);
    const bytes = Buffer.byteLength(`${prompt.cacheableSystem}\n\n${prompt.system}${prompt.user}`, "utf8");
    assert.ok(bytes <= 65536, name);
    return [name, { sha256: createHash("sha256").update(serialized).digest("hex"), bytes }];
  }));
  assert.deepEqual(actual, PROMPT_LOCK);
});

test("primary manual minutes retain late qualifications when no transcript exists", async () => {
  const data = fixture();
  const original = `顧客：予算は95万円を目安にしています。\n${"営業：採用の説明内容について確認します。\n".repeat(100)}顧客：訂正します。予算の目安は150万円で、正式な社内承認はまだです。`;
  data.meetings[0] = { ...data.meetings[0], transcript: null, sourceType: "manual_text", minutesJson: null, minutes: original };
  const { aggregate } = await harness(data);
  const prompt = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.ok(prompt.user.includes(original));
  assert.match(prompt.user, /manual minutes \(primary written record; literal quotation allowed\)/u);
});

test("manual clearing remains blank through aggregation, normalization and the card renderer", async () => {
  const data = fixture();
  data.bant = { budget: "", manualFields: { budget: true }, items: { budget: { value: "", status: "confirmed" } } };
  const { aggregate } = await harness(data);
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.budget, "");
  assert.equal(result.bant.items.budget.value, "");
  assert.equal(result.bant.aiSuggestion?.budget?.value, "300万円");
  const card = resolveBantCardView(result.bant, "budget");
  assert.equal(card.value, "");
  assert.equal(card.isManual, true);
});

test("edits made while AI is running are preserved by the latest merge", async () => {
  const { aggregate, state } = await harness();
  state.onGenerate = () => {
    state.deal!.bant = { budget: "手動150万円", manualFields: { budget: true } };
    state.deal!.bantUpdatedAt = new Date("2026-09-21T02:00:00Z");
  };
  const result = await aggregate.summarizeDealBant("demo-deal");
  assert.equal(result.bant.budget, "手動150万円");
  assert.equal(result.bant.aiSuggestion?.budget?.value, "300万円");
});

test("an edit between the final read and write aborts instead of overwriting it", async () => {
  const { aggregate, state } = await harness();
  state.beforeWrite = () => {
    state.deal!.bant = { budget: "直前の手動入力", manualFields: { budget: true } };
    state.deal!.bantUpdatedAt = new Date("2026-09-21T03:00:00Z");
  };
  await assert.rejects(aggregate.summarizeDealBant("demo-deal"), /changed concurrently/);
  assert.equal(state.writes.length, 0);
  assert.equal((state.deal!.bant as Record<string, unknown>).budget, "直前の手動入力");
});

test("saving one edited field leaves projected fields automatic and retains their meeting sources on GET", async () => {
  const { route, state } = await harness();
  const context = { params: Promise.resolve({ id: "demo-deal" }) };
  const saved = await route.PATCH(new Request("http://offline.invalid", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bant: { need: "手動で確認した採用課題" } }),
  }), context);
  assert.equal(saved.status, 200);
  const response = await route.GET(new Request("http://offline.invalid"), context);
  const { deal } = await response.json();
  assert.deepEqual(deal.bant.manualFields, { need: true });
  assert.equal(deal.bant.budget, "300万円");
  assert.equal(deal.bant.items.budget.source_meeting_id, "demo-meeting");
  assert.equal(deal.bant.need, "手動で確認した採用課題");
  assert.equal(deal.bant.items.need.status, "unknown");
  assert.equal(resolveBantCardView(deal.bant, "need").status, "unreviewed");
  assert.equal(state.aiCalls, 0);
});

test("manual PATCH retains paragraphs without asserting certainty or altering unedited evidence", async () => {
  const data = fixture();
  data.bant = {
    budget: "旧予算",
    authority: "代表取締役",
    items: {
      budget: { value: "旧予算", status: "confirmed", source_meeting_id: "old-source", quote: "旧予算です" },
      authority: { value: "代表取締役", status: "confirmed", source_meeting_id: "demo-meeting", quote: "最終決裁は代表取締役です" },
    },
  };
  const { route, state, aggregate } = await harness(data);
  const budget = "想定予算は80万円。社内承認はまだ取れていない。\n\n・基本施策：60万円\n・追加施策：20万円\n見積を確認して判断する。";
  const summary = "採用施策を検討中。\n予算・時期は次回確認する。";
  const context = { params: Promise.resolve({ id: "demo-deal" }) };
  const saved = await route.PATCH(new Request("http://offline.invalid", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bant: { budget, timeline: "未定", summary } }),
  }), context);
  assert.equal(saved.status, 200);
  const { deal: savedDeal } = await saved.json();
  assert.equal(savedDeal.bant.items.budget.status, "unknown");
  assert.equal(savedDeal.bant.items.timeline.status, "unknown");
  assert.equal(savedDeal.bant.items.budget.source_meeting_id, "");
  assert.equal(savedDeal.bant.budget, budget);
  assert.equal(savedDeal.bant.items.budget.value, budget);
  assert.equal(savedDeal.bant.summary, summary);

  const response = await route.GET(new Request("http://offline.invalid"), context);
  const { deal } = await response.json();
  assert.equal(deal.bant.budget, budget);
  assert.equal(deal.bant.summary, summary);
  const card = resolveBantCardView(deal.bant, "budget");
  assert.equal(card.value, budget);
  assert.equal(card.status, "unreviewed");
  assert.equal(card.source, undefined);
  assert.equal(resolveBantCardView(deal.bant, "timeline").status, "unknown");
  const authority = resolveBantCardView(deal.bant, "authority", deal.meetings);
  assert.equal(authority.status, "confirmed");
  assert.equal(authority.isManual, false);
  assert.equal(authority.source?.href, "#meeting-demo-meeting");
  assert.equal(state.aiCalls, 0);

  const aggregated = await aggregate.summarizeDealBant(data.id);
  assert.equal(aggregated.bant.budget, budget);
  assert.equal(aggregated.bant.items.budget.status, "unknown");
  assert.equal(resolveBantCardView(aggregated.bant, "budget").status, "unreviewed");
});

test("aggregation prompt excludes manual edit markers and old proposals as evidence", async () => {
  const data = fixture();
  data.bant = {
    budget: "以前の手動予算200万円",
    authority: "代表取締役",
    manualFields: { budget: true },
    items: {
      budget: { value: "以前の手動予算200万円", quote: "User edited this BANT field manually.", status: "confirmed" },
      authority: { value: "代表取締役", quote: "最終決裁は代表取締役です。", source_meeting_id: "demo-meeting", status: "confirmed" },
    },
    aiSuggestion: { budget: { value: "古い提案999万円", quote: "古い提案の引用" } },
  };
  const { aggregate } = await harness(data);
  const prompt = aggregate.buildBantAggregationPrompt(data, "デモ商材");
  assert.match(prompt.user, /以前の手動予算200万円/);
  assert.match(prompt.user, /最終決裁は代表取締役です/);
  assert.doesNotMatch(prompt.user, /User edited this BANT field manually|古い提案999万円|古い提案の引用/);
  assert.match(prompt.system, /propose the newest meeting evidence independently/);
});

test("model copying previous manual items is repaired in persisted proposals and GET without changing manual text", async () => {
  const data = fixture();
  const oldText = "手動200万円。\n社内承認は未取得。\n";
  const oldItem = { value: oldText, status: "confirmed", source_meeting_id: "", quote: "User edited this BANT field manually." };
  data.bant = { budget: oldText, manualFields: { budget: true }, items: { budget: oldItem }, custom: "retain" };
  const { aggregate, state, route } = await harness(data);
  state.aiResult = { parsed: { budget: "300万円", items: { budget: oldItem } }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.budget, oldText);
  assert.equal(result.bant.items.budget.quote, oldItem.quote);
  assert.equal(result.bant.custom, "retain");
  assert.equal(result.bant.aiSuggestion?.budget?.value, "300万円");
  assert.equal(result.bant.aiSuggestion?.budget?.source_meeting_id, "demo-meeting");
  assert.equal(result.bant.aiSuggestion?.budget?.status, "estimated");
  assert.equal(state.aiCalls, 1);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.budget, oldText);
  assert.equal(saved.bant.aiSuggestion.budget.value, "300万円");
  assert.equal(state.aiCalls, 1);
});

const withdrawnKeys = ["budget", "timeline"] as const;
const withdrawalTranscript = "顧客：前回の制作費80万円の目安と、2027年4月の導入希望は撤回します。\n顧客：現在の予算と導入時期は未定です。";

function withdrawalFixture() {
  const data = fixture();
  const oldBudget = "制作費は80万円を目安に検討中です。正式な社内承認は未取得です。";
  const oldTimeline = "導入するなら2027年4月を希望します。正式な時期は未確定です。";
  const old = { ...data.meetings[0], id: "before-withdrawal", meetingDate: new Date("2026-09-21T01:00:00Z"),
    transcript: `顧客：${oldBudget}\n顧客：${oldTimeline}`, minutes: null, minutesJson: null,
    bantBudget: oldBudget, bantTimeline: oldTimeline, bantAuthority: BANT_UNKNOWN_VALUES.authority, bantNeed: BANT_UNKNOWN_VALUES.need };
  const latest = { ...old, id: "explicit-withdrawal", meetingDate: new Date("2026-09-23T01:00:00Z"),
    transcript: withdrawalTranscript, bantBudget: BANT_UNKNOWN_VALUES.budget, bantTimeline: BANT_UNKNOWN_VALUES.timeline };
  const oldItems = {
    budget: { value: oldBudget, status: "estimated" as const, source_meeting_id: old.id, quote: oldBudget },
    timeline: { value: oldTimeline, status: "estimated" as const, source_meeting_id: old.id, quote: oldTimeline },
  };
  const oldSummary = "制作費80万円を目安に検討中。導入するなら2027年4月を希望している。";
  data.meetings = [latest, old];
  data.bant = { budget: oldBudget, timeline: oldTimeline, summary: oldSummary,
    items: oldItems, manualFields: { budget: false, timeline: false }, custom: "retain" };
  return { data, old, latest, oldItems, oldSummary };
}

function assertWithdrawalBant(
  bant: import("../src/lib/ai/summarize-bant").DealBantSummary,
  latest: DealForBant["meetings"][number],
  oldSummary: string,
) {
  for (const key of withdrawnKeys) {
    assert.match(bant[key], /未確認|未確定|未定/, key);
    assert.doesNotMatch(bant[key], /80万円|2027年4月/, `${key}: withdrawn figures are not current values`);
    assert.equal(bant.items[key].value, bant[key], key);
    assert.equal(bant.items[key].status, "unknown", key);
    assert.equal(bant.items[key].source_meeting_id, latest.id, key);
    assert.ok(bant.items[key].quote && latest.transcript!.includes(bant.items[key].quote), key);
    assert.match(bant.items[key].quote, /撤回/, `${key}: the primary citation must support the withdrawal`);
    const card = resolveBantCardView(bant, key, [latest]);
    assert.equal(card.value, bant[key]);
    assert.equal(card.status, "unknown");
    assert.equal(card.source?.href, `#meeting-${latest.id}`);
  }
  assert.notEqual(bant.summary, oldSummary, "a current summary must not silently retain the withdrawn conditions");
  assert.match(bant.summary, /撤回|未定|未確定|未確認/);
  assert.equal(bant.custom, "retain");
}

for (const mode of ["fallback", "model-unknown", "stale-model"] as const) {
  test(`explicit withdrawal supersedes old budget and date in persisted BANT, GET and cards (${mode})`, async () => {
    const { data, old, latest, oldItems, oldSummary } = withdrawalFixture();
    const { state, aggregate, route } = await harness(data);
    if (mode === "model-unknown") state.aiResult = { parsed: {
      budget: BANT_UNKNOWN_VALUES.budget, timeline: BANT_UNKNOWN_VALUES.timeline, summary: "今回の予算と導入時期は未定。",
    }, usedFallback: false };
    if (mode === "stale-model") state.aiResult = { parsed: {
      budget: oldItems.budget.value, timeline: oldItems.timeline.value, items: oldItems, summary: oldSummary,
    }, usedFallback: false };
    const result = await aggregate.summarizeDealBant(data.id);
    assertWithdrawalBant(result.bant, latest, oldSummary);
    assert.equal(result.fallback, mode === "fallback");
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === old.id), old, "historical meeting stays intact");
    const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
    const saved = (await response.json()).deal;
    assertWithdrawalBant(saved.bant, latest, oldSummary);
    assert.deepEqual(saved.bant, JSON.parse(JSON.stringify(result.bant)), "read projection must not revive nested or previous values");
    assert.equal(state.aiCalls, 1);
    assert.equal(state.writes.length, 1);
  });
}

test("read-only GET repairs an already-saved stale automatic aggregate after explicit withdrawal", async () => {
  const { data, old, latest, oldSummary } = withdrawalFixture();
  const originalBant = structuredClone(data.bant);
  const { state, route } = await harness(data);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assertWithdrawalBant(saved.bant, latest, oldSummary);
  assert.deepEqual(state.deal!.bant, originalBant, "read projection does not write data");
  assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === old.id), old);
  assert.equal(state.writes.length, 0);
  assert.equal(state.aiCalls, 0);
});

test("explicit withdrawal preserves manual fields while replacing or removing their obsolete AI proposals", async () => {
  const { data, old, latest, oldItems, oldSummary } = withdrawalFixture();
  const protectedItems = {
    budget: { value: "手動入力の予算80万円", status: "confirmed" as const, source_meeting_id: "", quote: "User edited this BANT field manually." },
    timeline: { value: "手動入力の導入時期2027年4月", status: "unknown" as const, source_meeting_id: "", quote: "User edited this BANT field manually." },
  };
  data.bant = { budget: protectedItems.budget.value, timeline: protectedItems.timeline.value, items: protectedItems,
    manualFields: { budget: true, timeline: true }, aiSuggestion: oldItems, summary: oldSummary, custom: "retain" };
  const { state, aggregate, route } = await harness(data);
  state.aiResult = { parsed: { budget: oldItems.budget.value, timeline: oldItems.timeline.value, items: oldItems, summary: oldSummary }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  for (const key of withdrawnKeys) {
    assert.equal(result.bant[key], protectedItems[key].value);
    assert.deepEqual(JSON.parse(JSON.stringify(result.bant.items[key])), protectedItems[key]);
    assert.equal(result.bant.manualFields[key], true);
    const suggestion = result.bant.aiSuggestion?.[key];
    if (suggestion) {
      assert.equal(suggestion.status, "unknown");
      assert.doesNotMatch(suggestion.value, /80万円|2027年4月/);
      assert.equal(suggestion.source_meeting_id, latest.id);
      assert.ok(suggestion.quote && latest.transcript!.includes(suggestion.quote));
    }
    const card = resolveBantCardView(result.bant, key, data.meetings);
    assert.equal(card.value, protectedItems[key].value);
    assert.equal(card.isManual, true);
  }
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.deepEqual(saved.bant, JSON.parse(JSON.stringify(result.bant)));
  assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === old.id), old);
  assert.equal(state.aiCalls, 1);
});

test("a newer meeting with no mention keeps the prior values and does not manufacture withdrawal evidence", async () => {
  const { data, old, oldItems } = withdrawalFixture();
  data.meetings[0] = { ...data.meetings[0], transcript: "顧客：本日は採用広報の内容を相談したいです。" };
  const { aggregate, route, state } = await harness(data);
  const result = await aggregate.summarizeDealBant(data.id);
  for (const key of withdrawnKeys) {
    assert.equal(result.bant[key], oldItems[key].value);
    assert.equal(result.bant.items[key].source_meeting_id, old.id);
    assert.equal(result.bant.items[key].status, "estimated");
  }
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  for (const key of withdrawnKeys) assert.equal(saved.bant[key], oldItems[key].value);
  assert.equal(state.aiCalls, 1);
});

test("new concrete conditions after a withdrawal become current instead of leaving a permanent unknown", async () => {
  const { data, old, latest } = withdrawalFixture();
  const budget = "制作費は120万円を目安に検討中です。正式承認は未取得です。";
  const timeline = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
  const renewed = { ...latest, id: "renewed-conditions", meetingDate: new Date("2026-09-24T01:00:00Z"),
    transcript: `顧客：${budget}\n顧客：${timeline}`, bantBudget: budget, bantTimeline: timeline };
  data.meetings.unshift(renewed);
  const { state, aggregate, route } = await harness(data);
  const result = await aggregate.summarizeDealBant(data.id);
  for (const [key, expected] of [["budget", budget], ["timeline", timeline]] as const) {
    assert.equal(result.bant[key], expected);
    assert.equal(result.bant.items[key].source_meeting_id, renewed.id);
    assert.equal(result.bant.items[key].status, "estimated");
  }
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.budget, budget);
  assert.equal(saved.bant.timeline, timeline);
  assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === old.id), old);
});

test("old AI source stays invalid after withdrawal even when a third meeting supplies replacement conditions", async () => {
  const { data, latest, oldItems, oldSummary } = withdrawalFixture();
  const budget = "制作費は120万円を目安に検討中です。正式承認は未取得です。";
  const timeline = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
  const renewed = { ...latest, id: "replacement", meetingDate: new Date("2026-09-24T01:00:00Z"),
    transcript: `顧客：${budget}\n顧客：${timeline}`, bantBudget: budget, bantTimeline: timeline };
  data.meetings.unshift(renewed);
  const { state, aggregate, route } = await harness(data);
  const stale = { budget: oldItems.budget.value, timeline: oldItems.timeline.value, items: oldItems, summary: oldSummary };
  state.aiResult = { parsed: stale, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  for (const [key, expected] of [["budget", budget], ["timeline", timeline]] as const) {
    assert.equal(result.bant[key], expected);
    assert.equal(result.bant.items[key].source_meeting_id, renewed.id);
  }
  assert.doesNotMatch(result.bant.summary, /80万円|2027年4月/);
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.equal(saved.bant.budget, budget);
  assert.equal(saved.bant.timeline, timeline);
  assert.equal(state.aiCalls, 1);
});

for (const manual of [false, true]) {
  test(`a withdrawal quote cannot validate old figures after replacement conditions (manual=${manual})`, async () => {
    const { data, latest, oldItems, oldSummary } = withdrawalFixture();
    const budget = "制作費は120万円を目安に検討中です。正式承認は未取得です。";
    const timeline = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
    const renewed = { ...latest, id: "replacement", meetingDate: new Date("2026-09-24T01:00:00Z"),
      transcript: `顧客：${budget}\n顧客：${timeline}`, bantBudget: budget, bantTimeline: timeline };
    data.meetings.unshift(renewed);
    const misattributed = Object.fromEntries(withdrawnKeys.map((key) => [key, {
      ...oldItems[key], source_meeting_id: latest.id, quote: latest.transcript,
    }]));
    data.bant = { ...(data.bant as Record<string, unknown>), manualFields: { budget: manual, timeline: manual },
      ...(manual ? { aiSuggestion: misattributed } : { items: misattributed }) };
    const { state, aggregate, route } = await harness(data);
    // GET must repair already-saved evidence without saving or making an AI call.
    const beforeResponse = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
    const beforeBant = (await beforeResponse.json()).deal.bant;
    for (const [key, expected] of [["budget", budget], ["timeline", timeline]] as const) {
      const evidence = manual ? beforeBant.aiSuggestion[key] : beforeBant.items[key];
      assert.equal(evidence.value, expected);
      assert.equal(evidence.source_meeting_id, renewed.id);
      assert.equal(beforeBant[key], manual ? oldItems[key].value : expected);
    }
    assert.equal(state.aiCalls, 0);
    assert.equal(state.writes.length, 0);
    state.aiResult = { parsed: { budget: oldItems.budget.value, timeline: oldItems.timeline.value,
      items: misattributed, summary: oldSummary }, usedFallback: false };
    const result = await aggregate.summarizeDealBant(data.id);
    for (const [key, expected] of [["budget", budget], ["timeline", timeline]] as const) {
      const evidence = manual ? result.bant.aiSuggestion![key]! : result.bant.items[key];
      assert.equal(evidence.value, expected);
      assert.equal(evidence.source_meeting_id, renewed.id);
      assert.equal(result.bant[key], manual ? oldItems[key].value : expected);
      if (manual) assert.deepEqual(JSON.parse(JSON.stringify(result.bant.items[key])), oldItems[key]);
    }
    const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
    assert.deepEqual((await response.json()).deal.bant, JSON.parse(JSON.stringify(result.bant)));
    assert.equal(state.aiCalls, 1);
  });
}

for (const manual of [false, true]) {
  test(`replacement dates remain provisional through save, GET and cards even when the model marks them confirmed (manual=${manual})`, async () => {
    const { data, old, latest, oldItems } = withdrawalFixture();
    const budget = "制作費は120万円を目安に検討しています。正式な社内承認はまだ取れていません。";
    const timeline = "導入するなら2027年6月を希望します。正式な時期は未確定です。";
    const renewed = { ...latest, id: "conditional-replacement", meetingDate: new Date("2026-09-24T01:00:00Z"),
      transcript: `顧客：${budget}\n顧客：${timeline}`, bantBudget: budget, bantTimeline: timeline };
    data.meetings.unshift(renewed);
    const pendingItems = Object.fromEntries(withdrawnKeys.map((key) => [key, {
      value: BANT_UNKNOWN_VALUES[key], status: "unknown", source_meeting_id: latest.id, quote: withdrawalTranscript,
    }]));
    data.bant = { budget: manual ? oldItems.budget.value : BANT_UNKNOWN_VALUES.budget,
      timeline: manual ? oldItems.timeline.value : BANT_UNKNOWN_VALUES.timeline,
      items: manual ? oldItems : pendingItems, manualFields: { budget: manual, timeline: manual },
      summary: "予算と導入時期は撤回され、現在未定です。", custom: "retain" };
    const { state, aggregate, route } = await harness(data);
    state.aiResult = { parsed: { budget, timeline, items: {
      budget: { value: budget, status: "confirmed", source_meeting_id: renewed.id, quote: budget },
      timeline: { value: timeline, status: "confirmed", source_meeting_id: renewed.id, quote: timeline },
    }, summary: "新しい予算と希望時期は、いずれも正式確定前です。" }, usedFallback: false };
    const result = await aggregate.summarizeDealBant(data.id);
    for (const [key, expected] of [["budget", budget], ["timeline", timeline]] as const) {
      const item = manual ? result.bant.aiSuggestion![key]! : result.bant.items[key];
      assert.equal(item.value, expected);
      assert.equal(item.quote, expected);
      assert.equal(item.status, "estimated");
      assert.equal(item.source_meeting_id, renewed.id);
      assert.equal(result.bant[key], manual ? oldItems[key].value : expected);
      if (manual) assert.deepEqual(JSON.parse(JSON.stringify(result.bant.items[key])), oldItems[key]);
    }
    assert.equal(state.writes.length, 1);
    const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
    const saved = (await response.json()).deal;
    assert.deepEqual(saved.bant, JSON.parse(JSON.stringify(result.bant)));
    const card = resolveBantCardView(saved.bant, "timeline", saved.meetings);
    assert.equal(card.value, manual ? oldItems.timeline.value : timeline);
    assert.equal(card.isManual, manual);
    if (!manual) {
      assert.equal(card.status, "estimated");
      assert.equal(card.source?.href, `#meeting-${renewed.id}`);
      assert.ok(saved.bant.summary.includes("導入するなら2027年6月を希望します。"));
    }
    assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === old.id), old);
    assert.deepEqual(state.deal!.meetings.find((meeting) => meeting.id === latest.id), latest);
    assert.equal(state.aiCalls, 1);
  });
}

test("replacement summary and card recover conditional timing from the verified latest literal passage", async () => {
  const { data, latest } = withdrawalFixture();
  const quote = "顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。新卒採用の応募数不足という課題は引き続きあります。";
  const value = "導入するなら2027年6月を希望。正式な導入時期は未確定";
  const renewed = { ...latest, id: "qualified-replacement", meetingDate: new Date("2026-09-24T01:00:00Z"),
    transcript: quote, bantBudget: "120万円目安・正式社内承認は未了", bantTimeline: `文字起こし記載: ${quote}` };
  data.meetings.unshift(renewed);
  const { state, aggregate, route } = await harness(data);
  state.aiResult = { parsed: { timeline: value, items: {
    timeline: { value, status: "confirmed", source_meeting_id: renewed.id, quote: "導入は2027年6月を希望しています。" },
  }, summary: "導入は2027年6月を希望。正式時期は未確定。" }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.timeline.quote, quote);
  assert.equal(result.bant.items.timeline.status, "estimated");
  assert.ok(result.bant.summary.includes("導入するなら2027年6月を希望します。"));
  const response = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) });
  const saved = (await response.json()).deal;
  assert.deepEqual(saved.bant, JSON.parse(JSON.stringify(result.bant)));
  assert.equal(resolveBantCardView(saved.bant, "timeline", saved.meetings).source?.quote, quote);
  assert.equal(state.aiCalls, 1);
});

const wrappedNeedTranscript = "営業：現在の予算と導入希望時期、採用の課題を教えてください。\n  顧客：予算は120万円を目安に考えています。正式な社内承認はまだ取れていません。導入するなら2027年6月を希望します。正式な導入時期は未確定です。新卒採用の応募数不\n  足という課題は引き続きあります。";
const wrappedNeedQuote = "新卒採用の応募数不\n  足という課題は引き続きあります。";

test("wrapped pasted Need is repaired by GET without AI, database writes, or confidence changes", async () => {
  const data = fixture();
  const need = "新卒採用の応募数不足";
  data.meetings[0] = { ...data.meetings[0], transcript: wrappedNeedTranscript, bantNeed: need };
  data.bant = { need, confidence: 0, items: { need: { value: need, status: "estimated", source_meeting_id: "demo-meeting", quote: "" } } };
  const { route, state } = await harness(data);
  const before = structuredClone(state.deal);
  const saved = (await (await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) })).json()).deal;
  assert.equal(saved.bant.items.need.quote, wrappedNeedQuote);
  assert.equal(saved.bant.items.need.status, "estimated");
  assert.equal(saved.bant.confidence, 0);
  assert.equal(saved.meetings[0].transcript, wrappedNeedTranscript);
  assert.equal(resolveBantCardView(saved.bant, "need", saved.meetings).source?.quote, wrappedNeedQuote);
  assert.deepEqual(state.deal, before);
  assert.equal(state.aiCalls, 0);
  assert.equal(state.writes.length, 0);
});

test("aggregation saves a literal wrapped Need quote and actual GET preserves it", async () => {
  const data = fixture();
  const need = "新卒採用の応募数不足";
  data.meetings[0] = { ...data.meetings[0], transcript: wrappedNeedTranscript, bantNeed: need };
  const { aggregate, route, state } = await harness(data);
  state.aiResult = { parsed: { confidence: 0, items: { need: { value: need, status: "estimated", source_meeting_id: "demo-meeting", quote: "新卒採用の応募数不足という課題は引き続きあります。" } } }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.need.quote, wrappedNeedQuote);
  assert.ok(wrappedNeedTranscript.includes(result.bant.items.need.quote));
  const saved = (await (await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) })).json()).deal;
  assert.equal(saved.bant.items.need.quote, wrappedNeedQuote);
  assert.equal(saved.bant.items.need.status, "estimated");
  assert.equal(saved.bant.confidence, 0);
  assert.equal(state.aiCalls, 1);
  assert.equal(state.writes.length, 1);
  assert.equal(state.deal!.meetings[0].transcript, wrappedNeedTranscript);
});

// T18 C3（2026-10-01 再実行）: 原文「制作費は80万円を目安に…」の要約に、登録商材名「採用動画」が足された。
const registeredProducts = [
  { productName: "映像", planName: "採用動画", yomiStatus: null, amount: null },
  { productName: "SNS", planName: "SNS運用代行（6ヶ月）", yomiStatus: null, amount: null },
];
const c3Transcript = [
  "営業：制作予算は決まっていますか？",
  "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。",
  "営業：導入することは決まりましたか？",
  "顧客：導入はまだ決めていません。今日は情報交換です。",
  "顧客：導入はまだ決めていませんが、導入するなら2027年4月を希望します。正式な時期は未確定です。",
].join("\n");

test("registered product names that the customer never said are removed from the saved summary and values", async () => {
  const data = fixture();
  data.products = registeredProducts;
  data.meetings[0] = { ...data.meetings[0], transcript: c3Transcript, bantBudget: "制作費は80万円を目安に検討。正式な社内承認は未取得。", bantNeed: BANT_UNKNOWN_VALUES.need };
  const { aggregate, route, state } = await harness(data);
  state.aiResult = { parsed: {
    summary: "情報交換では、採用動画の制作費として80万円を目安に検討中だが正式な社内承認は未了。SNS運用代行（6ヶ月）の導入を希望している。導入自体は未定。",
    confidence: 20,
    items: {
      budget: { value: "採用動画の制作費は80万円を目安に検討しているが、正式な社内承認はまだ取れていない。", status: "estimated", source_meeting_id: "demo-meeting", quote_ref: "q1", quote: "" },
      need: { value: "SNS運用代行で応募数を増やしたい", status: "estimated", source_meeting_id: "demo-meeting", quote_ref: "", quote: "" },
    },
  }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  const saved = (await (await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ id: data.id }) })).json()).deal;
  for (const bant of [result.bant, saved.bant]) {
    assert.doesNotMatch(JSON.stringify(bant), /採用動画|SNS運用代行|映像/);
    assert.match(bant.summary, /制作費として80万円を目安に検討中だが正式な社内承認は未了/);
    assert.match(bant.summary, /導入自体は未定/);
    // 商材名が目的語の文は、名前だけ消すと「導入を希望している」という別の主張になるので文ごと除く。
    assert.doesNotMatch(bant.summary, /導入を希望している/);
    assert.equal(bant.budget, "制作費は80万円を目安に検討しているが、正式な社内承認はまだ取れていない。");
    assert.equal(bant.items.budget.status, "estimated");
    assert.equal(bant.items.budget.quote, "顧客：制作費は80万円を目安に検討しています。正式な社内承認はまだ取れていません。");
    assert.equal(bant.items.need.status, "unknown");
  }
  const log = state.logs.find((row) => row.step === "bant_summary")!.output as Record<string, unknown>;
  assert.deepEqual(Array.from((log.productNameGuard as { names: string[] }).names).sort(), ["SNS運用代行", "SNS運用代行（6ヶ月）", "採用動画"].sort());
});

test("product names the customer actually said remain, and a period suffix not in the transcript is dropped", async () => {
  const data = fixture();
  data.products = registeredProducts;
  const transcript = "顧客：採用動画の制作費は80万円を目安に検討しています。SNS運用代行にも興味があります。";
  data.meetings[0] = { ...data.meetings[0], transcript, bantBudget: "採用動画の制作費は80万円を目安。", bantNeed: BANT_UNKNOWN_VALUES.need };
  const { aggregate, state } = await harness(data);
  state.aiResult = { parsed: {
    summary: "採用動画の制作費は80万円を目安に検討中。SNS運用代行（6ヶ月）にも興味がある。",
    items: { budget: { value: "採用動画の制作費は80万円を目安に検討", status: "estimated", source_meeting_id: "demo-meeting", quote_ref: "q1", quote: "" } },
  }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.summary, "採用動画の制作費は80万円を目安に検討中。SNS運用代行にも興味がある。");
  assert.equal(result.bant.budget, "採用動画の制作費は80万円を目安に検討");
});

test("the aggregation prompt states the 0-100 confidence scale and forbids unspoken product names", () => {
  return harness().then(({ aggregate }) => {
    const { system } = aggregate.buildBantAggregationPrompt({ ...fixture(), products: registeredProducts }, "デモ商材");
    assert.match(system, /"confidence": "integer 0-100"/);
    assert.match(system, /not 0-1, 1-5 or 1-10/);
    assert.match(system, /制作費として80万円/);
    assert.match(system, /Registered products/);
    assert.equal(aggregate.BANT_AGGREGATION_PROMPT_VERSION, "20261001-product-names-confidence-v2");
  });
});

test("AI confidence is normalized to the 0-100 scale once; merges and manual values only clamp", async () => {
  const { aggregate } = await harness();
  const items = (status: string) => Object.fromEntries(["budget", "authority", "need", "timeline"].map((key) => [key, { value: status === "unknown" ? "未確定: 不明" : "300万円", status, source_meeting_id: "", quote: "" }]));
  const confidence = (value: unknown, status = "confirmed") => aggregate.normalizeBantAiOutput({ confidence: value, items: items(status) }).confidence;
  assert.equal(confidence(85), 85);
  assert.equal(confidence(0.85), 85, "0〜1 の割合は百分率にする");
  assert.equal(confidence(150), 100);
  assert.equal(confidence(-3), 0);
  assert.equal(confidence("80"), 80);
  assert.equal(confidence("80%"), 80);
  assert.equal(confidence(72.6), 73);
  // 0〜100 を指示したので、整数の小さい値も読み替えない（誤りを増やさない）。
  assert.equal(confidence(5), 5);
  assert.equal(confidence(1, "estimated"), 1);
  assert.equal(confidence(10), 10);
  assert.equal(confidence(0, "estimated"), 0);
  assert.equal(confidence(undefined), 80);
  assert.equal(confidence("高い"), 80);
  assert.equal(aggregate.normalizeDealBant({ confidence: 5, updatedBy: "manual" }).confidence, 5);
  // 正規化済みの値をもう一度 merge しても変えない（独立レビュー: 5 が 80 になった）。
  const previous = aggregate.normalizeBantAiOutput({ confidence: 5, items: items("confirmed") });
  assert.equal(aggregate.mergeDealBant(previous, previous).confidence, 5);
  assert.equal(aggregate.mergeDealBant({}, { ...previous, confidence: 0.5 }).confidence, 1, "merge は 0〜100 に収めるだけ");
});

test("an AI failure keeps the previous confidence through the fallback merge", async () => {
  const data = fixture();
  data.bant = { budget: "300万円", confidence: 5, items: { budget: { value: "300万円", status: "estimated", source_meeting_id: "demo-meeting", quote: "" } } };
  const { aggregate, state } = await harness(data);
  state.aiResult = null;
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.fallback, true);
  assert.equal(result.bant.confidence, 5);
});

// 独立レビュー（2026-10-01）: 根拠付きの予算・ニーズが商材名のために「未確定」に戻った。
test("product-name guard strips only the name from quoted items and never discards their evidence", async () => {
  const data = fixture();
  data.products = registeredProducts;
  const budgetLine = "顧客：制作費は80万円を目安に検討しています。";
  const needLine = "顧客：採用向けの動画を作りたいです。";
  data.meetings[0] = { ...data.meetings[0], transcript: `${budgetLine}\n${needLine}`, bantBudget: "80万円を目安", bantNeed: "採用向けの動画を作りたい" };
  const { aggregate, state } = await harness(data);
  state.aiResult = { parsed: { confidence: 40, summary: "制作費は80万円を目安に検討中。", items: {
    budget: { value: "採用動画と合わせて80万円を目安", status: "estimated", source_meeting_id: "demo-meeting", quote_ref: "q1", quote: "" },
    need: { value: "採用動画の制作", status: "estimated", source_meeting_id: "demo-meeting", quote_ref: "q2", quote: "" },
  } }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.items.budget.value, "80万円を目安");
  assert.equal(result.bant.items.budget.status, "estimated");
  assert.equal(result.bant.items.budget.quote, budgetLine);
  // 名前を外すと「制作」しか残らないので、原文の引用から値を作る。
  assert.equal(result.bant.items.need.value, "採用向けの動画を作りたいです。");
  assert.notEqual(result.bant.items.need.status, "unknown");
  assert.equal(result.bant.items.need.quote, needLine);
  assert.doesNotMatch(JSON.stringify(result.bant), /採用動画/);
});

test("product names said in an older meeting or kept in a manual BANT value are not removed", async () => {
  const data = fixture();
  data.products = registeredProducts;
  const recent = Array.from({ length: 5 }, (_, index) => ({ ...data.meetings[0], id: `recent-${index}`, meetingDate: new Date(Date.UTC(2026, 8, 20 + index)), transcript: "顧客：制作費は80万円を目安に検討しています。" }));
  const older = { ...data.meetings[0], id: "older", meetingDate: new Date("2026-09-01T01:00:00Z"), transcript: "顧客：採用動画を検討しています。" };
  data.meetings = recent.reverse();
  data.bant = { need: "SNS運用代行に関心", manualFields: { need: true }, items: { need: { value: "SNS運用代行に関心", status: "estimated", source_meeting_id: "", quote: "" } } };
  const { aggregate, state } = await harness(data);
  state.allMeetings = [...data.meetings, older];
  state.aiResult = { parsed: { summary: "採用動画の制作費は80万円を目安に検討中。SNS運用代行に関心がある。", items: {} }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.summary, "採用動画の制作費は80万円を目安に検討中。SNS運用代行に関心がある。");
});

// AI が作った前回の値は根拠にしない（混入済みの商材名が残り続けるため）。
test("a product name only in a previous AI-generated value or summary is still removed", async () => {
  const data = fixture();
  data.products = registeredProducts;
  data.meetings[0] = { ...data.meetings[0], transcript: "顧客：制作費は80万円を目安に検討しています。" };
  data.bant = { need: "SNS運用代行に関心", summary: "採用動画の制作費として80万円を目安に検討中。", updatedBy: "auto",
    items: { need: { value: "SNS運用代行に関心", status: "estimated", source_meeting_id: "", quote: "" } } };
  const { aggregate, state } = await harness(data);
  state.aiResult = { parsed: { summary: "採用動画の制作費は80万円を目安に検討中。SNS運用代行に関心がある。", items: {} }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.summary, "制作費は80万円を目安に検討中。");
});

test("full-width and spaced product names in AI output are matched with the same normalization", async () => {
  const data = fixture();
  data.products = registeredProducts;
  data.meetings[0] = { ...data.meetings[0], transcript: "顧客：制作費は80万円を目安に検討しています。" };
  const { aggregate, state } = await harness(data);
  state.aiResult = { parsed: { summary: "制作費は80万円を目安。ＳＮＳ運用代行の導入を希望。SNS 運用代行を検討。", items: {} }, usedFallback: false };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(result.bant.summary, "制作費は80万円を目安。");
  const spoken = fixture();
  spoken.products = registeredProducts;
  spoken.meetings[0] = { ...spoken.meetings[0], transcript: "顧客：SNS運用代行に興味があります。" };
  const second = await harness(spoken);
  second.state.aiResult = { parsed: { summary: "ＳＮＳ運用代行（６ヶ月）に興味がある。", items: {} }, usedFallback: false };
  assert.equal((await second.aggregate.summarizeDealBant(spoken.id)).bant.summary, "ＳＮＳ運用代行に興味がある。");
});
