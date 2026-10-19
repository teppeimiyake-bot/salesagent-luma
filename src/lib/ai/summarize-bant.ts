import { after } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { buildSystemText, callClaudeHeavyJSON } from "@/lib/ai/anthropic";
import { getHeavyTextProvider } from "@/lib/ai/provider";
import { VERTEX_MAX_INPUT_BYTES, VertexError } from "@/lib/ai/vertex-policy";
import {
  BANT_KEYS,
  BANT_UNKNOWN_VALUES,
  formatBantDefinitions,
  type BantKey,
  type BantStatus,
} from "@/lib/ai/bant-definitions";
import {
  formatLumaContextForPrompt,
  getCachedLumaContextText,
  getLumaContextText,
  type LumaContextDealProduct,
} from "@/lib/ai/luma-context";
import { repairUtf8Mojibake } from "@/components/deals/bant-summary-utils";
import {
  BANT_RECENT_MEETINGS_LIMIT,
  bantQuotationSources,
  constrainBantStatus,
  findMeetingBantEvidence,
  isUnknownBantValue,
  normalizeUnconfirmedNeed,
  reconcileBantFromMeetings,
} from "./bant-reconciliation";

export { BANT_RECENT_MEETINGS_LIMIT } from "./bant-reconciliation";
import { retainAdoptionConditions } from "./customer-conditions";
import { splitRunOnSpeakerTurns } from "./timeline-evidence";
import { releaseBantSummaryLock, waitForBantSummaryLock, type BantSummaryLease } from "@/lib/ai/bant-summary-lock";
const DEBOUNCE_MS = 5 * 60 * 1000;
export const BANT_AGGREGATION_PROMPT_VERSION = "20261001-product-names-confidence-v2";
const BANT_PROMPT_KEYS = [
  "budget",
  "authority",
  "need",
  "timeline",
  "summary",
  "confidence",
  "items",
  "updatedBy",
  "manualFields",
] as const;

export type BantItem = {
  value: string;
  status: BantStatus;
  source_meeting_id: string;
  quote: string;
};

export type BantManualFields = Record<BantKey, boolean>;

export type DealBantSummary = {
  budget: string;
  authority: string;
  need: string;
  timeline: string;
  summary: string;
  confidence: number;
  items: Record<BantKey, BantItem>;
  updatedBy: "auto" | "manual";
  manualFields: BantManualFields;
  aiSuggestion?: Partial<Record<BantKey, BantItem>>;
  [key: string]: unknown;
};

export type BantAggregationResult = {
  bant: DealBantSummary;
  fallback: boolean;
  skipped?: boolean;
  prompt?: string;
};

export type MeetingForBant = {
  id: string;
  title: string | null;
  meetingDate: Date;
  minutes: string | null;
  minutesJson: unknown;
  transcript: string | null;
  sourceType?: string;
  bantBudget: string | null;
  bantAuthority: string | null;
  bantNeed: string | null;
  bantTimeline: string | null;
};

export type DealForBant = {
  id: string;
  title: string;
  status: string;
  bant: unknown;
  bantUpdatedAt: Date | null;
  company: { name: string; industry: string | null };
  products: Array<{
    productName: string;
    planName: string | null;
    yomiStatus: string | null;
    amount: number | null;
  }>;
  meetings: MeetingForBant[];
};

export function emptyManualFields(): BantManualFields {
  return {
    budget: false,
    authority: false,
    need: false,
    timeline: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return repairUtf8Mojibake(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function readBantString(bant: unknown, key: BantKey): string {
  if (!isRecord(bant)) return "";
  const direct = bant[key];
  if (typeof direct === "string") return direct;
  if (isRecord(direct) && typeof direct.value === "string") return direct.value;
  const items = bant.items;
  if (isRecord(items)) {
    const item = items[key];
    if (isRecord(item) && typeof item.value === "string") return item.value;
  }
  return "";
}

function normalizeStatus(value: unknown, fallback: BantStatus): BantStatus {
  return value === "confirmed" || value === "estimated" || value === "unknown" ? value : fallback;
}

function normalizeManualFields(value: unknown): BantManualFields {
  const input = isRecord(value) ? value : {};
  return {
    budget: input.budget === true,
    authority: input.authority === true,
    need: input.need === true,
    timeline: input.timeline === true,
  };
}

function normalizeBantItem(value: unknown, key: BantKey, fallbackValue?: string, preserveManualStatus = false): BantItem {
  const normalizeValue = (candidate: string) => key === "need" && !preserveManualStatus
    ? normalizeUnconfirmedNeed(candidate) : candidate;
  if (isRecord(value)) {
    const itemValue = normalizeValue(toStringValue(value.value) || fallbackValue || BANT_UNKNOWN_VALUES[key]);
    const status = normalizeStatus(value.status, isUnknownBantValue(itemValue) ? "unknown" : "estimated");
    return {
      value: itemValue,
      status: preserveManualStatus ? status : constrainBantStatus(key, itemValue, status, value.quote),
      source_meeting_id: toStringValue(value.source_meeting_id),
      quote: typeof value.quote === "string" ? toStringValue(value.quote) : "該当する発言なし",
    };
  }
  const str = normalizeValue(toStringValue(value) || fallbackValue || BANT_UNKNOWN_VALUES[key]);
  return {
    value: str,
    status: isUnknownBantValue(str) ? "unknown" : "estimated",
    source_meeting_id: "",
    quote: isUnknownBantValue(str) ? "該当する発言なし" : str,
  };
}

function normalizeItems(raw: unknown, topLevel: Record<BantKey, string>): Record<BantKey, BantItem> {
  const items = isRecord(raw) ? raw.items : undefined;
  return {
    budget: normalizeBantItem(isRecord(items) ? items.budget : undefined, "budget", topLevel.budget),
    authority: normalizeBantItem(
      isRecord(items) ? items.authority : undefined,
      "authority",
      topLevel.authority,
    ),
    need: normalizeBantItem(isRecord(items) ? items.need : undefined, "need", topLevel.need),
    timeline: normalizeBantItem(
      isRecord(items) ? items.timeline : undefined,
      "timeline",
      topLevel.timeline,
    ),
  };
}

export function normalizeDealBant(raw: unknown): DealBantSummary {
  const obj = isRecord(raw) ? raw : {};
  const manualFields = normalizeManualFields(obj.manualFields);
  const valueFor = (key: BantKey) => {
    const value = readBantString(obj, key);
    if (manualFields[key]) return value;
    return (key === "need" ? normalizeUnconfirmedNeed(value) : value) || BANT_UNKNOWN_VALUES[key];
  };
  const topLevel: Record<BantKey, string> = {
    budget: valueFor("budget"),
    authority: valueFor("authority"),
    need: valueFor("need"),
    timeline: valueFor("timeline"),
  };
  const items = normalizeItems(obj, topLevel);
  for (const key of BANT_KEYS) {
    if (manualFields[key]) {
      items[key] = normalizeBantItem(isRecord(obj.items) ? obj.items[key] : undefined, key, topLevel[key], true);
    }
    if (manualFields[key] && !topLevel[key]) {
      items[key] = { ...items[key], value: "", status: "unknown" };
    }
  }
  return {
    ...obj,
    ...topLevel,
    summary: toStringValue(obj.summary),
    confidence:
      typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
        ? Math.max(0, Math.min(100, Math.round(obj.confidence)))
        : 0,
    items,
    updatedBy: obj.updatedBy === "manual" ? "manual" : "auto",
    manualFields,
    aiSuggestion: isRecord(obj.aiSuggestion)
      ? (obj.aiSuggestion as Partial<Record<BantKey, BantItem>>)
      : undefined,
  };
}

/** 確定・推定の項目1つにつき20（最大80）。AI が確度を返さないときに使う。 */
function confidenceFromStatuses(items: Record<BantKey, BantItem>): number {
  return BANT_KEYS.reduce((score, key) => score + (items[key].status === "unknown" ? 0 : 20), 0);
}

/**
 * T18（2026-10-01 再実行）: 新しいモデルが 0〜100 ではない尺度で返した（全項目確定で 5 など）。指示で 0〜100 を明記したうえで、
 * 読み替えは誤りを増やさない範囲に限る。
 * - 0〜1 の小数（0.85）だけは割合として百分率にする。整数の小さい値（5、10）は 0〜100 の値として読み替えない。
 * - 数字の文字列（"80"、"80%"）は数値として読み、範囲外は 0〜100 に収めて整数に丸める。値が無ければ項目の状態から計算する。
 * AI の出力に1回だけ使う。merge（clampConfidence）と手入力の値（normalizeDealBant）は読み替えない。
 */
export function normalizeAiConfidence(value: unknown, items: Record<BantKey, BantItem>): number {
  const parsed = typeof value === "number" ? value
    : typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*[%％]?\s*$/u.test(value) ? Number.parseFloat(value) : NaN;
  if (!Number.isFinite(parsed)) return confidenceFromStatuses(items);
  if (parsed > 0 && parsed < 1) return Math.round(parsed * 100);
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

/** 正規化済みの値を 0〜100 の整数に収めるだけ（尺度は読み替えない）。 */
function clampConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
}

export function normalizeBantAiOutput(raw: unknown): DealBantSummary {
  const obj = isRecord(raw) ? raw : {};
  const rawItems = isRecord(obj.items) ? obj.items : obj;
  const items: Record<BantKey, BantItem> = {
    budget: normalizeBantItem(rawItems.budget, "budget", toStringValue(obj.budget)),
    authority: normalizeBantItem(rawItems.authority, "authority", toStringValue(obj.authority)),
    need: normalizeBantItem(rawItems.need, "need", toStringValue(obj.need)),
    timeline: normalizeBantItem(rawItems.timeline, "timeline", toStringValue(obj.timeline)),
  };
  return {
    budget: items.budget.value,
    authority: items.authority.value,
    need: items.need.value,
    timeline: items.timeline.value,
    summary: toStringValue(obj.summary),
    confidence: normalizeAiConfidence(obj.confidence, items),
    items,
    updatedBy: "auto",
    manualFields: emptyManualFields(),
  };
}

// ============================================================
// T18 C3（2026-10-01 再実行）: 原文「制作費は80万円を目安に…」の案件BANT要約に、登録商材名を足して
// 「採用動画の制作費として80万円」と書いた。9/23 に議事録で不合格にした「商材名の流入」と同じ種類の誤り。
// 指示に加えて、案件の全会議の原文（文字起こし・手入力の議事録）と手入力の BANT 項目に無い登録商材名を AI の出力から除く。
// ============================================================

/** 「SNS運用代行（6ヶ月）」の末尾の括弧書き（期間・プランの補足）を除いた名前。 */
function productBaseName(name: string): string {
  return name.replace(/[ \t　]*[（(][^（）()]*[）)][ \t　]*$/u, "").trim();
}

/** 照合用の正規化（全角・半角と空白の違いを無視する）。原文と AI の出力の両方に同じものを使う。 */
function compactForProductMatch(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

/** 登録商材の商材名・プラン名（と括弧書きを除いた名前）。長い順（長い名前の一部を短い名前として扱わない）。 */
function registeredProductNames(products: DealForBant["products"]): string[] {
  const names = new Map<string, string>();
  for (const product of products) {
    for (const raw of [product.productName, product.planName]) {
      const name = raw?.trim();
      if (!name) continue;
      for (const candidate of [name, productBaseName(name)]) {
        const key = compactForProductMatch(candidate);
        if (key.length >= 2 && !names.has(key)) names.set(key, key);
      }
    }
  }
  return [...names.values()].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** NFKC で同じになる全角・半角のどちらにも、文字の間の空白にも合う正規表現（name は正規化済み）。 */
function flexibleNamePattern(name: string): string {
  return [...name].map((char) => {
    const variants = new Set([char]);
    const code = char.charCodeAt(0);
    if (code >= 0x21 && code <= 0x7e) variants.add(String.fromCharCode(code + 0xfee0));
    for (const wide of "（）〜ー－") if (wide.normalize("NFKC") === char) variants.add(wide);
    const alternatives = [...variants].map(escapeRegExp);
    return alternatives.length > 1 ? `(?:${alternatives.join("|")})` : alternatives[0];
  }).join(String.raw`[ \t　]*`);
}

// 「採用動画の制作費」の「採用動画の」は、費用の対象を特定するだけの修飾なので外せる（要約用）。
const PRODUCT_COST_MODIFIER = "(?:の|向けの|用の)(?=制作費|費用|予算|金額|価格|見積)";
// 項目の値では、名前とそれに続く助詞をまとめて外す（「採用動画と合わせて80万円」→「80万円」）。
const PRODUCT_PARTICLE = "(?:と合わせて|とあわせて|向けの|用の|の|と|や|を|が|は|で|に|、)";

type ProductNameMatcher = { pattern: (suffix: string) => RegExp; isSpoken: (name: string) => boolean };

function productNameMatcher(names: readonly string[], spokenText: string): ProductNameMatcher {
  const spoken = compactForProductMatch(spokenText);
  return {
    pattern: (suffix) => new RegExp(`(${names.map(flexibleNamePattern).join("|")})(${suffix})?`, "gu"),
    isSpoken: (name) => spoken.includes(compactForProductMatch(name)),
  };
}

/** 原文に無い名前を置き換える。戻り値 null は外せない（呼び出し側が文ごと除くか判断する）。 */
function replaceUnspokenNames(text: string, matcher: ProductNameMatcher, suffix: string, found: Set<string>,
  removeWithSuffixOnly: boolean): string | null {
  let unresolved = false;
  const replaced = text.replace(matcher.pattern(suffix), (match: string, name: string, attached: string | undefined) => {
    if (matcher.isSpoken(name)) return match;
    found.add(name);
    const base = productBaseName(name);
    // 原文にあるのは括弧書きを除いた名前だけなら、その名前に戻す。
    if (base !== name && compactForProductMatch(base).length >= 2 && matcher.isSpoken(base)) return base + (attached ?? "");
    if (attached || !removeWithSuffixOnly) return "";
    unresolved = true;
    return match;
  });
  return unresolved ? null : replaced;
}

/**
 * 要約から原文に無い登録商材名を除く。費用の対象を示す修飾（「採用動画の制作費」）は名前だけ外し、
 * 名前が主語・目的語の文（「SNS運用代行の導入を希望」）は、名前だけ外すと別の主張になるので文ごと除く。
 */
export function removeUnspokenProductNames(
  text: string,
  names: readonly string[],
  spokenText: string,
  found: Set<string>,
): string {
  if (!text || !names.length) return text;
  const matcher = productNameMatcher(names, spokenText);
  return text.split(/(?<=[。！？!?\n])/u).map((sentence) => {
    const replaced = replaceUnspokenNames(sentence, matcher, PRODUCT_COST_MODIFIER, found, true);
    if (replaced !== null) return replaced;
    // 文末の改行は残す（次の文とつながらないように）。
    return sentence.endsWith("\n") ? "\n" : "";
  }).join("").replace(/\n{2,}/gu, "\n").trim();
}

/** 項目の値から、原文に無い登録商材名とそれに続く助詞だけを外す（文ごとは除かない）。 */
function removeUnspokenProductNamesFromValue(value: string, names: readonly string[], spokenText: string, found: Set<string>): string {
  if (!value || !names.length) return value;
  const matcher = productNameMatcher(names, spokenText);
  return (replaceUnspokenNames(value, matcher, PRODUCT_PARTICLE, found, false) ?? value)
    .replace(/^[、,\s]+/u, "").replace(/[ \t　]{2,}/gu, " ").trim();
}

/** 話者ラベルを除いた引用の本文。 */
function quoteBody(quote: string): string {
  return quote.replace(/^[ \t　]*(?:顧客|先方|お客様)\s*[:：]\s*/u, "").trim();
}

export function guardUnspokenProductNames(
  bant: DealBantSummary,
  deal: Pick<DealForBant, "products" | "meetings" | "bant">,
  allMeetingSources: readonly string[] = [],
): { bant: DealBantSummary; names: string[] } {
  const names = registeredProductNames(deal.products);
  if (!names.length) return { bant, names: [] };
  // 照合の対象は人が書いたものだけ: 全会議の原文（文字起こし・手入力の議事録）と、手入力の BANT 項目。
  // AI が作った前回の値・要約は入れない（混入済みの商材名が根拠として残り続けるため）。
  const manual = normalizeManualFields(isRecord(deal.bant) ? deal.bant.manualFields : undefined);
  const spokenText = [
    ...deal.meetings.flatMap((meeting) => bantQuotationSources(meeting)),
    ...allMeetingSources,
    ...BANT_KEYS.filter((key) => manual[key]).map((key) => readBantString(deal.bant, key)),
  ].join("\n");
  const found = new Set<string>();
  const items = { ...bant.items };
  for (const key of BANT_KEYS) {
    const item = items[key];
    const value = removeUnspokenProductNamesFromValue(item.value, names, spokenText, found);
    if (value === item.value) continue;
    const quote = quoteBody(item.quote);
    // 引用（原文）のある項目は未確定に落とさない。名前を外して中身が残らなければ、引用の本文を値にする。
    const substantive = value.replace(/[\s。、．.,！？!?]/gu, "").length >= 4;
    if (quote) {
      const next = substantive ? value : quote;
      items[key] = { ...item, value: next, status: constrainBantStatus(key, next, item.status, item.quote) };
    } else {
      // 引用の無い項目は、商材名を外した残りにも根拠が無いので未確定に戻す（読み取り時の補正が会議の BANT から補う）。
      items[key] = { value: BANT_UNKNOWN_VALUES[key], status: "unknown", source_meeting_id: "", quote: "" };
    }
  }
  const summary = removeUnspokenProductNames(bant.summary, names, spokenText, found);
  if (!found.size) return { bant, names: [] };
  return {
    bant: {
      ...bant,
      budget: items.budget.value,
      authority: items.authority.value,
      need: items.need.value,
      timeline: items.timeline.value,
      summary,
      items,
    },
    names: [...found],
  };
}

/** 商材名の確認に使う、案件の全会議（直近5件より古い会議を含む）の原文。 */
async function loadAllMeetingSources(dealId: string): Promise<string[]> {
  const meetings = await prisma.meeting.findMany({
    where: { dealId },
    select: { transcript: true, minutes: true, minutesJson: true, sourceType: true },
  });
  return meetings.flatMap((meeting) => bantQuotationSources(meeting));
}

export function mergeDealBant(
  existingRaw: unknown,
  generatedRaw: unknown,
  source: "auto" | "manual" = "auto",
): DealBantSummary {
  const existingObj = isRecord(existingRaw) ? existingRaw : {};
  const generated = normalizeBantAiOutput(generatedRaw);
  // generatedRaw は AI の経路では正規化済み、失敗時は保存済みの値。もう一度 AI 用の読み替えをしない。
  const confidence = clampConfidence(isRecord(generatedRaw) ? generatedRaw.confidence : undefined);
  if (confidence !== null) generated.confidence = confidence;
  const manualFields = normalizeManualFields(existingObj.manualFields);
  const next: DealBantSummary = {
    ...existingObj,
    ...generated,
    items: { ...generated.items },
    manualFields,
    updatedBy: source,
  };

  const existingItems = isRecord(existingObj.items) ? existingObj.items : {};
  const aiSuggestion: Partial<Record<BantKey, BantItem>> = isRecord(existingObj.aiSuggestion)
    ? { ...(existingObj.aiSuggestion as Partial<Record<BantKey, BantItem>>) }
    : {};

  for (const key of BANT_KEYS) {
    if (!manualFields[key]) continue;
    const protectedValue = readBantString(existingObj, key);
    next[key] = protectedValue;
    next.items[key] = normalizeBantItem(existingItems[key], key, next[key], true);
    if (!protectedValue) next.items[key] = { ...next.items[key], value: "", status: "unknown" };
    aiSuggestion[key] = generated.items[key];
  }

  if (Object.keys(aiSuggestion).length > 0) {
    next.aiSuggestion = aiSuggestion;
  } else {
    delete next.aiSuggestion;
  }

  return next;
}

function meetingBantText(meeting: MeetingForBant, key: BantKey): string {
  const field = {
    budget: meeting.bantBudget,
    authority: meeting.bantAuthority,
    need: meeting.bantNeed,
    timeline: meeting.bantTimeline,
  }[key];
  return field?.trim() ?? "";
}

/** Reference IDs point to immutable primary passages, never generated BANT or
 * minutes. Prefer explicitly labelled customer turns when speaker labels exist.
 * Keep whole passages so an approval/conditional caveat is not clipped off.
 */
export function bantQuoteReferences(meeting: MeetingForBant): Record<string, string> {
  return Object.fromEntries(quoteReferenceUnits(meeting).flatMap(unit => unit.ref ? [[unit.ref, unit.text]] : []));
}

type QuoteUnit = { text: string; ref?: string };

/** Every primary passage in original order; only quotable passages carry an ID. */
function quoteReferenceUnits(meeting: MeetingForBant): QuoteUnit[] {
  // 1行に続けて書かれた複数の発話（改行の無い文字起こし）は、話者ラベルで分けてから引用の単位にする（全文を1つの引用にしない）。
  const passages = bantQuotationSources(meeting).flatMap(source => splitRunOnSpeakerTurns(source).split(/\r?\n(?=\S|[ \t\u3000]*(?:顧客|先方|お客様|営業|当社|弊社)\s*[:：])/u).map(line => line.trim()).filter(Boolean));
  const isCustomer = (p: string) => /^(?:顧客|先方|お客様)\s*[:：]/u.test(p) && !/(?:営業|顧客|先方|お客様)\s*[:：]/u.test(p.replace(/^[^:：]+[:：]/u,""));
  const customersOnly = passages.some(isCustomer);
  let count = 0;
  return passages.map((text) => {
    const quotable = customersOnly ? isCustomer(text) : !/^(?:営業|当社|弊社)\s*[:：]/u.test(text);
    return quotable ? { text, ref: `q${++count}` } : { text };
  });
}

export function resolveBantQuoteReferences(raw: unknown, meetings: MeetingForBant[]): unknown {
  if (!isRecord(raw) || !isRecord(raw.items)) return raw;
  const items = {...raw.items};
  for (const key of BANT_KEYS) {
    const item = items[key];
    if (!isRecord(item) || !("quote_ref" in item)) continue;
    const meeting = meetings.slice(0, BANT_RECENT_MEETINGS_LIMIT).find(source => source.id === item.source_meeting_id);
    const quote = meeting && typeof item.quote_ref === "string" ? bantQuoteReferences(meeting)[item.quote_ref] ?? "" : "";
    // Never let invalid reference IDs fall back to a model-authored quotation.
    items[key] = {...item, quote};
  }
  return {...raw, items};
}

function meetingInputParts(meeting: MeetingForBant, index: number) {
  const title = meeting.title || `Meeting ${index + 1}`;
  const date = meeting.meetingDate.toISOString().slice(0, 10);
  // Later corrections and qualifications are primary evidence too. Never
  // silently clip a transcript; only an over-limit input is reduced below.
  // Avoid repeating derived minutes when their complete source is available.
  const transcript = meeting.transcript?.trim() ?? "";
  const minutesJson = !transcript && meeting.minutesJson ? JSON.stringify(meeting.minutesJson).slice(0, 2400) : "";
  const minutes = !transcript ? meeting.minutes?.trim().slice(0, 1600) ?? "" : "";
  const bantLines = BANT_KEYS.map((key) => `- ${key}: ${meetingBantText(meeting, key) || "未確定"}`).join("\n");
  const manualMinutes = !transcript && meeting.sourceType === "manual_text" && meeting.minutesJson === null
    ? bantQuotationSources(meeting).find((source) => source === meeting.minutes?.trim()) ?? ""
    : "";
  return {
    heading: [`## ${title} (${date})`, `meeting_id: ${meeting.id}`],
    secondary: [
      minutesJson ? `### generated/derived minutesJson (secondary context; never quote as original speech)\n${minutesJson}` : "",
      !minutesJson && minutes && !manualMinutes ? `### minutes of unverified origin (secondary context; not a quotation source)\n${minutes}` : "",
    ],
    manualMinutes,
    bant: `### meeting BANT (derived values; not a quotation source)\n${bantLines}`,
    transcript,
  };
}

function summarizeMeetingInput(meeting: MeetingForBant, index: number): string {
  const parts = meetingInputParts(meeting, index);
  return [
    ...parts.heading,
    ...parts.secondary,
    parts.manualMinutes ? `### manual minutes (primary written record; literal quotation allowed)\n${parts.manualMinutes}` : "",
    parts.bant,
    parts.transcript ? `### complete transcript (primary evidence)\n${parts.transcript}` : "",
    `### primary quote references for this meeting\n${JSON.stringify(bantQuoteReferences(meeting))}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// The Vertex provider rejects system + user above this size before reserving a call.
const BANT_INPUT_BYTE_LIMIT = VERTEX_MAX_INPUT_BYTES;
const LONG_TRANSCRIPT_EXCERPT_LABEL = "Long transcript: verbatim excerpts only (omitted lines are not evidence of absence)";
const EXCERPT_OMISSION = "[omitted]";
// Deterministic BANT relevance: budget, authority, need, timeline, changes and uncertainty.
const BANT_EXCERPT_PATTERN = /予算|円|万|費用|見積|決裁|承認|稟議|部長|社長|役員|担当|課題|困|悩|目的|導入|時期|開始|公開|納品|月|日|までに|期限|予定|撤回|取り下げ|白紙|訂正|変更|未定|未確認|未集計|未合意|検討/gu;

export type BantInputReduction = "quote_references" | "transcript_excerpts" | "older_meetings_bant_only" | "over_limit";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

type MeetingPromptInput = {
  /** Today's section, or the quote references alone when they repeat the whole primary text. */
  full: string;
  /** Per-meeting BANT fields only. */
  bantOnly: string;
  /** Verbatim BANT-related passages within maxBytes; null when not even one BANT passage (with its preceding passage) fits. */
  excerpt?: (maxBytes: number) => { section: string; complete: boolean } | null;
  /** excerpt が null にならない最小のバイト数（BANT 関連段落1つとその直前の段落）。 */
  leastExcerptBytes?: number;
};

function meetingPromptInput(meeting: MeetingForBant, index: number): MeetingPromptInput {
  const parts = meetingInputParts(meeting, index);
  const complete = summarizeMeetingInput(meeting, index);
  const primaryHeading = parts.transcript ? "### complete transcript (primary evidence)"
    : parts.manualMinutes ? "### manual minutes (primary written record; literal quotation allowed)" : "";
  const units = quoteReferenceUnits(meeting);
  // Speaker-N transcripts have no customer labels, so every passage is already a reference.
  const covered = !!primaryHeading && units.every((unit) => unit.ref);
  const section = (...body: string[]) => [...parts.heading, ...parts.secondary, parts.bant, ...body].filter(Boolean).join("\n");
  const references = (selected: QuoteUnit[]) => `### primary quote references for this meeting\n${JSON.stringify(
    Object.fromEntries(selected.flatMap((unit) => unit.ref ? [[unit.ref, unit.text]] : [])),
  )}`;
  const bantOnly = [
    ...parts.heading,
    parts.bant,
    "### primary evidence omitted to fit the input limit (not evidence of absence; no quote references for this meeting in this input)",
  ].join("\n");
  const full = covered
    ? section(`${primaryHeading}\nNot repeated: the primary quote references below contain every passage of it, verbatim and in original order.`, references(units))
    : complete;
  if (!primaryHeading) return { full, bantOnly };

  const render = (selected: ReadonlySet<number>) => {
    const lines: string[] = [];
    units.forEach((unit, position) => {
      if (selected.has(position)) lines.push(unit.text);
      else if (lines.at(-1) !== EXCERPT_OMISSION) lines.push(EXCERPT_OMISSION);
    });
    return section(
      `### ${LONG_TRANSCRIPT_EXCERPT_LABEL}`,
      covered
        ? "BANT-related passages and the passage before each, verbatim and in original order, are the primary quote references below."
        : `BANT-related passages and the passage before each, verbatim and in original order. ${EXCERPT_OMISSION} marks skipped passages.\n${lines.join("\n")}`,
      references(units.filter((_, position) => selected.has(position))),
    );
  };
  // Denser BANT passages first, and later statements (corrections) before earlier ones.
  const ranked = units
    .map((unit, position) => ({ position, score: new Set(unit.text.match(BANT_EXCERPT_PATTERN)).size }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.position - a.position)
    .map(({ position }) => position);
  const build = (count: number) => {
    const selected = new Set<number>();
    for (const position of ranked.slice(0, count)) {
      selected.add(position);
      if (position > 0) selected.add(position - 1);
    }
    return render(selected);
  };
  // 配分では同じ段落数を何度も測るので、バイト数だけを覚えておく。
  const sizes = new Map<number, number>();
  const size = (count: number) => {
    const known = sizes.get(count);
    if (known !== undefined) return known;
    const bytes = byteLength(build(count));
    sizes.set(count, bytes);
    return bytes;
  };
  return {
    full,
    bantOnly,
    excerpt: (maxBytes) => {
      if (size(0) > maxBytes) return null;
      let low = 0;
      let high = ranked.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size(middle) <= maxBytes) low = middle;
        else high = middle - 1;
      }
      // BANT 関連段落を1つも入れられないなら、見出しだけの抜粋にはしない（BANT 項目のみにする）。
      if (low === 0 && ranked.length > 0) return null;
      return { section: build(low), complete: low === ranked.length };
    },
    leastExcerptBytes: size(Math.min(1, ranked.length)),
  };
}

type MeetingAllocation = {
  section: string;
  /** BANT 項目のみの section より増えるバイト数（全文のほうが短ければ負）。 */
  used: number;
  kind: "full" | "excerpt" | "bant";
  /** 全文（または全段落を含む引用候補）か、BANT 関連段落をすべて含む抜粋。 */
  complete: boolean;
};

/**
 * 上限を超える入力だけを縮める。まず全段落を含む引用候補で重複する文字起こしを省く。
 * それでも超える場合は、新しい keep 件を優先する配分を keep ごとに作り、新しい順の完全さ
 * （全文、または BANT 関連段落をすべて含む抜粋）を辞書順で比べて選ぶ。同じなら keep が大きいほうを残す。
 * - 新しい keep 件は、完全になる最小の量の小さい会議から、均等な取り分に収まる限りその量を確保する。
 * - 新しい keep 件がすべて完全なら、古い会議は新しい順に、残りのバイトに全文が入るものを完全にする
 *   （ほかの会議の最小の抜粋を確保したあとも入るなら全文にする）。
 * - ほかの会議には新しい順に最小の抜粋（BANT 関連段落1つ）を確保し、入らないときだけ BANT 項目のみにする。
 * - 残りは water-filling で配る。全文までの不足が小さい会議から、均等な取り分に収まる限り全文にし、
 *   未完了の会議は新しい順に等分して抜粋を広げる。使わなかったバイトは次の会議へ回す。
 * 原文の段落と引用 ID は書き換えないので、引用の照合は全文で行える。
 */
function budgetMeetingSections(
  meetings: MeetingForBant[],
  fits: (sections: string[]) => boolean,
  available: (sections: string[]) => number,
): { sections: string[]; reduction: BantInputReduction } {
  const inputs = meetings.map(meetingPromptInput);
  const referenced = inputs.map((input) => input.full);
  if (fits(referenced)) return { sections: referenced, reduction: "quote_references" };
  const minimal = inputs.map((input) => input.bantOnly);
  // section の差し替えは他の部分に影響しないので、入力の大きさは minimal + 各会議の used の和になる。
  const room = available(minimal);
  if (room < 0) return { sections: minimal, reduction: "over_limit" };
  const base = inputs.map((input) => byteLength(input.bantOnly));
  const fullCost = inputs.map((input, index) => byteLength(input.full) - base[index]);
  const newestFirst = meetings
    .map((meeting, index) => ({ index, time: meeting.meetingDate.getTime() }))
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .map(({ index }) => index);
  // extra バイトまでで入る最良の形: 全文（または引用候補のみ）→ 原文の抜粋 → BANT 項目のみ。
  const fitInto = (index: number, extra: number): MeetingAllocation => {
    const input = inputs[index];
    if (fullCost[index] <= extra) return { section: input.full, used: fullCost[index], kind: "full", complete: true };
    const excerpt = input.excerpt?.(base[index] + extra);
    if (excerpt) {
      return { section: excerpt.section, used: byteLength(excerpt.section) - base[index], kind: "excerpt", complete: excerpt.complete };
    }
    return { section: input.bantOnly, used: 0, kind: "bant", complete: false };
  };
  // 完全になる最小の量: 全文と、BANT 関連段落をすべて含む抜粋の小さいほう。
  const completeCost = inputs.map((input, index) => {
    const excerpt = input.excerpt?.(Infinity);
    return Math.min(fullCost[index], excerpt ? byteLength(excerpt.section) - base[index] : Infinity);
  });
  // 抜粋にできる最小の量。一次テキストのない会議には抜粋がない（全文か BANT 項目のみ）。
  const leastCost = inputs.map((input, index) => input.leastExcerptBytes === undefined
    ? Infinity : Math.min(fullCost[index], input.leastExcerptBytes - base[index]));
  const allocate = (keep: number): MeetingAllocation[] => {
    const allocations: MeetingAllocation[] = [];
    let remaining = room;
    const assign = (index: number, extra: number) => {
      allocations[index] = fitInto(index, extra);
      remaining -= allocations[index].used;
    };
    // extra バイトまで広げる。全文になるか、より多くの段落が入るときだけ差し替える。
    const grow = (index: number, extra: number): boolean => {
      const current = allocations[index];
      if (current.kind === "full") return false;
      const next = fitInto(index, extra);
      if (next.kind !== "full" && next.used <= current.used) return false;
      remaining -= next.used - current.used;
      allocations[index] = next;
      return true;
    };
    const kept = newestFirst.slice(0, keep);
    const older = newestFirst.slice(keep);
    const fullFits: number[] = [];
    if (older.length > 0) {
      // 新しい keep 件は、完全になる最小の量の小さい会議から、均等な取り分に収まる限りその量を確保する。
      const bySize = [...kept].sort((a, b) => completeCost[a] - completeCost[b]);
      for (let filled = 0; filled < bySize.length; filled++) {
        const index = bySize[filled];
        if (completeCost[index] > Math.floor(remaining / (bySize.length - filled))) break;
        assign(index, completeCost[index]);
      }
      // 新しい keep 件がすべて完全なら、古い会議は新しい順に、残りのバイトに全文が入るものを完全にする。
      if (kept.every((index) => allocations[index])) {
        for (const index of older) {
          if (fullCost[index] > remaining) continue;
          assign(index, completeCost[index]);
          fullFits.push(index);
        }
      }
    }
    // ほかの会議には、新しい順に最小の抜粋を確保する（入らないときだけ BANT 項目のみ）。
    for (const index of newestFirst) {
      if (!allocations[index]) assign(index, leastCost[index] <= remaining ? leastCost[index] : 0);
    }
    // 全文が入るので完全にした古い会議は、最小の抜粋を確保したあとも入るなら全文にする。
    for (const index of fullFits) {
      if (fullCost[index] - allocations[index].used <= remaining) grow(index, fullCost[index]);
    }
    // 全文までの不足が小さい会議から、均等な取り分に収まる限り全文にする。
    const lack = (index: number) => fullCost[index] - allocations[index].used;
    const pending = newestFirst.filter((index) => allocations[index].kind !== "full");
    const bySize = [...pending].sort((a, b) => lack(a) - lack(b));
    for (let filled = 0; filled < bySize.length; filled++) {
      const index = bySize[filled];
      if (lack(index) > Math.floor(remaining / (bySize.length - filled))) break;
      grow(index, fullCost[index]);
    }
    // 未完了の会議は新しい順に等分して抜粋を広げる（完全な抜粋は全文にしか広げられないので分けない）。
    // 使わなかった取り分は次の会議へ回る。
    const rest = pending.filter((index) => !allocations[index].complete);
    rest.forEach((index, position) => grow(index, allocations[index].used + Math.floor(remaining / (rest.length - position))));
    // 余ったバイトは、新しい順に全文でない会議へ足す。
    for (let changed = true; changed;) {
      changed = false;
      for (const index of newestFirst) if (grow(index, allocations[index].used + remaining)) changed = true;
    }
    return allocations;
  };
  // 新しい順の完全さを辞書順で比べ、同じなら古い会議を縮めない配分（keep が大きいほう）を残す。
  const completeness = (allocations: MeetingAllocation[]) =>
    newestFirst.map((index) => (allocations[index].complete ? "1" : "0")).join("");
  let chosen = allocate(newestFirst.length);
  for (let keep = newestFirst.length - 1; keep >= 1; keep--) {
    const candidate = allocate(keep);
    if (completeness(candidate) > completeness(chosen)) chosen = candidate;
  }
  // 記録する縮め方は、最終的な section から決める。
  const reduction: BantInputReduction = chosen.some((allocation, index) => allocation.kind === "bant" && inputs[index].excerpt)
    ? "older_meetings_bant_only"
    : chosen.some((allocation) => allocation.kind === "excerpt") ? "transcript_excerpts" : "quote_references";
  return { sections: chosen.map((allocation) => allocation.section), reduction };
}

export function getProductContextInsert(): string {
  return getCachedLumaContextText() || "Luma商材コンテキスト未取得";
}

/** 自動集約の失敗の印（lastError）だけを持つ bant は、AI への入力では未集約（null）と同じに扱う。 */
function previousBantInput(bant: unknown): unknown {
  return isRecord(bant) && Object.keys(bant).length === 1 && "lastError" in bant ? null : bant;
}

function serializePreviousBantForPrompt(bant: unknown): string {
  if (!isRecord(bant)) return "null";
  const previous: Record<string, unknown> = {};
  for (const key of BANT_PROMPT_KEYS) {
    if (key === "items" && isRecord(bant.items)) {
      // Manual edit markers are not meeting quotations. Keep their text above
      // as context, but never offer these markers or old suggestions as evidence.
      const manual = normalizeManualFields(bant.manualFields);
      previous.items = Object.fromEntries(BANT_KEYS
        .filter(field => !manual[field] && field in (bant.items as Record<string, unknown>))
        .map(field => [field, (bant.items as Record<string, unknown>)[field]]));
    } else if (key in bant) previous[key] = bant[key];
  }
  return JSON.stringify(previous, null, 2).slice(0, 5000);
}

export function buildBantAggregationPrompt(
  deal: DealForBant,
  lumaContextText = getProductContextInsert(),
): { system: string; user: string; cacheableSystem?: string; inputReduction?: BantInputReduction } {
  const recentMeetings = deal.meetings.slice(0, BANT_RECENT_MEETINGS_LIMIT);
  const previous = serializePreviousBantForPrompt(previousBantInput(deal.bant));
  const cacheableSystem = formatLumaContextForPrompt(lumaContextText);
  const totalAmount = deal.products.reduce((sum, product) => sum + (product.amount ?? 0), 0);
  const productSummary = deal.products
    .map((product) =>
      [
        product.productName,
        product.planName ? `plan=${product.planName}` : "",
        product.yomiStatus ? `yomi=${product.yomiStatus}` : "",
        product.amount != null ? `amount=${product.amount}` : "",
      ]
        .filter(Boolean)
        .join(" / "),
    )
    .join("\n");

  const system = `
You aggregate BANT for a sales deal in Japanese.
Return JSON only. Preserve factual uncertainty.

# BANT definitions
${formatBantDefinitions()}

# Status rules
- confirmed: the actual BANT information is explicitly established by the customer or reliable meeting note. The fact that the customer explicitly says something is unknown does not confirm that BANT item.
- estimated: a concrete but provisional value supported by the input. For example, an 80万円 target/目安 with formal internal approval still pending is estimated, not confirmed; retain both the amount and the approval condition. Do not erase a provisional amount by replacing it with a generic unknown placeholder.
- A conditional introduction date such as "導入するなら2027年6月を希望。正式な時期は未確定" is also estimated, not confirmed. Preserve the stated date, conditional adoption, and lack of a finalized schedule in the value and literal quote. A later replacement after withdrawal must retain these qualifications; it is neither the former date nor a generic unknown date.
- The summary must retain the same conditional adoption and approval qualifications. A conditional date is not evidence that adoption is already decided or actively being considered. Do not introduce those states in the summary.
- unknown: no established BANT information. If the customer has not counted applications and does not know whether they are insufficient, need is unknown, even when that uncertainty has a literal quotation. Do not classify the hypothetical shortage or the customer's lack of knowledge as a confirmed need. Use the "未確定: ..." style value for the item and preserve the stated reason in the quote.
- A money amount, person, role, date, or deadline may appear only when the exact value exists in the cited meeting input or registered deal data.
- quote must be a short literal excerpt from the cited meeting's primary transcript or explicitly labeled manual minutes. Generated/derived minutesJson, minutes of unverified origin, meeting BANT, and previous aggregates are secondary context, never original quotations.
- For every item choose quote_ref from that meeting's primary quote references (q1, q2, ...). The application retrieves the original passage by ID. Do not rewrite, summarize or manually retype a quotation; set quote to an empty string. Select a customer passage that actually supports this item's value, including latest corrections, pending approval and conditional dates. If no passage supports the item, use an empty quote_ref. Reference IDs are scoped to source_meeting_id and cannot be taken from another meeting.
- A hypothetical need generated in meeting BANT (for example, "現状把握が必要な可能性あり" when the customer only said the applicant count was not measured) is not customer evidence and must not replace an unknown Need. A quote that only says the facts are unknown does not support an additional hypothetical need. Preserve an explicitly stated customer need or an actual provisional amount; otherwise keep the item unknown.
- Generic conversation stages such as "情報収集", "情報交換", "情報収集段階", or "情報交換段階" alone are not a concrete customer need; use the unknown Need value and status. Preserve an actual stated issue such as "情報収集ツールを統一したい" rather than removing it because it contains the same words.
- If no primary quotation supports the item, set quote to an empty string; never copy a derived BANT sentence into quote. Do not assert confirmed status without a primary quotation. A concrete value present only in a saved meeting BANT may remain estimated with no quote; missing information stays unknown. Do not fill missing BANT values from typical sales assumptions.
- Manual fields in the previous aggregate are protected by the application, not by this generation. For those fields, propose the newest meeting evidence independently; do not repeat the protected manual text as the proposal.
- Previous manual BANT edits and previous suggestions are not source quotations. Cite only an actual recent meeting and a literal passage from its primary transcript or explicitly labeled manual minutes.
- Registered products (# Products and the product catalog) are our offerings, not customer statements. Never attach a registered product or plan name to a budget, need, timeline, authority value or the summary unless the customer actually said that name in a recent meeting's primary transcript. Keep the customer's own words: "制作費は80万円を目安に検討しています" stays "制作費は80万円を目安に検討" and must not become "採用動画の制作費として80万円". The application removes product names that do not appear in the transcripts.
- An explicit customer withdrawal of an earlier budget or introduction date followed by current uncertainty supersedes the old value. Keep that item unknown and cite the withdrawal in the newest applicable meeting. Do not revive withdrawn conditions from prior aggregates or older meetings; distinguish this from a meeting that simply does not mention the field. A later stated replacement can become current. Apply the same distinction to the summary and retain other established facts.

# Output schema
{
  "budget": "string",
  "authority": "string",
  "need": "string",
  "timeline": "string",
  "summary": "string",
  "confidence": "integer 0-100",
  "items": {
    "budget": { "value": "string", "status": "confirmed|estimated|unknown", "source_meeting_id": "string", "quote_ref": "q1", "quote": "" },
    "authority": { "value": "string", "status": "confirmed|estimated|unknown", "source_meeting_id": "string", "quote_ref": "q1", "quote": "" },
    "need": { "value": "string", "status": "confirmed|estimated|unknown", "source_meeting_id": "string", "quote_ref": "q1", "quote": "" },
    "timeline": { "value": "string", "status": "confirmed|estimated|unknown", "source_meeting_id": "string", "quote_ref": "q1", "quote": "" }
  }
}

For each item, top-level string must equal items[key].value.
confidence is one integer percentage from 0 to 100 (not 0-1, 1-5 or 1-10) for how well the four items are established by primary quotations: 0 when all four are unknown, higher as more items are confirmed rather than estimated, up to about 90-100 only when all four are confirmed. Output a JSON number, not a string.
Use the newest reliable information first. Older meetings are already represented by the previous aggregate.
`.trim();

  const renderUser = (meetingSections: string[]) => `
# Deal
- id: ${deal.id}
- company: ${deal.company.name}
- title: ${deal.title}
- status: ${deal.status}
- totalAmount: ${totalAmount}

# Products
${productSummary || "未設定"}

# Previous Deal.bant aggregate
${previous}

# Recent meetings only (${recentMeetings.length}/${BANT_RECENT_MEETINGS_LIMIT})
${meetingSections.join("\n\n---\n\n") || "商談記録なし"}

# Unknown value requirements
${BANT_KEYS.map((key) => `- ${key}: ${BANT_UNKNOWN_VALUES[key]}`).join("\n")}
`.trim();

  // Measure exactly what the provider checks: the cacheable context is sent as system text.
  const systemText = buildSystemText({ system, cacheableSystem });
  const inputBytes = (meetingSections: string[]) => byteLength(systemText + renderUser(meetingSections));
  const user = renderUser(recentMeetings.map(summarizeMeetingInput));
  // 入力の上限は Vertex だけにある。ほかの provider には従来どおり全文を送る（T18 の受け入れ済みの挙動）。
  if (byteLength(systemText + user) <= BANT_INPUT_BYTE_LIMIT || getHeavyTextProvider() !== "vertex") {
    return { system, user, cacheableSystem };
  }
  const budgeted = budgetMeetingSections(
    recentMeetings,
    (meetingSections) => inputBytes(meetingSections) <= BANT_INPUT_BYTE_LIMIT,
    (meetingSections) => BANT_INPUT_BYTE_LIMIT - inputBytes(meetingSections),
  );
  return { system, user: renderUser(budgeted.sections), cacheableSystem, inputReduction: budgeted.reduction };
}

export function fallbackBantFromMeetings(deal: DealForBant): DealBantSummary {
  const previous = normalizeDealBant(reconcileBantFromMeetings(deal.bant, deal.meetings));
  const recentMeetings = deal.meetings.slice(0, BANT_RECENT_MEETINGS_LIMIT);
  const items: Record<BantKey, BantItem> = { ...previous.items };

  for (const key of BANT_KEYS) {
    const evidence = findMeetingBantEvidence(recentMeetings, key);
    if (evidence) {
      items[key] = evidence;
    } else if (!items[key]?.value) {
      items[key] = {
        value: BANT_UNKNOWN_VALUES[key],
        status: "unknown",
        source_meeting_id: "",
        quote: "該当する発言なし",
      };
    }
  }

  return {
    ...previous,
    budget: items.budget.value,
    authority: items.authority.value,
    need: items.need.value,
    timeline: items.timeline.value,
    summary:
      previous.summary ||
      (recentMeetings.length
        ? `直近${recentMeetings.length}件の商談BANTメモを連結したフォールバック集約です。`
        : "商談記録がまだないため、BANTは未確定です。"),
    confidence: previous.confidence || (recentMeetings.length ? 30 : 0),
    items,
    updatedBy: "auto",
    manualFields: previous.manualFields,
  };
}

async function loadDealForBant(dealId: string): Promise<DealForBant | null> {
  return prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      title: true,
      status: true,
      bant: true,
      bantUpdatedAt: true,
      company: { select: { name: true, industry: true } },
      products: {
        select: {
          productName: true,
          planName: true,
          yomiStatus: true,
          amount: true,
        },
      },
      meetings: {
        orderBy: { meetingDate: "desc" },
        take: BANT_RECENT_MEETINGS_LIMIT,
        select: {
          id: true,
          title: true,
          meetingDate: true,
          minutes: true,
          minutesJson: true,
          transcript: true,
          sourceType: true,
          bantBudget: true,
          bantAuthority: true,
          bantNeed: true,
          bantTimeline: true,
        },
      },
    },
  });
}

// Suppress duplicate notifications, not edits made within five minutes.
// Auto-generated aggregate fields are excluded because they are this operation's output.
export function bantInputFingerprint(deal: DealForBant): string {
  const previous = normalizeDealBant(deal.bant);
  return createHash("sha256").update(JSON.stringify({
    id: deal.id,
    title: deal.title,
    status: deal.status,
    company: deal.company,
    products: deal.products,
    meetings: deal.meetings.slice(0, BANT_RECENT_MEETINGS_LIMIT),
    manual: BANT_KEYS.map((key) => [key, previous.manualFields[key],
      previous.manualFields[key] ? previous[key] : null]),
  })).digest("hex");
}

async function shouldSkipDebounced(dealId: string, fingerprint: string): Promise<boolean> {
  const since = new Date(Date.now() - DEBOUNCE_MS);
  const latest = await prisma.aiLog.findFirst({
    where: {
      dealId,
      step: "bant_summary",
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { input: true },
  });
  return isRecord(latest?.input) && latest.input.inputFingerprint === fingerprint;
}

export async function summarizeDealBant(
  dealId: string,
  options: { debounce?: boolean; trigger?: string } = {},
): Promise<BantAggregationResult> {
  const deal = await loadDealForBant(dealId);
  if (!deal) throw new Error(`Deal not found: ${dealId}`);
  const inputFingerprint = bantInputFingerprint(deal);

  if (options.debounce && (await shouldSkipDebounced(dealId, inputFingerprint))) {
    await prisma.aiLog.create({
      data: {
        dealId,
        step: "bant_summary_skipped",
        input: { trigger: options.trigger ?? "auto", reason: "duplicate_input_5m" } as object,
        output: { skipped: true } as object,
      },
    });
    return {
      bant: normalizeDealBant(reconcileBantFromMeetings(deal.bant, deal.meetings)),
      fallback: true,
      skipped: true,
    };
  }

  const lumaContextText = await getLumaContextText({
    dealProducts: deal.products as LumaContextDealProduct[],
  });
  const prompt = buildBantAggregationPrompt(deal, lumaContextText);
  const result = await callClaudeHeavyJSON<DealBantSummary>({
    feature: "bant",
    system: prompt.system,
    cacheableSystem: prompt.cacheableSystem,
    user: prompt.user,
    maxTokens: 1800,
    temperature: 0.2,
  });

  const productGuard = result?.parsed
    ? guardUnspokenProductNames(
      normalizeBantAiOutput(resolveBantQuoteReferences(result.parsed, deal.meetings)), deal,
      deal.products.length ? await loadAllMeetingSources(dealId) : [],
    )
    : null;
  const generated = productGuard ? productGuard.bant : fallbackBantFromMeetings(deal);
  const fallback = !result?.parsed || result.usedFallback;
  // AI may take seconds. Preserve edits made while it was running and reject a
  // conflicting write instead of replacing a newer manual edit with stale data.
  const latest = await prisma.deal.findUnique({
    where: { id: dealId }, select: { bant: true, bantUpdatedAt: true },
  });
  if (!latest) throw new Error(`Deal not found: ${dealId}`);
  const merged = normalizeDealBant(reconcileBantFromMeetings(
    mergeDealBant(latest.bant, generated, "auto"), deal.meetings,
  ));
  // Only the verified current Timeline quote may qualify the automatic summary.
  // A former meeting's conditional date or unverified model quotation is not a source.
  if (merged.updatedBy === "auto" && !merged.manualFields.timeline) {
    const source = deal.meetings.find((meeting) => meeting.id === merged.items.timeline.source_meeting_id);
    merged.summary = retainAdoptionConditions(merged.summary, source?.transcript ?? "", merged.items.timeline.quote);
  }
  // A successful aggregation supersedes the previous automatic failure marker.
  delete merged.lastError;

  await prisma.deal.update({
    where: { id: dealId, bantUpdatedAt: latest.bantUpdatedAt },
    data: {
      bant: merged as unknown as object,
      bantUpdatedAt: new Date(),
    },
  });
  await prisma.aiLog.create({
    data: {
      dealId,
      step: "bant_summary",
      input: {
        trigger: options.trigger ?? "manual",
        promptVersion: BANT_AGGREGATION_PROMPT_VERSION,
        meetingsCount: deal.meetings.length,
        meetingsLimit: BANT_RECENT_MEETINGS_LIMIT,
        previousBantIncluded: !!previousBantInput(deal.bant),
        inputFingerprint,
        ...(prompt.inputReduction ? { inputReduction: prompt.inputReduction } : {}),
      } as object,
      output: {
        bant: merged, fallback, usage: result?.usage,
        ...(productGuard?.names.length ? { productNameGuard: { names: productGuard.names } } : {}),
      } as unknown as object,
    },
  });

  return { bant: merged, fallback, prompt: prompt.user };
}

function runInlineForAutoBant(): boolean {
  return process.env.NODE_ENV !== "production" || !process.env.VERCEL;
}

/**
 * Persist a short marker for the BANT card. It is not a BANT edit: keep
 * bantUpdatedAt, and never overwrite a concurrent edit (the conditional write fails).
 * 実行前の bantUpdatedAt から変わっていれば（この実行の保存が済んだ後の失敗、または別の編集）、印は付けない。
 */
async function recordAutoBantFailure(dealId: string, error: unknown, startedBantUpdatedAt: Date | null): Promise<void> {
  // A concurrent edit superseded this run; that is not an aggregation failure.
  if (isRecord(error) && error.code === "P2025") return;
  const latest = await prisma.deal.findUnique({
    where: { id: dealId }, select: { bant: true, bantUpdatedAt: true },
  });
  if (!latest || latest.bantUpdatedAt?.getTime() !== startedBantUpdatedAt?.getTime()) return;
  const lastError = {
    // Provider errors carry user-facing Japanese text; other internals are not shown.
    message: error instanceof VertexError ? error.message : "AIの呼び出しまたは結果の保存に失敗しました。",
    at: new Date().toISOString(),
  };
  await prisma.deal.update({
    where: { id: dealId, bantUpdatedAt: startedBantUpdatedAt },
    data: { bant: { ...(isRecord(latest.bant) ? latest.bant : {}), lastError } as object },
  });
}

export async function scheduleDealBantSummary(dealId: string, trigger: string): Promise<void> {
  const task = async () => {
    // 失敗の印は、実行前の bantUpdatedAt のままのときだけ書く（BANT の保存後に失敗しても印は付けない）。
    let started: { bantUpdatedAt: Date | null } | null = null;
    let lease: BantSummaryLease | null = null;
    try {
      // QG26 S-4: 手動の AI再集約・ほかの自動集約と同じ「集約中」の印を使う。実行中の集約があれば
      // 終わるまで待ってから、入力の指紋（debounce）で判断する。実行中の集約が同じ入力を集約済みなら
      // AI を呼ばず、その後に会議が増えていれば集約し直す（新しい会議の内容を取りこぼさない）。
      lease = await waitForBantSummaryLock(dealId, trigger);
      started = await prisma.deal.findUnique({ where: { id: dealId }, select: { bantUpdatedAt: true } });
      if (!lease) throw new Error("実行中のBANT集約が終わらないため、自動集約を実行できませんでした。");
      await summarizeDealBant(dealId, { debounce: true, trigger });
    } catch (e) {
      console.error("[auto-bant] summarize failed", {
        dealId,
        trigger,
        message: e instanceof Error ? e.message : String(e),
      });
      if (!started) return;
      await recordAutoBantFailure(dealId, e, started.bantUpdatedAt).catch((markerError) => {
        console.error("[auto-bant] failure marker not saved", {
          dealId,
          message: markerError instanceof Error ? markerError.message : String(markerError),
        });
      });
    } finally {
      if (lease) {
        await releaseBantSummaryLock(lease).catch((releaseError) => {
          // 消せなくても印は期限（BANT_SUMMARY_LOCK_TTL_MS）で無効になる。
          console.error("[auto-bant] in-flight marker not released", {
            dealId,
            message: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
      }
    }
  };

  if (runInlineForAutoBant()) {
    await task();
    return;
  }

  try {
    after(() => {
      void task();
    });
  } catch (e) {
    console.warn("[auto-bant] after() unavailable; running inline", e);
    await task();
  }
}

async function loadMeetingForBantRefresh(meetingId: string): Promise<{
  meeting: { id: string; dealId: string; minutes: string | null; transcript: string | null };
} | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      dealId: true,
      minutes: true,
      transcript: true,
    },
  });
  if (!meeting) return null;

  return { meeting };
}

export async function refreshMeetingBantAndDealSummary(
  meetingId: string,
  trigger: string,
): Promise<void> {
  const loaded = await loadMeetingForBantRefresh(meetingId);
  if (!loaded) return;
  const sourceText = loaded.meeting.minutes || loaded.meeting.transcript;
  if (!sourceText?.trim()) return;

  await scheduleDealBantSummary(loaded.meeting.dealId, trigger);
}

export async function scheduleMeetingBantRefresh(meetingId: string, trigger: string): Promise<void> {
  const task = async () => {
    await refreshMeetingBantAndDealSummary(meetingId, trigger);
  };

  if (runInlineForAutoBant()) {
    await task();
    return;
  }

  try {
    after(() => {
      void task().catch((e) => {
        console.error("[auto-bant] meeting refresh failed", {
          meetingId,
          trigger,
          message: e instanceof Error ? e.message : String(e),
        });
      });
    });
  } catch (e) {
    console.warn("[auto-bant] after() unavailable; running inline", e);
    await task();
  }
}
