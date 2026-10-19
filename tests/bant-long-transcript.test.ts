import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import type { DealForBant, MeetingForBant } from "../src/lib/ai/summarize-bant";
import type { BantValue } from "../src/components/deals/bant-summary-utils";

// Offline only: the real prompt builder, reconciliation, Luma context formatter,
// buildSystemText and Vertex policy run; database and every AI provider are mocks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localRequire = createRequire(import.meta.url);
const LIMIT = 65536;
const EXCERPT_LABEL = "Long transcript: verbatim excerpts only (omitted lines are not evidence of absence)";
const BANT_PATTERN = /予算|円|万|費用|見積|決裁|承認|稟議|部長|社長|役員|担当|課題|困|悩|目的|導入|時期|開始|公開|納品|月|日|までに|期限|予定|撤回|取り下げ|白紙|訂正|変更|未定|未確認|未集計|未合意|検討/u;

type Mocks = Record<string, string>;
async function bundle(entry: string, mocks: Mocks, allowed: string[], external: string[] = [], jsx = false, append = "") {
  const permitted = new Set([entry, ...allowed].map((file) => path.join(root, file)));
  const file = path.join(root, entry);
  // append はテストの bundle にだけ足す export（本体のファイルは変えない）。
  const input = append
    ? { stdin: { contents: readFileSync(file, "utf8") + append, resolveDir: path.dirname(file), sourcefile: file, loader: "ts" as const } }
    : { entryPoints: [file] };
  const result = await build({
    absWorkingDir: root, ...input, bundle: true, write: false, format: "cjs",
    platform: "node", tsconfigRaw: { compilerOptions: jsx ? { jsx: "react-jsx" } : {} }, logLevel: "silent",
    plugins: [{ name: "offline-only", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.path in mocks) return { path: args.path, namespace: "mock" };
        if (external.includes(args.path)) return { path: args.path, external: true };
        const base = args.path.startsWith("@/") ? path.join(root, "src", args.path.slice(2)) : path.resolve(args.resolveDir || root, args.path);
        const resolved = /\.tsx?$/u.test(base) ? base : [`${base}.ts`, `${base}.tsx`].find((file) => existsSync(file)) ?? `${base}.ts`;
        if (!permitted.has(resolved)) throw new Error(`Forbidden dependency: ${args.path}`);
        return { path: resolved };
      });
      builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
    } }],
  });
  return result.outputFiles[0].text;
}

function run<T>(code: string, mocks: Record<string, unknown>, external: string[] = []): T {
  const loaded = { exports: {} };
  vm.runInNewContext(code, {
    module: loaded, exports: loaded.exports, mocks, Buffer, Date, TextDecoder, TextEncoder,
    process: { env: { NODE_ENV: "test" } }, console: { log() {}, warn() {}, error() {} },
    fetch: () => { throw new Error("Network access forbidden"); },
    require: (name: string) => {
      if (!external.includes(name)) throw new Error(`Unexpected require: ${name}`);
      return localRequire(name);
    },
  });
  return loaded.exports as T;
}

const ai = (name: string) => `src/lib/ai/${name}.ts`;
const noAi = "()=>{throw new Error('AI forbidden')}";
const tenant = "export const currentTenant=()=>null;export const getRequestTenant=async()=>null;";

type VertexPolicy = typeof import("../src/lib/ai/vertex-policy");
// 配分の検証用に、テストの bundle だけで公開する内部の会議入力（全文、BANT 項目のみ、抜粋）。
type PromptInput = {
  full: string; bantOnly: string; leastExcerptBytes?: number;
  excerpt?: (maxBytes: number) => { section: string; complete: boolean } | null;
};
type Aggregate = typeof import("../src/lib/ai/summarize-bant") & {
  __meetingPromptInput: (meeting: MeetingForBant, index: number) => PromptInput;
};
type Preparation = typeof import("../src/lib/ai/preparation");
type HeavyProvider = "vertex" | "anthropic" | "gemini";
const modules = (async () => {
  const anthropic = run<typeof import("../src/lib/ai/anthropic")>(await bundle(ai("anthropic"), {
    "./vertex": `export const vertexGenerate=${noAi};`, "./usage": `export const measureAiCall=${noAi};`,
    "./gemini": `export const geminiCallText=${noAi};`, "@anthropic-ai/sdk": `export default class Anthropic{constructor(){throw new Error('AI forbidden')}}`,
    "./provider": "export const getHeavyTextProvider=()=>'vertex';export const getTextProvider=()=>'vertex';export const hasAnthropicKey=()=>false;",
  }, []), {});
  const luma = run<typeof import("../src/lib/ai/luma-context")>(await bundle(ai("luma-context"), {
    "@/lib/tenant-context": tenant, "@/lib/db": "export const prisma={};",
  }, [ai("luma-value-proposition")]), {});
  const vertexPolicy = run<VertexPolicy>(await bundle(ai("vertex-policy"), {}, []), {});
  const aggregate = await bundle(ai("summarize-bant"), {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/ai/anthropic": "export const callClaudeHeavyJSON=(...a)=>mocks.generate(...a);export const buildSystemText=(...a)=>mocks.buildSystemText(...a);",
    "@/lib/ai/luma-context": "export const getLumaContextText=async()=>mocks.lumaText;export const getCachedLumaContextText=()=>mocks.lumaText;export const formatLumaContextForPrompt=(...a)=>mocks.formatLumaContextForPrompt(...a);",
    // The real policy module instance, so VertexError identity and the limit are the provider's.
    "@/lib/ai/vertex-policy": "export const VERTEX_MAX_INPUT_BYTES=mocks.vertexPolicy.VERTEX_MAX_INPUT_BYTES;export const VertexError=mocks.vertexPolicy.VertexError;",
    // 各テストが harness(deal, provider) で指定する。入力の上限で縮めるのは Vertex のときだけ。
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=>mocks.provider;",
    "next/server": "export const after=()=>{throw new Error('Unexpected scheduling')};",
    // QG26 S-4: 集約中の印（DB の advisory lock）は tests/qg26-bant-summary-lock.test.mjs で確かめる。
    "@/lib/ai/bant-summary-lock": 'export const waitForBantSummaryLock=async()=>({id:"lease"});export const acquireBantSummaryLock=async()=>({id:"lease"});export const releaseBantSummaryLock=async()=>{};',
  }, [...["bant-definitions", "bant-reconciliation", "bant-withdrawal", "timeline-evidence", "customer-conditions", "offer-evidence"].map(ai),
    "src/components/deals/bant-summary-utils.ts"], ["node:crypto"], false, "\nexport { meetingPromptInput as __meetingPromptInput };\n");
  // 事前準備のプロンプト組み立て（AI・検索・DB はすべて使わない）。
  const preparation = run<Preparation>(await bundle(ai("preparation"), {
    "./vertex-grounding": `export const vertexPreparation=${noAi};export const preparationFormattingWorstCaseBytes=()=>0;`,
    "@/lib/ai/anthropic": `export const callClaudeHeavyJSONWithTools=${noAi};export const formatAnthropicDebug=()=>'';export const getAnthropicModelName=()=>'';`,
    "@/lib/ai/provider": "export const getHeavyTextProvider=()=>'vertex';export const hasAnthropicKey=()=>false;",
    "@/lib/ai/luma-context": `export const formatLumaContextForPrompt=(text)=>text;export const getLumaContextText=${noAi};`,
    "@/lib/db": "export const prisma={};",
  }, ["bant-definitions", "bant-reconciliation", "bant-withdrawal", "timeline-evidence", "vertex-policy"].map(ai)), {});
  const lumaText = luma.formatLumaContextText({
    products: [
      { name: "映像制作", description: "採用向けの映像制作", plans: [
        { name: "採用動画", basePrice: 800000, description: "企画、撮影、編集", sortOrder: 10 },
        { name: "会社紹介動画", basePrice: 700000, description: "会社紹介向け", sortOrder: 20 },
        { name: "商品PR動画", basePrice: 600000, description: "商品訴求向け", sortOrder: 30 },
        { name: "スポット制作", basePrice: null, description: "単発の短尺動画", sortOrder: 40 },
      ] },
      { name: "SNS運用", description: "採用広報のSNS運用支援", plans: [
        { name: "SNS運用代行（6ヶ月）", basePrice: 1200000, description: "投稿設計からレポートまで", sortOrder: 10 },
      ] },
      { name: "広告", description: "CM枠の出稿", plans: [{ name: "CM枠出稿", basePrice: null, description: "", sortOrder: 10 }] },
    ],
    proposals: [{ name: "ドラマ風動画", displayOrder: 10 }, { name: "社員インタビュー", displayOrder: 20 }],
    dealProducts: [{ productName: "映像制作", planName: "採用動画", yomiStatus: "B", amount: 800000 }],
  });
  return { anthropic, luma, vertexPolicy, aggregate, preparation, lumaText };
})();

// 2026-10-01: 案件BANTの system の指示（登録商材名・confidence の尺度）が 903 バイト増えた。会議の配分の境界を
// 固定した試験では、商材コンテキストを同じバイト数だけ短くして、会議に使える量を変更前と同じにする。
const SYSTEM_PROMPT_GROWTH_BYTES = 903;
function sameMeetingRoom(text: string): string {
  let trimmed = text;
  while (Buffer.byteLength(text) - Buffer.byteLength(trimmed) < SYSTEM_PROMPT_GROWTH_BYTES) trimmed = trimmed.slice(0, -1);
  return trimmed + "x".repeat(Buffer.byteLength(text) - Buffer.byteLength(trimmed) - SYSTEM_PROMPT_GROWTH_BYTES);
}

async function harness(deal: DealForBant, provider: HeavyProvider) {
  const { anthropic, luma, vertexPolicy, aggregate: code, lumaText } = await modules;
  const state = {
    deal: structuredClone(deal),
    writes: [] as Array<Record<string, unknown>>,
    logs: [] as Array<{ step: string; input: Record<string, unknown> }>,
    prompts: [] as Array<{ system: string; user: string; cacheableSystem?: string }>,
    respond: async (): Promise<unknown> => null,
    beforeWrite: undefined as (() => void) | undefined,
    failLog: false,
  };
  const mocks = {
    lumaText, vertexPolicy, provider,
    buildSystemText: anthropic.buildSystemText,
    formatLumaContextForPrompt: luma.formatLumaContextForPrompt,
    generate: async (options: { system: string; user: string; cacheableSystem?: string }) => {
      state.prompts.push(options);
      return state.respond();
    },
    prisma: {
      deal: {
        findUnique: async () => structuredClone(state.deal),
        update: async ({ where, data }: { where: { bantUpdatedAt?: Date | null }; data: Record<string, unknown> }) => {
          const beforeWrite = state.beforeWrite;
          state.beforeWrite = undefined;
          beforeWrite?.();
          if ("bantUpdatedAt" in where && where.bantUpdatedAt?.getTime() !== state.deal.bantUpdatedAt?.getTime()) {
            throw Object.assign(new Error("BANT changed concurrently"), { code: "P2025" });
          }
          state.writes.push(data);
          Object.assign(state.deal, structuredClone(data));
          return structuredClone(state.deal);
        },
      },
      // 商材名の確認に使う案件の全会議（2026-10-01）。
      meeting: { findMany: async () => structuredClone(state.deal.meetings) },
      aiLog: {
        findFirst: async () => null,
        create: async ({ data }: { data: { step: string; input: Record<string, unknown> } }) => {
          if (state.failLog) throw new Error("aiLog unavailable");
          state.logs.push(structuredClone(data));
        },
      },
    },
  };
  const aggregate = run<Aggregate>(code, mocks, ["node:crypto"]);
  const inputBytes = (prompt: { system: string; user: string; cacheableSystem?: string }) =>
    Buffer.byteLength(anthropic.buildSystemText(prompt) + prompt.user, "utf8");
  return { state, aggregate, lumaText, vertexPolicy, inputBytes };
}

// Filler turns deliberately contain none of the BANT excerpt keywords.
const FILLER = [
  "はい、よろしくお願いいたします。", "なるほど、そうなんですね。", "学生の反応はどうでしたか。",
  "説明会では製品の話が中心でした。", "現場の雰囲気を伝えたいと考えています。", "若手社員の声も入れられると良いですね。",
  "撮影場所は工場と事務所の二か所を想定しています。", "その点は持ち帰って整理します。", "ありがとうございます。",
  "社内の雰囲気が伝わる内容にしたいです。",
];
const RELATED = [
  "採用サイトの動画が古いことが課題です。", "次回は人事部長にも同席してもらう予定です。",
  "費用感としては、制作費と撮影交通費が別になりますか。", "社内の承認は部長の決裁が必要になります。",
  "説明会の参加者数はまだ集計していないので、未集計です。", "撮影は来月の平日を候補にしています。",
];
const EARLY_BUDGET = "予算は80万円を目安にしています。正式な社内承認はまだ取れていません。";
const UNLABELLED_NEED = "新卒の応募が少なくて苦労しています。";
const LATE_CORRECTION = "訂正します。予算の目安は120万円で、正式な社内承認はまだです。";
const LATE_TIMELINE = "導入するなら2027年4月までに公開したいです。正式な時期は未定です。";

function clock(seconds: number) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * joinTranscriptionSegments() shape: 10-minute ［m:ss〜m:ss］ blocks of 話者N turns, ~330 chars/min.
 * density は BANT 関連の発言の割合（dense は 80%、既定は 15%）。
 */
function speakerTranscript(minutes: number, {
  dense = false, density = dense ? 0.8 : 0.15, seed = minutes * 31 + (dense ? 7 : 3), labels = ["話者1", "話者2"],
}: { dense?: boolean; density?: number; seed?: number; labels?: string[] } = {}) {
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const segments = Math.ceil(minutes / 10);
  return Array.from({ length: segments }, (_, segment) => {
    const lines: string[] = [];
    let speaker = 0;
    const say = (text: string) => { lines.push(`${labels[speaker]}: ${text}`); speaker = 1 - speaker; };
    const customer = (text: string) => { if (speaker !== 1) say(FILLER[0]); say(text); };
    while (lines.join("\n").length < 3300) {
      if (segment === 0 && lines.length === 4) customer(EARLY_BUDGET);
      if (segment === 1 && lines.length === 6) { customer(UNLABELLED_NEED); say(FILLER[1]); say(FILLER[2]); }
      if (segment === segments - 1 && lines.length === 20) { customer(LATE_CORRECTION); say(FILLER[1]); customer(LATE_TIMELINE); }
      const pool = random() < density ? RELATED : FILLER;
      say(pool[Math.floor(random() * pool.length)] + (random() < 0.5 ? FILLER[Math.floor(random() * FILLER.length)] : ""));
    }
    return `［${clock(segment * 600)}〜${clock(Math.min(minutes * 60, segment * 600 + 602))}］\n${lines.join("\n")}`;
  }).join("\n\n");
}

const unit = (length: number) => "顧客の発言に基づく確認事項として整理する。".repeat(Math.ceil(length / 21)).slice(0, length);
function meeting(index: number, transcript: string | null): MeetingForBant {
  return {
    id: `long-meeting-${index}`, title: `第${index + 1}回商談`, meetingDate: new Date(Date.UTC(2026, 8, 20 - index, 1)),
    minutes: "生成議事録", minutesJson: { summary: "生成議事録" }, transcript, sourceType: "recording",
    bantBudget: "80万円を目安に検討中。正式な社内承認は未取得。", bantAuthority: "人事部長の決裁が必要",
    bantNeed: "採用サイトの動画が古いことが課題", bantTimeline: "導入するなら2027年4月までに公開したい。正式な時期は未定。",
  };
}
function longDeal(meetings: MeetingForBant[]): DealForBant {
  // A realistic previous automatic aggregate (the prompt keeps up to 5,000 chars of it).
  const item = { value: unit(150), status: "estimated", source_meeting_id: "long-meeting-0", quote: unit(200) };
  return {
    id: "long-deal", title: "2027年度新卒採用動画の制作", status: "HEARING",
    bant: { budget: unit(150), authority: unit(150), need: unit(300), timeline: unit(200), summary: unit(300), confidence: 60,
      items: { budget: item, authority: item, need: item, timeline: item }, updatedBy: "auto",
      manualFields: { budget: false, authority: false, need: false, timeline: false } },
    bantUpdatedAt: new Date("2026-09-20T00:00:00Z"),
    company: { name: "架空食品株式会社", industry: "食品製造" },
    products: [{ productName: "映像制作", planName: "採用動画", yomiStatus: "B", amount: 800000 }],
    meetings,
  };
}

function meetingSections(user: string): string[] {
  const body = user.split(/^# Recent meetings only .*$/mu)[1].split("\n\n# Unknown value requirements")[0].trim();
  return body.split("\n\n---\n\n");
}
function sectionReferences(section: string): Record<string, string> {
  const marker = "### primary quote references for this meeting\n";
  const at = section.indexOf(marker);
  return at < 0 ? {} : JSON.parse(section.slice(at + marker.length).split("\n")[0]) as Record<string, string>;
}
type SectionKind = "full" | "excerpt" | "bant";
function sectionKind(section: string): SectionKind {
  if (section.includes(`### ${EXCERPT_LABEL}`)) return "excerpt";
  if (section.includes("### primary evidence omitted to fit the input limit")) return "bant";
  return "full";
}
/** 話者N形式の section が、BANT 関連の段落とその直前の段落をすべて含むか。 */
function isCompleteSection(section: string, references: Record<string, string>): boolean {
  const kind = sectionKind(section);
  if (kind !== "excerpt") return kind === "full";
  const kept = sectionReferences(section);
  const entries = Object.entries(references);
  return entries.every(([id], position) => id in kept
    || ![entries[position], entries[position + 1]].some((entry) => entry && BANT_PATTERN.test(entry[1])));
}
const expectedReduction = (kinds: SectionKind[]) => kinds.includes("bant") ? "older_meetings_bant_only"
  : kinds.includes("excerpt") ? "transcript_excerpts" : "quote_references";

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
/**
 * 配分の検証に使う値。complete は section が全文か、BANT 関連段落とその直前の段落をすべて含む抜粋か。
 * room は BANT 項目のみの section より増やせるバイト数の合計（section の差し替えは他の部分に影響しない）。
 */
function allocationFacts(aggregate: Aggregate, meetings: MeetingForBant[], user: string, bytes: number) {
  const inputs = meetings.map((item, index) => aggregate.__meetingPromptInput(item, index));
  const sections = meetingSections(user);
  const complete = sections.map((section, index) => section === inputs[index].full || section === inputs[index].excerpt?.(Infinity)?.section);
  const room = LIMIT - bytes + sections.reduce((sum, section, index) => sum + utf8(section) - utf8(inputs[index].bantOnly), 0);
  return { inputs, sections, complete, room };
}
/** 完全になる最小の量と、抜粋にできる最小の量（BANT 項目のみの section より増えるバイト数）。 */
function costs(input: PromptInput) {
  const full = utf8(input.full) - utf8(input.bantOnly);
  const excerpt = input.excerpt?.(Infinity);
  return {
    complete: Math.min(full, excerpt ? utf8(excerpt.section) - utf8(input.bantOnly) : Infinity),
    least: input.leastExcerptBytes === undefined ? Infinity : Math.min(full, input.leastExcerptBytes - utf8(input.bantOnly)),
  };
}
/**
 * 修正前の配分の完全さ（新しい順）。新しい keep 件を新しい順の均等な取り分で全文か抜粋にし、
 * 古い会議は全文が残りに入るときだけ全文、ほかは BANT 項目のみにする。最後の1件以外が完全な最大の keep を採る。
 * 修正前は BANT 関連段落0件の抜粋も入れたが、ここでは入れないので、後の会議に残るバイトは修正前以上になる。
 */
function previousCompleteness(inputs: PromptInput[], room: number): string {
  for (let keep = inputs.length; keep >= 1; keep--) {
    let remaining = room;
    let newerIncomplete = false;
    const complete = inputs.map((input, position) => {
      const base = utf8(input.bantOnly);
      const full = utf8(input.full) - base;
      if (position >= keep) {
        if (full > remaining) return false;
        remaining -= full;
        return true;
      }
      const share = Math.floor(remaining / (keep - position));
      if (full <= share) {
        remaining -= full;
        return true;
      }
      const excerpt = input.excerpt?.(base + share);
      if (excerpt) remaining -= utf8(excerpt.section) - base;
      if (!excerpt?.complete && position < keep - 1) newerIncomplete = true;
      return !!excerpt?.complete;
    });
    if (!newerIncomplete) return complete.map((value) => (value ? "1" : "0")).join("");
  }
  return "0".repeat(inputs.length);
}

test("synthetic filler never matches the BANT excerpt keywords", () => {
  for (const line of FILLER) assert.doesNotMatch(line, BANT_PATTERN, line);
  for (const line of [...RELATED, EARLY_BUDGET, LATE_CORRECTION, LATE_TIMELINE]) assert.match(line, BANT_PATTERN, line);
  assert.doesNotMatch(UNLABELLED_NEED, BANT_PATTERN);
});

for (const minutes of [60, 90]) {
  for (const dense of [false, true]) {
    test(`speaker-N ${minutes}-minute transcript (${dense ? "dense" : "typical"}) fits 65,536 bytes with verbatim excerpts and unchanged IDs`, async () => {
      const transcript = speakerTranscript(minutes, { dense });
      assert.ok(transcript.length >= minutes * 300, "at least ~300 chars per recorded minute");
      const data = longDeal([meeting(0, transcript)]);
      const { aggregate, lumaText, vertexPolicy, inputBytes } = await harness(data, "vertex");
      assert.equal(vertexPolicy.VERTEX_MAX_INPUT_BYTES, LIMIT);
      const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
      assert.ok(inputBytes(prompt) <= LIMIT, `${inputBytes(prompt)} bytes`);
      assert.equal(prompt.inputReduction, "transcript_excerpts");
      assert.ok(!prompt.user.includes(transcript), "the complete transcript cannot fit and is not repeated");
      const [section] = meetingSections(prompt.user);
      assert.match(section, new RegExp(`### ${EXCERPT_LABEL.replace(/[()]/gu, "\\$&")}`, "u"));
      assert.match(section, /### meeting BANT \(derived values; not a quotation source\)/u);
      const full = aggregate.bantQuoteReferences(data.meetings[0]);
      const excerpt = Object.entries(sectionReferences(section));
      assert.ok(excerpt.length > 10 && excerpt.length < Object.keys(full).length);
      for (const [id, text] of excerpt) {
        assert.equal(text, full[id], `${id} keeps the ID of the complete reference list`);
        assert.ok(transcript.includes(text), `${id} is a verbatim transcript passage`);
      }
      const texts = excerpt.map(([, text]) => text);
      for (const statement of [LATE_CORRECTION, LATE_TIMELINE]) {
        assert.ok(texts.some((text) => text.endsWith(statement)), `late qualification is kept: ${statement}`);
      }
      if (!dense) assert.ok(texts.some((text) => text.endsWith(EARLY_BUDGET)), "every BANT line fits in a typical meeting");
      const order = excerpt.map(([id]) => Number(id.slice(1)));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "original order");
      assert.deepEqual(data, longDeal([meeting(0, transcript)]), "prompt construction does not modify the meeting");
    });
  }
}

test("a moderately long speaker-N meeting only drops the duplicate transcript and keeps every passage", async () => {
  const transcript = speakerTranscript(30);
  const data = longDeal([meeting(0, transcript)]);
  const { aggregate, lumaText, inputBytes } = await harness(data, "vertex");
  // Lower bound of today's input: system text + complete transcript + its quote references.
  const complete = inputBytes({ ...aggregate.buildBantAggregationPrompt(data, lumaText), user: "" })
    + Buffer.byteLength(transcript + JSON.stringify(aggregate.bantQuoteReferences(data.meetings[0])), "utf8");
  assert.ok(complete > LIMIT, "transcript plus its quote references would exceed the check");
  const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
  assert.ok(inputBytes(prompt) <= LIMIT);
  assert.equal(prompt.inputReduction, "quote_references");
  assert.doesNotMatch(prompt.user, new RegExp(EXCERPT_LABEL.slice(0, 20), "u"));
  const [section] = meetingSections(prompt.user);
  assert.match(section, /### complete transcript \(primary evidence\)\nNot repeated: the primary quote references below contain every passage/u);
  // JSON round trip: the module runs in its own realm with different prototypes.
  assert.deepEqual(sectionReferences(section), JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(data.meetings[0]))));
  for (const line of transcript.split("\n").filter(Boolean)) {
    assert.ok(Object.values(sectionReferences(section)).includes(line), line);
  }
});

test("a long 営業/顧客 transcript keeps original lines in its excerpt and customer reference IDs", async () => {
  const transcript = speakerTranscript(60, { labels: ["営業", "顧客"] });
  const data = longDeal([meeting(0, transcript)]);
  const { aggregate, lumaText, inputBytes } = await harness(data, "vertex");
  const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
  assert.ok(inputBytes(prompt) <= LIMIT);
  assert.equal(prompt.inputReduction, "transcript_excerpts");
  const [section] = meetingSections(prompt.user);
  const body = section.split(`### ${EXCERPT_LABEL}\n`)[1].split("\n### primary quote references")[0].split("\n").slice(1);
  const originalLines = new Set(transcript.split("\n"));
  assert.ok(body.length > 20);
  for (const line of body) assert.ok(line === "[omitted]" || originalLines.has(line), line);
  assert.ok(body.includes(`顧客: ${LATE_CORRECTION}`));
  const full = aggregate.bantQuoteReferences(data.meetings[0]);
  for (const [id, text] of Object.entries(sectionReferences(section))) {
    assert.equal(text, full[id]);
    assert.match(text, /^顧客:/u);
  }
});

test("long meetings keep a verbatim excerpt each, and an older one keeps only meeting BANT when newer complete meetings leave no room", async () => {
  // 5件（60〜64分）: 最新は完全になり、古い会議もそれぞれ原文の抜粋を保つ（BANT 項目のみにしない）。
  const five = [0, 1, 2, 3, 4].map((index) => meeting(index, speakerTranscript(60 + index)));
  const data = longDeal(five);
  const { aggregate, lumaText: catalog, inputBytes } = await harness(data, "vertex");
  const lumaText = sameMeetingRoom(catalog);
  const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
  assert.ok(inputBytes(prompt) <= LIMIT, `${inputBytes(prompt)} bytes`);
  assert.equal(prompt.inputReduction, "transcript_excerpts");
  const sections = meetingSections(prompt.user);
  assert.deepEqual(sections.map((section) => section.match(/^meeting_id: (.+)$/mu)?.[1]), five.map(({ id }) => id));
  assert.ok(isCompleteSection(sections[0], aggregate.bantQuoteReferences(five[0])), "newest meeting keeps every BANT passage");
  sections.forEach((section, index) => {
    assert.equal(sectionKind(section), "excerpt", `meeting ${index}`);
    assert.ok(Object.keys(sectionReferences(section)).length > 20, `meeting ${index}: ${Object.keys(sectionReferences(section)).length} passages`);
  });
  // 4件（60〜63分）: 新しい2件を完全にすると、最も古い会議には最小の抜粋も入らないので BANT 項目のみになる。
  const four = five.slice(0, 4);
  const reduced = aggregate.buildBantAggregationPrompt(longDeal(four), lumaText);
  assert.ok(inputBytes(reduced) <= LIMIT, `${inputBytes(reduced)} bytes`);
  assert.equal(reduced.inputReduction, "older_meetings_bant_only");
  const kept = meetingSections(reduced.user);
  assert.deepEqual(kept.map(sectionKind), ["excerpt", "excerpt", "excerpt", "bant"]);
  for (const index of [0, 1]) assert.ok(isCompleteSection(kept[index], aggregate.bantQuoteReferences(four[index])), `meeting ${index} is complete`);
  assert.match(kept[3], /### primary evidence omitted to fit the input limit \(not evidence of absence/u);
  assert.match(kept[3], /- budget: 80万円を目安に検討中。正式な社内承認は未取得。/u);
  assert.deepEqual(sectionReferences(kept[3]), {});
});

for (const dense of [false, true]) {
  test(`an older long meeting uses the room a short newest meeting leaves instead of being dropped (${dense ? "dense" : "typical"})`, async () => {
    const meetings = [meeting(0, speakerTranscript(10)), meeting(1, speakerTranscript(90, { dense }))];
    const data = longDeal(meetings);
    const { aggregate, lumaText, inputBytes } = await harness(data, "vertex");
    const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
    assert.ok(inputBytes(prompt) <= LIMIT, `${inputBytes(prompt)} bytes`);
    assert.equal(prompt.inputReduction, "transcript_excerpts");
    const [newest, older] = meetingSections(prompt.user);
    assert.deepEqual(sectionReferences(newest), JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(meetings[0]))), "newest keeps every passage");
    assert.ok(older.includes(EXCERPT_LABEL));
    const olderExcerpt = sectionReferences(older);
    const related = Object.entries(aggregate.bantQuoteReferences(meetings[1])).filter(([, text]) => BANT_PATTERN.test(text));
    assert.ok(Object.values(olderExcerpt).some((text) => text.endsWith(LATE_CORRECTION)));
    if (dense) {
      assert.ok(Object.keys(olderExcerpt).length < related.length, "dense BANT passages are trimmed");
      assert.ok(inputBytes(prompt) > LIMIT - 1000, "the trimmed excerpt uses the remaining room");
    } else {
      for (const [id, text] of related) assert.equal(olderExcerpt[id], text, `every BANT passage is kept (${id})`);
    }
  });
}

test("inputs that already fit with the real Luma context are sent unchanged", async () => {
  const t18 = readFileSync(path.join(root, "tests/fixtures/uat/t18-long-transcript.txt"), "utf8");
  for (const transcript of [t18, speakerTranscript(10)]) {
    const data = longDeal([meeting(0, transcript)]);
    const { aggregate, lumaText, inputBytes } = await harness(data, "vertex");
    const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
    assert.ok(inputBytes(prompt) <= LIMIT);
    assert.equal(prompt.inputReduction, undefined);
    assert.ok(prompt.user.includes(`### complete transcript (primary evidence)\n${transcript.trim()}`));
    assert.ok(!prompt.user.includes(EXCERPT_LABEL));
  }
});

test("excerpt reference IDs and literal quotes are grounded in the full transcript during aggregation", async () => {
  const transcript = speakerTranscript(90);
  const data = longDeal([meeting(0, transcript)]);
  const { aggregate, state, inputBytes } = await harness(data, "vertex");
  state.respond = async () => {
    const [sent] = state.prompts;
    assert.ok(inputBytes(sent) <= LIMIT, "the provider receives the budgeted input");
    assert.ok(!sent.user.includes(UNLABELLED_NEED), "a keyword-free line is not in the excerpt");
    const [quoteRef] = Object.entries(sectionReferences(meetingSections(sent.user)[0])).find(([, text]) => text.endsWith(LATE_CORRECTION))!;
    return { parsed: { items: {
      budget: { value: "予算の目安は120万円。正式な社内承認は未了。", status: "confirmed", source_meeting_id: data.meetings[0].id, quote_ref: quoteRef, quote: "モデルの言い換え" },
      need: { value: "新卒の応募が少ない", status: "estimated", source_meeting_id: data.meetings[0].id, quote: UNLABELLED_NEED },
    } }, usedFallback: false };
  };
  const result = await aggregate.summarizeDealBant(data.id);
  assert.equal(state.prompts.length, 1);
  assert.equal(result.bant.items.budget.quote, `話者2: ${LATE_CORRECTION}`);
  assert.ok(transcript.includes(result.bant.items.budget.quote));
  assert.equal(result.bant.items.budget.status, "estimated", "a provisional amount stays estimated");
  assert.equal(result.bant.items.need.quote, UNLABELLED_NEED, "deterministic verification reads the full transcript");
  assert.equal(state.deal.meetings[0].transcript, transcript);
  const resolved = aggregate.resolveBantQuoteReferences({ items: { need: { quote_ref: "q1", source_meeting_id: data.meetings[0].id } } }, data.meetings) as { items: { need: { quote: string } } };
  assert.equal(resolved.items.need.quote, aggregate.bantQuoteReferences(data.meetings[0]).q1, "IDs outside the excerpt still resolve to the full source");
});

test("automatic aggregation failures leave a card marker without touching BANT values or bantUpdatedAt", async () => {
  const data = longDeal([meeting(0, speakerTranscript(10))]);
  const { aggregate, state, vertexPolicy } = await harness(data, "vertex");
  const before = structuredClone(state.deal.bant) as Record<string, unknown>;
  const message = "今回のAI検証では入力が長すぎます。文章を短くして再実行してください。";
  state.respond = async () => { throw new vertexPolicy.VertexError("input_limit", message); };
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  const marked = state.deal.bant as Record<string, unknown> & { lastError: { message: string; at: string } };
  assert.equal(marked.lastError.message, message);
  assert.ok(Number.isFinite(Date.parse(marked.lastError.at)));
  assert.deepEqual({ ...marked, lastError: undefined }, { ...before, lastError: undefined });
  assert.equal(state.deal.bantUpdatedAt?.toISOString(), "2026-09-20T00:00:00.000Z");

  state.respond = async () => { throw new Error("connect ECONNRESET 10.0.0.1:443"); };
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  assert.equal((state.deal.bant as typeof marked).lastError.message, "AIの呼び出しまたは結果の保存に失敗しました。", "internal details are not shown");

  // A newer edit during the run is a conflict, not a failure to report.
  const conflicted = structuredClone(state.deal.bant);
  state.respond = async () => ({ parsed: { budget: "80万円" }, usedFallback: false });
  state.beforeWrite = () => { state.deal.bantUpdatedAt = new Date("2026-09-21T00:00:00Z"); };
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  assert.deepEqual(state.deal.bant, conflicted);

  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  assert.equal("lastError" in (state.deal.bant as Record<string, unknown>), false, "a successful aggregation clears the marker");
  assert.equal(aggregate.bantInputFingerprint({ ...data, bant: marked }), aggregate.bantInputFingerprint(data), "the marker is not aggregation input");
});

test("a failure after the BANT save leaves no failure marker, while a failure before the save does", async () => {
  const data = longDeal([meeting(0, speakerTranscript(10))]);
  const { aggregate, state } = await harness(data, "vertex");
  // 保存より前の失敗（AI の呼び出し）: カードに印が残る。
  state.respond = async () => { throw new Error("connect ECONNRESET 10.0.0.1:443"); };
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  assert.ok("lastError" in (state.deal.bant as Record<string, unknown>));
  assert.equal(state.deal.bantUpdatedAt?.toISOString(), "2026-09-20T00:00:00.000Z");
  assert.equal(state.writes.length, 1);

  // 保存の後の失敗（aiLog.create）: 集約は保存済みなので、印を消したまま新しい印も書かない。
  state.respond = async () => ({ parsed: { budget: "80万円を目安に検討中。正式な社内承認は未取得。" }, usedFallback: false });
  state.failLog = true;
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  assert.equal(state.writes.length, 2, "only the BANT save; no marker write after it");
  assert.notEqual(state.deal.bantUpdatedAt?.toISOString(), "2026-09-20T00:00:00.000Z", "the aggregation was saved");
  assert.equal("lastError" in (state.deal.bant as Record<string, unknown>), false);
  assert.match(String((state.deal.bant as Record<string, unknown>).budget), /80万円/u);

  // summarizeDealBant 自体は、これまでどおり記録の失敗を例外で返す。
  await assert.rejects(aggregate.summarizeDealBant(data.id), /aiLog unavailable/u);
  assert.equal("lastError" in (state.deal.bant as Record<string, unknown>), false);
});

test("a failure marker on a deal without BANT leaves the next BANT and preparation inputs unchanged", async () => {
  const data: DealForBant = { ...longDeal([meeting(0, speakerTranscript(10))]), bant: null };
  const { aggregate, state, lumaText } = await harness(data, "vertex");
  const before = aggregate.buildBantAggregationPrompt(structuredClone(data), lumaText);
  assert.match(before.user, /# Previous Deal\.bant aggregate\nnull\n/u);
  state.respond = async () => { throw new Error("connect ECONNRESET 10.0.0.1:443"); };
  await aggregate.scheduleDealBantSummary(data.id, "analysis_completed");
  const marked = structuredClone(state.deal.bant) as Record<string, unknown>;
  assert.deepEqual(Object.keys(marked), ["lastError"]);
  assert.deepEqual(aggregate.buildBantAggregationPrompt(state.deal, lumaText), before, "the marker is not previous-aggregate input");

  // 次の集約でも AI には同じ入力が届き、aiLog の previousBantIncluded は false のまま。
  state.prompts.length = 0;
  state.respond = async () => null;
  await aggregate.summarizeDealBant(data.id);
  const [sent] = state.prompts;
  assert.deepEqual([sent.system, sent.cacheableSystem, sent.user], [before.system, before.cacheableSystem, before.user]);
  assert.equal(state.logs.at(-1)?.input.previousBantIncluded, false);

  // 既存の {} や、ほかのキーを持つ bant は今までどおりの入力になる。
  assert.match(aggregate.buildBantAggregationPrompt({ ...data, bant: {} }, lumaText).user, /# Previous Deal\.bant aggregate\n\{\}\n/u);
  const saved = { budget: "80万円を目安に検討中。正式な社内承認は未取得。", manualFields: { budget: true } };
  assert.deepEqual(aggregate.buildBantAggregationPrompt({ ...data, bant: { ...saved, lastError: marked.lastError } }, lumaText),
    aggregate.buildBantAggregationPrompt({ ...data, bant: saved }, lumaText));

  // 事前準備の「# Deal BANT aggregate」も同じ扱いにする。
  const { preparation } = await modules;
  const prepare = (bant: unknown) => preparation.buildPreparationResearchPrompt({
    id: data.id, title: data.title, status: data.status, bant,
    company: { ...data.company, employeeCount: null, websiteSummary: null },
    products: data.products.map((product) => ({ ...product, planProposals: [] })),
    meetings: data.meetings,
  }, lumaText);
  assert.deepEqual(prepare(marked), prepare(null));
  assert.match(prepare(null).user, /# Deal BANT aggregate \(historical internal references; not confirmed current facts\)\nnull\n/u);
  assert.match(prepare({}).user, /# Deal BANT aggregate \(historical internal references; not confirmed current facts\)\n\{\}\n/u);
  assert.deepEqual(prepare({ ...saved, lastError: marked.lastError }), prepare(saved));
  assert.match(prepare(saved).user, /"source_type": "manual_bant_reference"/u);
});

test("anthropic and gemini keep the complete prompt for a long meeting; only Vertex has the input limit", async () => {
  const transcript = speakerTranscript(90);
  for (const provider of ["anthropic", "gemini"] as const) {
    const data = longDeal([meeting(0, transcript)]);
    const { aggregate, state, lumaText, inputBytes } = await harness(data, provider);
    const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
    assert.ok(inputBytes(prompt) > LIMIT, `${provider}: the complete input is larger than the Vertex check`);
    assert.equal(prompt.inputReduction, undefined, provider);
    assert.ok(prompt.user.includes(`### complete transcript (primary evidence)\n${transcript.trim()}`), provider);
    const [section] = meetingSections(prompt.user);
    assert.deepEqual(sectionReferences(section), JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(data.meetings[0]))), provider);
    assert.ok(!prompt.user.includes(EXCERPT_LABEL), provider);
    // 実際の呼び出しにも同じ全文が届き、aiLog に縮め方は記録されない。
    await aggregate.summarizeDealBant(data.id);
    assert.equal(state.prompts[0].user, prompt.user, provider);
    assert.equal("inputReduction" in state.logs[0].input, false, provider);
    const vertex = (await harness(data, "vertex")).aggregate.buildBantAggregationPrompt(data, lumaText);
    assert.equal(vertex.inputReduction, "transcript_excerpts", "the same deal is reduced for Vertex");
  }
});

// Review measurements: the newest meeting cannot be complete even alone, so an older short meeting keeps every passage.
for (const [newest, older, density] of [[60, 5, 0.8], [90, 10, 0.4]] as const) {
  test(`a short older meeting keeps its quote references next to a long dense newest meeting on Vertex (${newest}+${older} min, ${density * 100}% BANT lines)`, async () => {
    const meetings = [meeting(0, speakerTranscript(newest, { density })), meeting(1, speakerTranscript(older, { density }))];
    const data = longDeal(meetings);
    const { aggregate, lumaText, inputBytes } = await harness(data, "vertex");
    const prompt = aggregate.buildBantAggregationPrompt(data, lumaText);
    assert.ok(inputBytes(prompt) <= LIMIT, `${inputBytes(prompt)} bytes`);
    assert.ok(LIMIT - inputBytes(prompt) < 4096, "no large idle remainder");
    assert.equal(prompt.inputReduction, "transcript_excerpts");
    const [latest, short] = meetingSections(prompt.user);
    assert.equal(sectionKind(latest), "excerpt");
    assert.match(short, /Not repeated: the primary quote references below contain every passage/u);
    assert.deepEqual(sectionReferences(short), JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(meetings[1]))));
    const full = aggregate.bantQuoteReferences(meetings[0]);
    for (const [id, text] of Object.entries(sectionReferences(latest))) assert.equal(text, full[id], id);
    const alone = aggregate.buildBantAggregationPrompt(longDeal([meetings[0]]), lumaText);
    assert.equal(isCompleteSection(meetingSections(alone.user)[0], full), false, "dropping the short meeting would not complete the newest one");
  });
}

test("review cases on Vertex: older meetings get the remaining bytes as excerpts, and none is dropped when the newest cannot be complete", async () => {
  const { aggregate, lumaText, inputBytes } = await harness(longDeal([]), "vertex");
  const build = (minutes: number[], density: number) => {
    const meetings = minutes.map((length, index) => meeting(index, speakerTranscript(length, { density, seed: length * 31 + index })));
    const prompt = aggregate.buildBantAggregationPrompt(longDeal(meetings), lumaText);
    return { meetings, prompt, sections: meetingSections(prompt.user), idle: LIMIT - inputBytes(prompt) };
  };
  for (const [name, minutes, density] of [["30+30 at 80%", [30, 30], 0.8], ["5x30 at 15%", [30, 30, 30, 30, 30], 0.15],
    ["5x30 at 80%", [30, 30, 30, 30, 30], 0.8]] as const) {
    const { meetings, prompt, sections, idle } = build([...minutes], density);
    assert.ok(idle >= 0 && idle < 4096, `${name}: ${idle} bytes idle`);
    assert.equal(prompt.inputReduction, "transcript_excerpts", name);
    assert.ok(isCompleteSection(sections[0], aggregate.bantQuoteReferences(meetings[0])), `${name}: the newest meeting keeps every BANT passage`);
    // 最新が完全でも、古い会議はそれぞれ原文の抜粋を保つ（BANT 項目のみにしない）。
    for (const [index, section] of sections.entries()) {
      if (index === 0) continue;
      assert.equal(sectionKind(section), "excerpt", `${name}: meeting ${index} keeps verbatim passages`);
      assert.ok(Object.keys(sectionReferences(section)).length > 20, `${name}: meeting ${index}: ${Object.keys(sectionReferences(section)).length} passages`);
    }
  }
  // 古い会議を縮めるときも、新しい会議は完全になるのに要る分だけを使う。短い古い会議は全文が入るので全文を保つ。
  const mixed = build([40, 20, 10], 0.4);
  assert.equal(sectionKind(mixed.sections[0]), "excerpt", "a complete excerpt, not the whole transcript");
  assert.ok(isCompleteSection(mixed.sections[0], aggregate.bantQuoteReferences(mixed.meetings[0])));
  assert.equal(sectionKind(mixed.sections[1]), "excerpt");
  assert.deepEqual(sectionReferences(mixed.sections[2]), JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(mixed.meetings[2]))));
  assert.ok(mixed.idle < 4096, `${mixed.idle} bytes idle`);
  // 最新が単独でも完全にならないとき、古い会議を完全にするために最新を削らない。
  // 最新の抜粋は、完全でないほかの会議の抜粋と同じくらいのバイトを保つ（1段落ほどの差を除く）。
  for (const [name, minutes, density] of [["90+20+20 at 40%", [90, 20, 20], 0.4], ["60+20x3 at 80%", [60, 20, 20, 20], 0.8],
    ["90+10..13 at 40%", [90, 10, 11, 12, 13], 0.4]] as const) {
    const { meetings, prompt, sections, idle } = build([...minutes], density);
    assert.equal(prompt.inputReduction, "transcript_excerpts", name);
    assert.ok(idle >= 0 && idle < 4096, `${name}: ${idle} bytes idle`);
    const complete = sections.map((section, index) => isCompleteSection(section, aggregate.bantQuoteReferences(meetings[index])));
    assert.equal(complete[0], false, name);
    assert.ok(complete.includes(true), `${name}: an older short meeting is complete`);
    const partial = sections.filter((_, index) => index > 0 && !complete[index]).map(utf8);
    assert.ok(utf8(sections[0]) + 1024 >= Math.max(...partial), `${name}: newest ${utf8(sections[0])} B, others ${partial.join("/")} B`);
  }
  // 最新の会議が単独でも完全にならないなら、古い会議を BANT 項目のみにしない。
  const dense = build([60, 60, 60, 60, 60], 0.8);
  const alone = aggregate.buildBantAggregationPrompt(longDeal([dense.meetings[0]]), lumaText);
  assert.equal(isCompleteSection(meetingSections(alone.user)[0], aggregate.bantQuoteReferences(dense.meetings[0])), false);
  assert.deepEqual(dense.sections.map(sectionKind), ["excerpt", "excerpt", "excerpt", "excerpt", "excerpt"]);
  for (const section of dense.sections) assert.ok(Object.keys(sectionReferences(section)).length > 30);
  assert.ok(dense.idle < 4096, `${dense.idle} bytes idle`);
});

test("a short older meeting keeps all its quote references beside a longer middle meeting when the newest is complete (90+40+5 min, 15% BANT lines)", async () => {
  const { aggregate, lumaText, inputBytes } = await harness(longDeal([]), "vertex");
  const meetings = [90, 40, 5].map((minutes, index) => meeting(index, speakerTranscript(minutes, { density: 0.15, seed: minutes * 31 + index })));
  const prompt = aggregate.buildBantAggregationPrompt(longDeal(meetings), lumaText);
  assert.ok(inputBytes(prompt) <= LIMIT && LIMIT - inputBytes(prompt) < 4096, `${inputBytes(prompt)} bytes`);
  assert.equal(prompt.inputReduction, "transcript_excerpts");
  const [newest, middle, short] = meetingSections(prompt.user);
  assert.ok(isCompleteSection(newest, aggregate.bantQuoteReferences(meetings[0])), "the newest keeps every BANT passage");
  assert.match(short, /Not repeated: the primary quote references below contain every passage/u);
  const shortReferences = JSON.parse(JSON.stringify(aggregate.bantQuoteReferences(meetings[2]))) as Record<string, string>;
  assert.equal(Object.keys(shortReferences).length, 106);
  assert.deepEqual(sectionReferences(short), shortReferences);
  // 間の会議も BANT 項目のみにせず、残りのバイトで原文の抜粋を保つ。
  assert.equal(sectionKind(middle), "excerpt");
  const middleReferences = aggregate.bantQuoteReferences(meetings[1]);
  assert.ok(Object.keys(sectionReferences(middle)).length > 0);
  for (const [id, text] of Object.entries(sectionReferences(middle))) assert.equal(text, middleReferences[id], id);
});

test("over-limit Vertex prompts fit, stay grounded, label their final sections and never leave 4 KB idle beside a BANT-only meeting", async () => {
  const { aggregate, lumaText, inputBytes } = await harness(longDeal([]), "vertex");
  const layouts = [[60, 5], [90, 10], [30, 30], [40, 20, 10], [30, 31, 32, 33, 34], [60, 61, 62, 63, 64], [10, 90], [90, 10, 11, 12, 13], [60, 1],
    [90, 40, 5], [90, 30, 5], [90, 20, 21], [45, 46, 10], [60, 20, 21, 22], [90, 15, 16, 17, 18], [30, 10, 11, 12, 13], [60, 8, 9, 10, 11], [40, 61, 62, 63, 64]];
  for (const density of [0.15, 0.4, 0.8]) {
    for (const [layoutIndex, layout] of layouts.entries()) {
      const labels = layoutIndex === 0 ? ["営業", "顧客"] : ["話者1", "話者2"];
      const meetings = layout.map((minutes, index) => meeting(index, speakerTranscript(minutes, { density, labels, seed: minutes * 31 + index })));
      const prompt = aggregate.buildBantAggregationPrompt(longDeal(meetings), lumaText);
      const name = `${labels[0]} ${layout.join("+")} min at ${density * 100}%`;
      const bytes = inputBytes(prompt);
      assert.ok(prompt.inputReduction && bytes <= LIMIT, `${name}: ${bytes} bytes`);
      const sections = meetingSections(prompt.user);
      const kinds = sections.map(sectionKind);
      assert.equal(prompt.inputReduction, expectedReduction(kinds), `${name}: ${kinds.join(",")}`);
      sections.forEach((section, index) => {
        const full = aggregate.bantQuoteReferences(meetings[index]);
        for (const [id, text] of Object.entries(sectionReferences(section))) assert.equal(text, full[id], `${name}: ${id}`);
      });
      const { inputs, complete, room } = allocationFacts(aggregate, meetings, prompt.user, bytes);
      for (const input of inputs) {
        assert.ok(input.leastExcerptBytes !== undefined && input.excerpt?.(input.leastExcerptBytes), `${name}: the least excerpt fits its own size`);
        assert.equal(input.excerpt?.(input.leastExcerptBytes - 1), null, `${name}: nothing smaller is an excerpt`);
      }
      // 新しい順の完全さは、修正前の配分より辞書順で下がらない。
      const completeness = complete.map((value) => (value ? "1" : "0")).join("");
      const previous = previousCompleteness(inputs, room);
      assert.ok(completeness >= previous, `${name}: ${completeness} < ${previous} before the fix (${kinds.join(",")})`);
      // 完全な会議を完全なまま、ほかの会議すべてに最小の抜粋が入るなら、どの会議も BANT 項目のみにならない。
      const need = inputs.reduce((sum, input, index) => sum + (complete[index] ? costs(input).complete : costs(input).least), 0);
      if (need <= room) assert.ok(!kinds.includes("bant"), `${name}: ${kinds.join(",")} although ${need} <= ${room} bytes`);
      if (!kinds.includes("bant")) continue;
      assert.ok(LIMIT - bytes < 4096, `${name}: ${LIMIT - bytes} bytes idle beside ${kinds.join(",")}`);
      // BANT 項目のみの会議があるなら、それより新しい会議のどれかが完全になっている。
      assert.ok(complete.slice(0, kinds.indexOf("bant")).includes(true), `${name}: ${kinds.join(",")}`);
    }
  }
});

test("the recorded input reduction follows the final sections, and over_limit only when BANT fields alone do not fit", async () => {
  const { aggregate, lumaText: catalog, inputBytes } = await harness(longDeal([]), "vertex");
  const lumaText = sameMeetingRoom(catalog);
  const reduce = (deal: DealForBant) => {
    const prompt = aggregate.buildBantAggregationPrompt(deal, lumaText);
    return { prompt, kinds: meetingSections(prompt.user).map(sectionKind) };
  };
  // Review case: an excerpt and complete quote references, with no meeting reduced to BANT fields.
  const excerpts = reduce(longDeal([meeting(0, speakerTranscript(90)), meeting(1, speakerTranscript(10))]));
  assert.deepEqual(excerpts.kinds, ["excerpt", "full"]);
  assert.equal(excerpts.prompt.inputReduction, "transcript_excerpts");
  const references = reduce(longDeal([meeting(0, speakerTranscript(30))]));
  assert.deepEqual(references.kinds, ["full"]);
  assert.equal(references.prompt.inputReduction, "quote_references");
  const dropped = reduce(longDeal([60, 61, 62, 63].map((minutes, index) => meeting(index, speakerTranscript(minutes)))));
  assert.ok(dropped.kinds.includes("bant"));
  assert.equal(dropped.prompt.inputReduction, "older_meetings_bant_only");
  const excerptsOnly = reduce(longDeal([60, 61, 62, 63, 64].map((minutes, index) => meeting(index, speakerTranscript(minutes)))));
  assert.deepEqual(excerptsOnly.kinds, ["excerpt", "excerpt", "excerpt", "excerpt", "excerpt"]);
  assert.equal(excerptsOnly.prompt.inputReduction, "transcript_excerpts");
  const over = reduce({ ...longDeal([meeting(0, speakerTranscript(90))]), title: "長".repeat(25000) });
  assert.deepEqual(over.kinds, ["bant"]);
  assert.ok(inputBytes(over.prompt) > LIMIT);
  assert.equal(over.prompt.inputReduction, "over_limit");
});

test("the BANT card shows a stored automatic aggregation failure", async () => {
  const code = await bundle("src/components/deals/bant-summary.tsx", {
    "next/navigation": "export const useRouter=()=>({refresh(){}});",
  }, [
    "src/components/ui/card.tsx", "src/components/ui/badge.tsx", "src/components/ui/button.tsx", "src/components/ui/textarea.tsx",
    "src/components/ui/label.tsx", "src/lib/utils.ts", "src/components/deals/deal-navigation.ts", "src/components/deals/bant-summary-utils.ts",
    // 先方の表示用の体裁整形（■・① の体裁。2026-08 社長判断）。
    "src/lib/text-format.ts",
    ...["bant-reconciliation", "bant-definitions", "bant-withdrawal", "timeline-evidence"].map(ai),
  ], ["react", "react/jsx-runtime", "lucide-react", "clsx", "tailwind-merge", "class-variance-authority", "@radix-ui/react-slot", "@radix-ui/react-label"], true);
  const external = ["react", "react/jsx-runtime", "lucide-react", "clsx", "tailwind-merge", "class-variance-authority", "@radix-ui/react-slot", "@radix-ui/react-label"];
  const { BantSummary } = run<typeof import("../src/components/deals/bant-summary")>(code, {}, external);
  const { createElement } = localRequire("react") as typeof import("react");
  const { renderToStaticMarkup } = localRequire("react-dom/server") as typeof import("react-dom/server");
  const render = (initial: Record<string, unknown>, canEdit: boolean) => renderToStaticMarkup(createElement(BantSummary, {
    dealId: "long-deal", initial: initial as BantValue, bantUpdatedAt: null, meetingsCount: 1, canEdit, meetings: [],
  })).replace(/<!-- -->/gu, "");
  const lastError = { message: "今回のAI検証では入力が長すぎます。文章を短くして再実行してください。", at: "2026-09-28T06:00:00.000Z" };
  const editable = render({ budget: "80万円", lastError }, true);
  assert.match(editable, /BANTの自動集約に失敗しました（2026\/09\/28）。今回のAI検証では入力が長すぎます。/u);
  assert.match(editable, /「AI再集約」で再実行できます。/u);
  assert.doesNotMatch(render({ budget: "80万円", lastError }, false), /「AI再集約」で再実行できます。/u);
  assert.doesNotMatch(render({ lastError }, false), /まだBANT情報が登録されていません。[\s\S]*自動集約に失敗/u);
  assert.match(render({ lastError }, false), /自動集約に失敗しました/u);
  for (const invalid of [undefined, "text", { message: "" , at: lastError.at }, { message: lastError.message, at: "invalid" }]) {
    assert.doesNotMatch(render({ budget: "80万円", lastError: invalid }, true), /自動集約に失敗しました/u);
  }
});
