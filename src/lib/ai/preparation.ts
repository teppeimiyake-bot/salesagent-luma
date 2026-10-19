import { preparationFormattingWorstCaseBytes, vertexPreparation } from "./vertex-grounding";
import { VERTEX_MAX_INPUT_BYTES, VertexError } from "./vertex-policy";
import {
  callClaudeHeavyJSONWithTools,
  formatAnthropicDebug,
  getAnthropicModelName,
  type CallOptions,
} from "@/lib/ai/anthropic";
import { getHeavyTextProvider, hasAnthropicKey } from "@/lib/ai/provider";
import { BANT_KEYS, type BantKey } from "./bant-definitions";
import { isUnknownBantValue } from "./bant-reconciliation";
import {
  formatLumaContextForPrompt,
  getLumaContextText,
  type LumaContextDealProduct,
} from "@/lib/ai/luma-context";

export const PREPARATION_WEB_SEARCH_MAX_USES = 10;
export const PREPARATION_DISCLAIMER =
  "AIによる仮説です。断定せず商談の土台として使ってください。";
export const UNCONFIRMED = "確認できず";
export const PROPOSAL_STORY_HEADINGS = [
  "つかみ",
  "課題共感",
  "商材提案",
  "効果イメージ",
  "確認論点",
] as const;

const UNREGISTERED_PRODUCT_PROPOSAL = "提案できる商材・プランが未登録のため、具体的な商材提案は保留します。提供可能な商材と正式名称を確認してください。";
const UNREGISTERED_OFFER_RULE = "- 商材が未登録のため、# つかみ と # 課題共感 では Luma（弊社）による提案・提供・支援を表明・約束しないでください（例:「ご提案します」「支援いたします」）。提案・提供に関わる内容は # 確認論点 に回してください。";
export const PREPARATION_INPUT_LIMIT_MESSAGE = "事前準備の入力がAIの上限を超えるため、公開情報の検索を行わずに停止しました（検索の費用は発生していません）。会社概要・商談ごとのBANT・商材カタログなどの文章を短くして再実行してください。";

export type PreparationSource = {
  title: string;
  url: string;
};

export type PreparationHiringInsights = {
  media: string;
  roles: string;
  scale: string;
  sources: PreparationSource[];
};

export type PreparationPainHypothesis = {
  hypothesis: string;
  confidence: "high" | "medium" | "low";
  evidence: string;
  source_url: string;
};

export type PreparationResearchOutput = {
  industry_summary: string;
  hiring_insights: PreparationHiringInsights;
  pain_hypotheses: PreparationPainHypothesis[];
  sources: PreparationSource[];
  disclaimer: string;
  proposal_story?: string | null;
  talking_points?: unknown;
};

export type CanCreatePreparationBriefInput = {
  createdToday: number;
  isAdmin: boolean;
  limit?: number;
};

export function canCreatePreparationBrief({
  createdToday,
  isAdmin,
  limit = 3,
}: CanCreatePreparationBriefInput): boolean {
  if (isAdmin) return true;
  return createdToday < limit;
}

/**
 * Cloud Run ends a request after 300 seconds and throttles CPU after the
 * response, so a brief still unfinished long after that was interrupted.
 * The preparation route keeps the same threshold and message locally; the
 * panel keeps only the message and relies on the route's `interrupted` flag.
 */
export const PREPARATION_STALE_AFTER_MS = 10 * 60 * 1000;
export const PREPARATION_INTERRUPTED_MESSAGE = "AI処理が中断されました（開始から10分以上完了していません）。再実行してください。";
const PREPARATION_IN_PROGRESS_STATUSES = new Set(["pending", "researching", "generating"]);

export function isInterruptedPreparationBrief(
  brief: { status: string; createdAt: Date | string },
  now: Date = new Date(),
): boolean {
  if (!PREPARATION_IN_PROGRESS_STATUSES.has(brief.status)) return false;
  const createdAt = new Date(brief.createdAt).getTime();
  return Number.isFinite(createdAt) && now.getTime() - createdAt > PREPARATION_STALE_AFTER_MS;
}

type DealForPreparation = {
  id: string;
  title: string;
  status: string;
  bant: unknown;
  company: {
    name: string;
    industry: string | null;
    employeeCount: number | null;
    websiteSummary: string | null;
  };
  products: Array<{
    productName: string;
    planName: string | null;
    planProposals: string[];
    yomiStatus: string | null;
    amount: number | null;
  }>;
  meetings: Array<{
    title: string | null;
    meetingDate: Date;
    transcript?: string | null;
    minutes: string | null;
    bantBudget: string | null;
    bantAuthority: string | null;
    bantNeed: string | null;
    bantTimeline: string | null;
  }>;
};

export type PreparationInternalReview = {
  key: BantKey;
  label: string;
  manualValue: string;
  meetingValue: string;
  sourceLabel: string;
  sourceType: "transcript" | "minutes";
  quote: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

const INTERNAL_REVIEW_FIELDS: Record<BantKey, {
  field: "bantBudget" | "bantAuthority" | "bantNeed" | "bantTimeline";
  label: string;
  topic: RegExp;
}> = {
  budget: { field: "bantBudget", label: "予算", topic: /予算|万円|金額|費用|価格/u },
  authority: { field: "bantAuthority", label: "決裁者・承認経路", topic: /決裁|決済者|決定権|承認|稟議/u },
  need: { field: "bantNeed", label: "課題", topic: /課題|不足|悩|困|必要|改善|応募/u },
  timeline: { field: "bantTimeline", label: "時期", topic: /時期|期限|納期|公開|開始|導入|予定|希望|[0-9０-９]{4}年/u },
};

function bantReferenceValue(bant: Record<string, unknown>, key: BantKey): string {
  const direct = bant[key];
  if (typeof direct === "string") return direct.trim();
  if (isRecord(direct)) return text(direct.value);
  const items = isRecord(bant.items) ? bant.items : {};
  return isRecord(items[key]) ? text(items[key].value) : "";
}

/** Candidate comparisons are not semantic conflicts or changes to saved manual BANT. */
export function preparationInternalReviews(
  deal: Pick<DealForPreparation, "bant" | "meetings">,
): PreparationInternalReview[] {
  const bant = isRecord(deal.bant) ? deal.bant : {};
  const manual = isRecord(bant.manualFields) ? bant.manualFields : {};
  const latest = [...deal.meetings]
    .filter((meeting) => Number.isFinite(meeting.meetingDate.getTime()))
    .sort((a, b) => b.meetingDate.getTime() - a.meetingDate.getTime())[0];
  if (!latest) return [];
  const transcript = text(latest.transcript);
  const source = transcript || text(latest.minutes);
  if (!source) return [];
  const sourceType = transcript ? "transcript" : "minutes";
  const sourceLabel = `${latest.title || "最新商談"}（${latest.meetingDate.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })}）`;
  const compact = (value: string) => value.replace(/\s+/gu, "");

  return BANT_KEYS.flatMap((key) => {
    if (manual[key] !== true) return [];
    const definition = INTERNAL_REVIEW_FIELDS[key];
    const manualValue = bantReferenceValue(bant, key);
    const meetingValue = text(latest[definition.field]);
    // Missing information in the latest meeting does not contradict an older note.
    if (isUnknownBantValue(manualValue) || isUnknownBantValue(meetingValue)) return [];
    if (compact(manualValue).includes(compact(meetingValue))) return [];
    const quote = source.split(/[。！？\r\n]+/u)
      .map((sentence) => sentence.trim())
      .find((sentence) => definition.topic.test(compact(sentence)) && compact(sentence).includes(compact(meetingValue)));
    // A generated Meeting BANT value alone cannot establish what the customer said.
    // Paraphrases stay available to the prompt; a mechanical comparison requires
    // the proposed value to appear literally in the primary passage. A text
    // mismatch still does not establish that the records contradict each other.
    if (!quote) return [];
    if (compact(quote).includes(compact(manualValue))) return [];
    return [{ key, label: definition.label, manualValue, meetingValue, sourceLabel, sourceType, quote: quote.slice(0, 300) }];
  });
}

function internalReviewQuestion(review: PreparationInternalReview): string {
  const manual = review.manualValue.length > 400 ? `${review.manualValue.slice(0, 400)}…` : review.manualValue;
  const source = review.sourceType === "transcript" ? "文字起こし原文" : "議事録（文字起こしなし）";
  const question = review.key === "authority"
    ? "最終決裁者と窓口・承認者の役割分担を確認する。"
    : review.key === "need"
      ? "今回優先する課題と、過去メモにある補足情報の関係を確認する。"
      : "同じ対象・条件を指すか、現在の合意内容を確認する。";
  return `【社内記録の確認：${review.label}】手動BANT（入力時点不明）は「${manual}」。${review.sourceLabel}の${source}には「${review.quote}」と記載。記録の関係（要約・補足、対象や条件の違い、更新）は、この比較だけでは判断できません。${question}`;
}

function hasUrl(value: string): boolean {
  return /https?:\/\/[^\s)]+/i.test(value);
}

// URLs the model writes into a hypothesis's evidence text. They are not verified sources on their own:
// one that exactly matches a listed source becomes the hypothesis's source_url, and every URL (with a
// wrapper such as 「（出典: …）」) is removed from the text, so the label and the source link agree.
const EVIDENCE_URL = String.raw`https?:\/\/[^\s、，,。（）()「」『』<>\[\]]+`;
const EVIDENCE_URL_LABEL = String.raw`(?:出典|参照|引用元|ソース|URL|source)\s*(?:URL)?\s*[:：]?\s*`;
const EVIDENCE_URL_LIST = String.raw`${EVIDENCE_URL}(?:\s*[、，,]\s*${EVIDENCE_URL})*`;
function evidenceWithoutUrls(evidence: string): { text: string; urls: string[] } {
  const urls = evidence.match(new RegExp(EVIDENCE_URL, "giu")) ?? [];
  if (!urls.length) return { text: evidence, urls };
  const stripped = evidence
    .replace(new RegExp(String.raw`\s*[（(]\s*(?:${EVIDENCE_URL_LABEL})?${EVIDENCE_URL_LIST}\s*[）)]`, "giu"), "")
    .replace(new RegExp(String.raw`\s*${EVIDENCE_URL_LABEL}${EVIDENCE_URL_LIST}`, "giu"), "")
    .replace(new RegExp(String.raw`\s*${EVIDENCE_URL}`, "giu"), "")
    .replace(/[\s、，,:：]+$/u, "")
    .trim();
  return { text: stripped, urls };
}

function isSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && ["http:", "https:"].includes(url.protocol)
      && Boolean(url.hostname) && !url.username && !url.password && !/\s/.test(value);
  } catch { return false; }
}

function normalizeSource(value: unknown): PreparationSource | null {
  if (!isRecord(value)) return null;
  const url = text(value.url);
  if (!isSourceUrl(url)) return null;
  return {
    title: text(value.title) || url,
    url,
  };
}

function normalizeSources(...values: unknown[]): PreparationSource[] {
  const out: PreparationSource[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const source = normalizeSource(item);
      if (!source || seen.has(source.url)) continue;
      seen.add(source.url);
      out.push(source);
    }
  }
  return out;
}

function factWithSource(value: unknown, sources: PreparationSource[]): string {
  const s = text(value);
  if (!s) return UNCONFIRMED;
  if (sources.length > 0 || hasUrl(s)) return s;
  return UNCONFIRMED;
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  const v = text(value).toLowerCase();
  if (["high", "高", "高い"].includes(v)) return "high";
  if (["medium", "mid", "middle", "中", "中程度"].includes(v)) return "medium";
  if (["low", "低", "低い"].includes(v)) return "low";
  return "low";
}

function cleanProductName(value: unknown): string {
  return text(value)
    .replace(/^[-・\s]+/u, "")
    .replace(/\s*\/.*$/u, "")
    .replace(/\s*\|.*$/u, "")
    .trim();
}

export function extractLumaProductNamesFromContext(contextText: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let inCatalogSection = false;
  for (const line of contextText.split(/\r?\n/u)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u);
    if (heading) {
      // The shared context also contains bulleted usage rules and examples.
      // Only actual catalog/plan-proposal rows are registration evidence.
      inCatalogSection = ["商材カタログ", "企画型一覧"].includes(heading[1]);
      continue;
    }
    if (!inCatalogSection) continue;
    const match = line.match(/^\s*-\s+(.+)$/u);
    if (!match) continue;
    const name = cleanProductName(match[1]);
    if (!name || name.includes("=") || /^(?:商材マスタ未登録|企画型マスタ未登録|プラン未登録|未設定)$/u.test(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function uniqueProductNames(...groups: Array<unknown[] | undefined>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const name = cleanProductName(item);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function preferredCatalogNames(catalogProductNames: string[]): string[] {
  const preferred = catalogProductNames.filter((name) => /採用|映像|SNS|企画|ドラマ/u.test(name));
  return preferred.length ? preferred : catalogProductNames;
}

function selectProposalProductNames({
  dealProductNames = [],
  catalogProductNames = [],
}: {
  dealProductNames?: string[];
  catalogProductNames?: string[];
}): string[] {
  const dealNames = uniqueProductNames(dealProductNames);
  if (dealNames.length > 0) return dealNames.slice(0, 2);
  const catalogNames = uniqueProductNames(preferredCatalogNames(catalogProductNames));
  return catalogNames.slice(0, 2);
}

function confidenceLabelForStory(confidence: PreparationPainHypothesis["confidence"]): string {
  if (confidence === "high") return "高";
  if (confidence === "medium") return "中";
  return "低";
}

// Precision first: drop a sentence only when it is clearly the seller's own
// offer. Deleting accepted customer evidence is worse than leaving one
// seller-offer sentence in the brief, so anything ambiguous is kept and left
// to the T18 prompt/model review.
//
// "Luma" as a word (not "LumaFlow"), optionally with a company suffix
// ("Luma社", "Luma株式会社"; "株式会社Luma" already ends in the word), or a
// first-person company reference, but not the customer's way of addressing
// the seller ("Lumaさん", "Luma社様").
const SELLER_NAME = String.raw`(?:(?<![a-z])Luma(?![a-z])(?:社|株式会社)?|弊社|当社|私ども|私共|私たち|我々)(?!さん|様)`;
// The seller counts as the subject only when a topic/subject particle follows
// directly. "Lumaの過去事例" or "Lumaのノウハウで…" does not.
const SELLER_SUBJECT = String.raw`${SELLER_NAME}(?:では|としては|として|は|が|も)`;
const OFFER_STEM = String.raw`(?:提案|提供|制作|支援|サポート|お?手伝い|貢献|実現|お届け|伴走)`;
// The seller's own non-past offer, including soft and desiderative forms
// ("ご提案します", "支援いたします", "ご提案させていただきたく存じます",
// "お手伝いできればと考えております", "一貫したご支援が可能です",
// "貢献できるものと確信しております"). Nouns, past and attributive forms
// ("動画制作", "制作した", "制作する動画") and questions ("制作できますか",
// "制作できますでしょうか") are not offers.
const OFFER_PREDICATE = [
  String.raw`${OFFER_STEM}を?(?:いたし|致し|し|させていただき|させて頂き|でき|出来|してまいり|して参り|していき|申し上げ|行い)ます(?!でしょう|[かと])`,
  String.raw`手伝います(?!でしょう|[かと])`,
  String.raw`${OFFER_STEM}を?(?:し|いたし|致し|させていただき|させて頂き|申し上げ|していき|してまいり|して参り)(?:たい(?!(?:です)?か|でしょう)|たく)`,
  String.raw`${OFFER_STEM}を?(?:でき|出来|させていただけ|させて頂け)れば`,
  String.raw`${OFFER_STEM}を?(?:でき|出来)る(?:もの)?と(?:考え|確信|存じ|思)`,
  String.raw`${OFFER_STEM}(?:を|が)?(?:する|いたす)?(?:こと)?が?(?:可能です|でき(?:ます|る))(?!でしょう|か)`,
  String.raw`${OFFER_STEM}を?(?:する|できる|いたす)(?=[。！？!?]*[」』〟）)]*[\s　]*$)`,
].join("|");
const SELLER_OFFER = new RegExp(String.raw`${SELLER_SUBJECT}[^。！？!?\n]*?(?:${OFFER_PREDICATE})`, "iu");
// Any sign that the sentence is about the customer or reports what someone
// said keeps it: a person with an honorific (not forms of address such as
// 皆様・貴社様・企業様), 先方 or a named role, reported speech, or the
// customer's wishes and questions. "弊社が伺ったところ、貴社では…制作します"
// and "当社は…制作したいそうです" stay.
const CUSTOMER_OR_REPORT = /(?<!皆|貴社|御社|お客|企業|他社|各社)(?:様|さん)|先方|部長|課長|社長|役員|担当者|ご担当|人事の方|人事部の方|伺|うかが|おっしゃ|仰|話され|話して|お話|お聞き|聞い|聞き|言われ|言って|との(?:こと|事|ご)|そうです|ようです|意向|要望|希望|お考え|検討され|関心|懸念|質問|相談|回答|説明され/u;
const OFFER_HOLD_OR_CONFIRMATION = /未登録|未確認|要確認|確認|保留/u;
// A quoted span stays inside its sentence even when it contains 。！？.
// Quotes do not span lines; an unclosed bracket or quotation mark is ordinary
// text. Symmetric quotes (" and ”) are never trailing closers, because they
// could be the opening quote of the next sentence.
const QUOTED_SPAN = /「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|”[^”\n]*”|〝[^〟\n]*〟|"[^"\n]*"/gu;
const SENTENCE_SEGMENT = /(?:「[^」\n]*」|『[^』\n]*』|“[^”\n]*”|”[^”\n]*”|〝[^〟\n]*〟|"[^"\n]*"|[^。！？!?\n])*(?:[。！？!?]+[」』〟）)]*|\n+|$)/gu;

function isUnregisteredSellerOffer(sentence: string): boolean {
  // Customers call their own company 弊社/当社 in quoted speech, so only the
  // brief's own wording outside the quotes is evaluated. An empty bracket pair
  // keeps the quote's position without its content.
  const own = sentence.replace(QUOTED_SPAN, (quote) => `${quote[0]}${quote[quote.length - 1]}`);
  if (OFFER_HOLD_OR_CONFIRMATION.test(own) || CUSTOMER_OR_REPORT.test(own)) return false;
  return SELLER_OFFER.test(own);
}

/**
 * Without a registered offering, the model still tends to promise one in the
 * greeting and empathy sections ("Lumaが…ご提案させていただきます").
 * Drop only seller-subject offer sentences; hold/confirmation wording and
 * quoted customer statements stay.
 */
function removeUnregisteredSellerOffers(body: string): string {
  const segments = body.match(SENTENCE_SEGMENT) ?? [];
  const kept = segments.filter((segment) => !isUnregisteredSellerOffer(segment));
  if (kept.length === segments.length) return body;
  const result = kept.join("").replace(/[ \t　]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  // A list marker or whitespace left from a removed sentence is not content.
  return /[^\s\-*・>#]/u.test(result) ? result : "";
}

function splitProposalStorySections(
  story: string,
): Partial<Record<(typeof PROPOSAL_STORY_HEADINGS)[number], string>> {
  const sections: Partial<Record<(typeof PROPOSAL_STORY_HEADINGS)[number], string>> = {};
  const pattern = /(?:^|\n)#\s*(つかみ|課題共感|商材提案|効果イメージ|確認論点)\s*\n?/gu;
  const matches = [...story.matchAll(pattern)];
  for (let i = 0; i < matches.length; i += 1) {
    const heading = matches[i][1] as (typeof PROPOSAL_STORY_HEADINGS)[number];
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? story.length : story.length;
    const body = story.slice(start, end).trim();
    if (body) sections[heading] = body;
  }
  return sections;
}

export function normalizeProposalStory(input: {
  story?: unknown;
  companyName?: string;
  industrySummary?: string;
  hiringInsights?: PreparationHiringInsights;
  painHypotheses?: PreparationPainHypothesis[];
  catalogProductNames?: string[];
  dealProductNames?: string[];
  internalReviews?: PreparationInternalReview[];
}): string {
  const selectedProducts = selectProposalProductNames({
    dealProductNames: input.dealProductNames,
    catalogProductNames: input.catalogProductNames,
  });
  const primaryProduct = selectedProducts[0];
  const requiredProductName =
    uniqueProductNames(input.dealProductNames)[0] ??
    uniqueProductNames(input.catalogProductNames)[0];
  const allowedProductNames = uniqueProductNames(
    input.dealProductNames,
    input.catalogProductNames,
  );
  const hasRegisteredProducts = allowedProductNames.length > 0;
  const rawStory = text(input.story);
  const sections = splitProposalStorySections(rawStory);
  if (rawStory && Object.keys(sections).length === 0) {
    sections["つかみ"] = rawStory;
  }

  const companyName = text(input.companyName) || "対象企業";
  const pain = (input.painHypotheses ?? []).slice(0, 3);
  const painText = pain.length
    ? pain.map((h) => `${h.hypothesis}（確度:${confidenceLabelForStory(h.confidence)}）`).join(" / ")
    : "公開情報だけでは個社固有の課題は確認できず。商談では仮説として確認します。";
  const hiringText = input.hiringInsights
    ? `媒体:${input.hiringInsights.media} / 職種:${input.hiringInsights.roles} / 規模:${input.hiringInsights.scale}`
    : UNCONFIRMED;

  const defaults: Record<(typeof PROPOSAL_STORY_HEADINGS)[number], string> = {
    つかみ:
      input.industrySummary && input.industrySummary !== UNCONFIRMED
        ? `${input.industrySummary}\n公開情報で確認できない点は、冒頭で「確認させてください」と置いて進めます。`
        : `${companyName}について公開情報だけでは業界・採用状況を確認できず。まず事実確認を前提に始めます。`,
    課題共感: `採用状況は ${hiringText}。そこから ${painText} という仮説を置きます。断定せず、現場感と優先度を確認します。`,
    商材提案: hasRegisteredProducts
      ? `${selectedProducts.join(" / ")}を候補にします。採用広報・認知形成・応募前理解のどこに効かせるべきかは要確認です。`
      : UNREGISTERED_PRODUCT_PROPOSAL,
    効果イメージ: hasRegisteredProducts
      ? `${primaryProduct}を使う場合、候補者が応募前に仕事や人の雰囲気を理解しやすくなる、という仮説で提案します。数値効果は断定せず、現状指標を確認してから置きます。`
      : "提供可能な商材が未確認のため、具体的な効果の説明は保留します。商材の内容と顧客の課題を確認したうえで、効果仮説を整理します。",
    確認論点:
      "採用人数、募集職種、応募単価、歩留まり、意思決定者、既存施策、制作後の運用体制を確認します。",
  };

  return PROPOSAL_STORY_HEADINGS.map((heading) => {
    let body = sections[heading]?.trim() ?? "";
    if (!hasRegisteredProducts && (heading === "つかみ" || heading === "課題共感")) {
      body = removeUnregisteredSellerOffers(body);
    }
    body ||= defaults[heading];
    // No registered offering means neither product names nor effects can be
    // inferred from instructional examples or model-generated placeholders.
    if (!hasRegisteredProducts && (heading === "商材提案" || heading === "効果イメージ")) {
      body = defaults[heading];
    } else if (heading === "商材提案" && !allowedProductNames.some((name) => body.includes(name))) {
      body = `${requiredProductName}を候補にします（要確認）。${body}`;
    }
    if (heading === "確認論点") {
      for (const review of input.internalReviews ?? []) {
        const question = internalReviewQuestion(review);
        if (!body.includes(question)) body += `\n\n${question}`;
      }
    }
    return `# ${heading}\n${body.trim()}`;
  }).join("\n\n");
}

// The model may write its own confidence into the hypothesis text (gemini-3.5-flash-lite on 2026-09-29:
// 「…可能性（信頼度: high, 社内商談記録: …）」), which contradicts the app's confidence badge. Only such an item at the
// start or end of the hypothesis's trailing bracket group is removed; the rest of the group stays in place, and any
// other shape (nested brackets, extra words after the value, other bracket types) is left unchanged.
const EMBEDDED_CONFIDENCE = String.raw`(?:信頼度|確信度|確度|confidence)\s*[:：]\s*(?:high|medium|middle|mid|low|高い?|中(?:程度)?|低い?)\s*`;
const CONFIDENCE_AT_START = new RegExp(String.raw`^\s*${EMBEDDED_CONFIDENCE}(?:[,，、;；]\s*|$)`, "iu");
const CONFIDENCE_AT_END = new RegExp(String.raw`[,，、;；]\s*${EMBEDDED_CONFIDENCE}$`, "iu");
export function withoutEmbeddedConfidence(hypothesis: string): string {
  const group = hypothesis.match(/^([\s\S]*?)(（([^（）()]*)）|\(([^（）()]*)\))([。．.]?)\s*$/u);
  if (!group) return hypothesis;
  const [, head, , fullWidth, halfWidth, end] = group;
  const inner = fullWidth ?? halfWidth ?? "";
  const rest = inner.replace(CONFIDENCE_AT_END, "").replace(CONFIDENCE_AT_START, "").trim();
  if (rest === inner.trim()) return hypothesis;
  if (rest) return fullWidth !== undefined ? `${head}（${rest}）${end}` : `${head}(${rest})${end}`;
  // The lookbehind anchors the trim at the start of the trailing run (linear time on long runs).
  const bare = head.replace(/(?<![\s\-–—/／|｜:：、,，])[\s\-–—/／|｜:：、,，]+$/u, "");
  if (!/[\p{L}\p{N}]/u.test(bare)) return hypothesis;
  return /[。．.！？!?]$/u.test(bare) ? bare : `${bare}${end}`;
}

export function normalizePreparationOutput(
  raw: unknown,
  options: {
    companyName?: string;
    catalogProductNames?: string[];
    dealProductNames?: string[];
    internalReviews?: PreparationInternalReview[];
  } = {},
): PreparationResearchOutput {
  const obj = isRecord(raw) ? raw : {};
  const hiringRaw = isRecord(obj.hiring_insights) ? obj.hiring_insights : {};
  const hiringSources = normalizeSources(hiringRaw.sources);
  const sources = normalizeSources(obj.sources, hiringSources);

  const painRaw = Array.isArray(obj.pain_hypotheses) ? obj.pain_hypotheses : [];
  const pain_hypotheses = painRaw.slice(0, 5).map((item): PreparationPainHypothesis => {
    const h = isRecord(item) ? item : {};
    const written = evidenceWithoutUrls(text(h.evidence));
    const givenUrl = text(h.source_url);
    const verifiedUrl = written.urls.find((url) => sources.some((source) => source.url === url));
    const sourceUrl = isSourceUrl(givenUrl) ? givenUrl : verifiedUrl ?? givenUrl;
    const hasSource = isSourceUrl(sourceUrl);
    const evidence = written.text || "根拠は公開情報では確認できず。";
    return {
      hypothesis: withoutEmbeddedConfidence(text(h.hypothesis)) || "課題仮説",
      confidence: normalizeConfidence(h.confidence),
      evidence: hasSource ? evidence : `出典なしの仮説: ${evidence}`,
      source_url: hasSource ? sourceUrl : "",
    };
  });

  return {
    industry_summary: factWithSource(obj.industry_summary, sources),
    hiring_insights: {
      media: factWithSource(hiringRaw.media, hiringSources),
      roles: factWithSource(hiringRaw.roles, hiringSources),
      scale: factWithSource(hiringRaw.scale, hiringSources),
      sources: hiringSources,
    },
    pain_hypotheses:
      pain_hypotheses.length > 0
        ? pain_hypotheses
        : [
            {
              hypothesis: "採用広報上の課題がある可能性",
              confidence: "low",
              evidence: "出典なしの仮説: 公開情報では根拠を確認できず。",
              source_url: "",
            },
          ],
    sources,
    disclaimer: text(obj.disclaimer) || PREPARATION_DISCLAIMER,
    proposal_story: normalizeProposalStory({
      story: obj.proposal_story,
      companyName: options.companyName,
      industrySummary: factWithSource(obj.industry_summary, sources),
      hiringInsights: {
        media: factWithSource(hiringRaw.media, hiringSources),
        roles: factWithSource(hiringRaw.roles, hiringSources),
        scale: factWithSource(hiringRaw.scale, hiringSources),
        sources: hiringSources,
      },
      painHypotheses:
        pain_hypotheses.length > 0
          ? pain_hypotheses
          : [
              {
                hypothesis: "採用広報上の課題がある可能性",
                confidence: "low",
                evidence: "出典なしの仮説: 公開情報では根拠を確認できず。",
                source_url: "",
              },
            ],
      catalogProductNames: options.catalogProductNames,
      dealProductNames: options.dealProductNames,
      internalReviews: options.internalReviews,
    }),
    talking_points: obj.talking_points,
  };
}

export function fallbackPreparationBrief(
  companyName = "対象企業",
  options: { catalogProductNames?: string[]; dealProductNames?: string[] } = {},
): PreparationResearchOutput {
  return {
    industry_summary: UNCONFIRMED,
    hiring_insights: {
      media: UNCONFIRMED,
      roles: UNCONFIRMED,
      scale: UNCONFIRMED,
      sources: [],
    },
    pain_hypotheses: [
      {
        hypothesis: `${companyName}の採用広報で応募前理解を補強できる可能性`,
        confidence: "low",
        evidence: "出典なしの仮説: Web検索またはAI生成を実行できないため、社内データのみからの仮説です。",
        source_url: "",
      },
    ],
    sources: [],
    disclaimer: PREPARATION_DISCLAIMER,
    proposal_story: normalizeProposalStory({
      companyName,
      industrySummary: UNCONFIRMED,
      hiringInsights: {
        media: UNCONFIRMED,
        roles: UNCONFIRMED,
        scale: UNCONFIRMED,
        sources: [],
      },
      painHypotheses: [
        {
          hypothesis: `${companyName}の採用広報で応募前理解を補強できる可能性`,
          confidence: "low",
          evidence: "出典なしの仮説: Web検索またはAI生成を実行できないため、社内データのみからの仮説です。",
          source_url: "",
        },
      ],
      catalogProductNames: options.catalogProductNames,
      dealProductNames: options.dealProductNames,
    }),
  };
}

export function buildPreparationWebSearchTools(): Array<Record<string, unknown>> {
  return [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: PREPARATION_WEB_SEARCH_MAX_USES,
    },
  ];
}

function serializeBantForPrompt(bant: unknown): string {
  // BANT 自動集約の失敗の印（lastError）だけを持つ bant は、未集約（null）と同じ入力にする。
  if (!isRecord(bant) || (Object.keys(bant).length === 1 && "lastError" in bant)) return "null";
  const manual = isRecord(bant.manualFields) ? bant.manualFields : {};
  const out: Record<string, unknown> = {};
  for (const key of BANT_KEYS) {
    const value = bantReferenceValue(bant, key);
    if (!value) continue;
    out[key] = {
      value: value.slice(0, 800),
      source_type: manual[key] === true ? "manual_bant_reference" : "previous_aggregate_reference",
      note: "社内の過去参照情報。入力時点と最新の合意状態は未確認。最新の一次発言と異なる場合は確認論点へ。",
    };
  }
  return JSON.stringify(out, null, 2);
}

function formatDealProducts(products: DealForPreparation["products"]): string {
  if (products.length === 0) return "未設定";
  return products
    .map((p) =>
      [
        p.productName,
        p.planName ? `plan=${p.planName}` : "",
        p.planProposals.length ? `proposal=${p.planProposals.join(", ")}` : "",
        p.yomiStatus ? `yomi=${p.yomiStatus}` : "",
        p.amount != null ? `amount=${p.amount}` : "",
      ]
        .filter(Boolean)
        .join(" / "),
    )
    .join("\n");
}

const MEETING_TRANSCRIPT_MAX_CHARS = 6000;
const MEETING_TRANSCRIPT_MIN_CHARS = 1500;
const TRANSCRIPT_OMISSION = "\n…（中略）…\n";

function recentMeetings(meetings: DealForPreparation["meetings"]): DealForPreparation["meetings"] {
  return [...meetings]
    .sort((a, b) => b.meetingDate.getTime() - a.meetingDate.getTime())
    .slice(0, 3);
}

const utf8Bytes = (value: string) => Buffer.byteLength(value, "utf8");

/**
 * Keeps the start and the end of a transcript within a byte and character
 * budget, half each, so that corrections late in a long meeting are not lost.
 */
function transcriptExcerpt(transcript: string, maxBytes: number, maxChars = MEETING_TRANSCRIPT_MAX_CHARS): string {
  const chars = Array.from(transcript);
  if (chars.length <= maxChars && utf8Bytes(transcript) <= maxBytes) return transcript;
  const room = Math.max(0, maxBytes - utf8Bytes(TRANSCRIPT_OMISSION));
  let head = 0;
  let headBytes = 0;
  while (head < chars.length && head < Math.ceil(maxChars / 2) && headBytes + utf8Bytes(chars[head]) <= Math.floor(room / 2)) {
    headBytes += utf8Bytes(chars[head]);
    head += 1;
  }
  let tail = chars.length;
  let tailBytes = 0;
  while (tail > head && chars.length - tail < Math.floor(maxChars / 2) && headBytes + tailBytes + utf8Bytes(chars[tail - 1]) <= room) {
    tailBytes += utf8Bytes(chars[tail - 1]);
    tail -= 1;
  }
  return `${chars.slice(0, head).join("")}${TRANSCRIPT_OMISSION}${chars.slice(tail).join("")}`;
}

/**
 * Splits the transcript byte budget across the recent meetings (newest
 * first). Each meeting keeps at least MEETING_TRANSCRIPT_MIN_CHARS; the rest is
 * shared in proportion to what each meeting still needs up to the usual cap.
 * When even the minimums exceed the budget they are returned as is, and the
 * caller's size check refuses the request.
 */
function allocateTranscriptBytes(transcripts: string[], availableBytes: number): number[] {
  const demand = transcripts.map((transcript) => utf8Bytes(transcriptExcerpt(transcript, Infinity)));
  const minimum = transcripts.map((transcript, index) =>
    Math.min(demand[index], utf8Bytes(transcriptExcerpt(transcript, Infinity, MEETING_TRANSCRIPT_MIN_CHARS))));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  let remaining = availableBytes - sum(minimum);
  let unmet = sum(demand) - sum(minimum);
  return minimum.map((bytes, index) => {
    const need = demand[index] - bytes;
    const share = remaining > 0 && unmet > 0 ? Math.min(need, Math.floor((remaining * need) / unmet)) : 0;
    remaining -= share;
    unmet -= need;
    return bytes + share;
  });
}

function formatRecentMeetings(
  meetings: DealForPreparation["meetings"],
  transcriptText: (transcript: string, index: number) => string = (transcript) => transcript.slice(0, MEETING_TRANSCRIPT_MAX_CHARS),
): string {
  if (meetings.length === 0) return "商談記録なし";
  return recentMeetings(meetings)
    .map((m, index) =>
      [
        `## ${m.title || "商談"} (${m.meetingDate.toISOString().slice(0, 10)})`,
        "### Authoritative transcript",
        m.transcript ? transcriptText(m.transcript, index) : "文字起こしなし",
        "### Generated meeting minutes (secondary source)",
        m.minutes ? m.minutes.slice(0, 1400) : "議事録なし",
        "### Meeting BANT",
        `- budget: ${m.bantBudget || "未確定"}`,
        `- authority: ${m.bantAuthority || "未確定"}`,
        `- need: ${m.bantNeed || "未確定"}`,
        `- timeline: ${m.bantTimeline || "未確定"}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

/**
 * @param options.fitVertexFormatting Vertex の整形呼出し（検索結果と合わせて1回65,536バイト）に収まるよう、
 *   超える場合だけ文字起こしを縮める。上限の無い経路（Anthropic）では false にして従来のプロンプトを使う。
 */
export function buildPreparationResearchPrompt(
  deal: DealForPreparation,
  lumaContextText: string,
  { fitVertexFormatting = true }: { fitVertexFormatting?: boolean } = {},
): Pick<CallOptions, "system" | "cacheableSystem" | "user" | "maxTokens" | "temperature"> {
  const registeredProductNames = uniqueProductNames(
    deal.products.flatMap((product) => [product.productName, product.planName, ...product.planProposals]),
    extractLumaProductNamesFromContext(lumaContextText),
  );
  const system = `
You are a B2B sales preparation researcher for Luma.
Use Japanese. Return JSON only.
Use web_search to verify public facts about the company, hiring activity, recruiting media, roles, scale, and relevant industry context.
Every public factual statement must have a verified source URL belonging to the identified target company or explicitly relevant source. If you cannot verify it, write exactly "確認できず".
First establish the exact target company identity. If it cannot be identified, stop public research and do not substitute similarly named companies, expand into other industries, or use unrelated companies as target-company evidence. A confectionery company and a food-sample manufacturer are different entities and industries.
Internal records are not public research: cite the meeting title/date and a literal excerpt, label them 社内商談記録, and do not invent a URL for them. The sources and hiring_insights.sources arrays contain only verified public URLs; never mix internal BANT, meeting notes, or an unverified website summary into them.
Hypotheses are allowed, but mark confidence as high, medium, or low and do not present them as facts.
Create proposal_story from the verified research and the Luma product context in the same response. Do not call another search for the story.
proposal_story must be Japanese text with exactly these markdown headings:
# つかみ
# 課題共感
# 商材提案
# 効果イメージ
# 確認論点
In # 商材提案, use a registered product name only when the registered-name list below is nonempty. Do not invent product names.

Evidence and offer guardrails:
- For internal meeting facts, treat the authoritative transcript as the primary source. Generated meeting minutes and Meeting BANT are secondary summaries. If they omit or conflict with the transcript, follow the transcript and do not claim that a response or fact was absent.
- Use the newest explicit customer statement first, with its meeting date and literal excerpt. A manual BANT field is protected user input, not proof that it is newer or more certain than the meeting record. Never copy old manual certainty, generated suggestions, or bookkeeping markers as evidence.
- Compare the meaning, subject, conditions, and scope of manual BANT and the latest explicit meeting statement before claiming a conflict. Paraphrases, summaries, added detail, different metrics, compatible milestones, or a broader goal and a specific need are not evidence of contradiction. For example, a note about applications and conversion to interviews can complement an application-shortage summary; an 800,000 JPY target and a 1,000,000 JPY possible ceiling can both be true. Do not downgrade both records to unconfirmed merely because their wording differs.
- Internal record comparisons are source-linked references, not a list of proven conflicts. Only explicit, incompatible statements about the same subject and conditions should be described as an unresolved conflict in # 確認論点, with both sources. Otherwise retain compatible context, or neutrally ask how the records relate when unclear. Do not decide which conflicting record is currently correct, combine different people into an invented approval hierarchy, or present either disputed decision-maker as confirmed in the proposal. Distinguish a contact person from the final decision-maker and ask about approval roles.
- Missing information is not a contradiction. If the latest record does not discuss an item, do not claim that it changed or that a prior fact was denied. A newer summary alone cannot override the authoritative transcript.
- Preserve the population and scope stated by each source. Never narrow an all-industry or all-company statistic into a food or confectionery manufacturer statistic.
- Treat a public-research number, ratio, percentage, date, or duration as fact only when that exact value is verifiable at its cited URL. Treat an internal number or date as fact only when the exact value appears in the meeting record. Otherwise write exactly "確認できず" or omit it.
- Do not infer causation or a person's inner thoughts from meeting facts. For example, "応募30%減" and "動画が古い" do not prove that the old video caused the decline; write causation as a hypothesis, and move unrecorded intentions of the HR director to # 確認論点.
- # 効果イメージ contains hypotheses, not guaranteed facts. Do not state unsourced claims such as "エントリーが増える傾向" or "離職が下がる" as facts, and never fabricate KPI values.
- Do not add date or duration precision that is absent from the meeting record or catalog. Never attribute "約4ヶ月後" to meeting notes unless that exact duration was recorded. Never invent a production lead time such as "制作期間（目安8週間）" unless that exact duration is in the catalog or meeting record; if unknown, say the schedule is unconfirmed.
- Registered names for this request are ${JSON.stringify(registeredProductNames)}. In # 商材提案, use only these exact formal names from the current Deal products or catalog rows.
- Usage rules, example sentences, and general service descriptions are not catalog registrations. If the registered-name list is empty, state that 商材・プランは未登録 and 取り扱い要確認; do not borrow product names from examples or propose product-specific effects. Ask to confirm the available offerings instead.${registeredProductNames.length === 0 ? `\n${UNREGISTERED_OFFER_RULE}` : ""}
- Do not claim unregistered capabilities as Luma services. 採用サイトリニューアルの同期設計・スケジュール管理 and 役員会向けROI資料の共同作成 are not catalog capabilities; move them to # 確認論点 unless the catalog explicitly provides them.

Output schema:
{
  "industry_summary": "string",
  "hiring_insights": {
    "media": "string",
    "roles": "string",
    "scale": "string",
    "sources": [{ "title": "string", "url": "https://..." }]
  },
  "pain_hypotheses": [
    { "hypothesis": "string", "confidence": "high|medium|low", "evidence": "string", "source_url": "https://... or empty string" }
  ],
  "proposal_story": "# つかみ\n...\n\n# 課題共感\n...\n\n# 商材提案\n...\n\n# 効果イメージ\n...\n\n# 確認論点\n...",
  "sources": [{ "title": "string", "url": "https://..." }],
  "disclaimer": "${PREPARATION_DISCLAIMER}"
}
`.trim();

  const cacheableSystem = formatLumaContextForPrompt(lumaContextText);
  const internalReviewsJson = JSON.stringify(preparationInternalReviews(deal), null, 2);
  const promptWith = (transcriptText?: (transcript: string, index: number) => string) => ({
    system,
    cacheableSystem,
    user: `
# Internal deal data (not independently verified public facts)
- id: ${deal.id}
- company: ${deal.company.name}
- company_industry: ${deal.company.industry || UNCONFIRMED}
- employee_count: ${deal.company.employeeCount ?? UNCONFIRMED}
- title: ${deal.title}
- status: ${deal.status}

# Internal website summary (unverified reference, not a public citation)
${deal.company.websiteSummary || UNCONFIRMED}

# Deal products
${formatDealProducts(deal.products)}

# Deal BANT aggregate (historical internal references; not confirmed current facts)
${serializeBantForPrompt(deal.bant)}

# Internal record comparisons (wording differences alone do not prove a conflict)
${internalReviewsJson}

# Recent meeting notes
${formatRecentMeetings(deal.meetings, transcriptText)}
`.trim(),
    maxTokens: 8192,
    temperature: 0.2,
  });

  const prompt = promptWith();
  if (!fitVertexFormatting || preparationFormattingWorstCaseBytes(prompt) <= VERTEX_MAX_INPUT_BYTES) return prompt;
  // The Vertex formatting call embeds this prompt with the search result and
  // has a fixed input limit. Transcripts are the only part cut to fit it.
  const transcripts = recentMeetings(deal.meetings).map((m) => m.transcript ?? "");
  const availableBytes = VERTEX_MAX_INPUT_BYTES - preparationFormattingWorstCaseBytes(promptWith(() => ""));
  const budgets = allocateTranscriptBytes(transcripts, availableBytes);
  return promptWith((transcript, index) => transcriptExcerpt(transcript, budgets[index]));
}

export function buildPreparationWebSearchRequest(
  prompt: Pick<CallOptions, "system" | "cacheableSystem" | "user" | "maxTokens" | "temperature">,
): CallOptions & { tools: Array<Record<string, unknown>> } {
  return {
    ...prompt,
    tools: buildPreparationWebSearchTools(),
  };
}

async function loadDealForPreparation(dealId: string): Promise<DealForPreparation | null> {
  const { prisma } = await import("@/lib/db");
  return prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      title: true,
      status: true,
      bant: true,
      company: {
        select: {
          name: true,
          industry: true,
          employeeCount: true,
          websiteSummary: true,
        },
      },
      products: {
        select: {
          productName: true,
          planName: true,
          planProposals: true,
          yomiStatus: true,
          amount: true,
        },
      },
      meetings: {
        orderBy: { meetingDate: "desc" },
        take: 3,
        select: {
          title: true,
          meetingDate: true,
          transcript: true,
          minutes: true,
          bantBudget: true,
          bantAuthority: true,
          bantNeed: true,
          bantTimeline: true,
        },
      },
    },
  });
}

export async function generatePreparationResearch(
  dealId: string,
  progress: { onGenerating?: () => Promise<void> } = {},
): Promise<{ brief: PreparationResearchOutput; fallback: boolean; model: string; error: string | null }> {
  const deal = await loadDealForPreparation(dealId);
  if (!deal) throw new Error(`Deal not found: ${dealId}`);

  const lumaContextText = await getLumaContextText({
    dealProducts: deal.products as LumaContextDealProduct[],
  });
  const catalogProductNames = extractLumaProductNamesFromContext(lumaContextText);
  const dealProductNames = deal.products.map((product) => product.productName);
  const internalReviews = preparationInternalReviews(deal);
  const provider = getHeavyTextProvider();
  const prompt = buildPreparationResearchPrompt(deal, lumaContextText, { fitVertexFormatting: provider === "vertex" });
  const request = buildPreparationWebSearchRequest(prompt);
  if (provider === "vertex") {
    // The search call reserves 100 JPY before the formatting call's own size
    // check, so refuse here when the formatting call could not fit.
    if (preparationFormattingWorstCaseBytes(prompt) > VERTEX_MAX_INPUT_BYTES) {
      throw new VertexError("input_limit", PREPARATION_INPUT_LIMIT_MESSAGE);
    }
    // Search and formatting are two calls here, so 生成中 is reported between them.
    const result = await vertexPreparation(deal.company.name, prompt, undefined, progress.onGenerating);
    const brief = normalizePreparationOutput(result.parsed, { companyName: deal.company.name, catalogProductNames, dealProductNames, internalReviews });
    brief.talking_points = { items: brief.talking_points ?? [], vertexGrounding: result.grounding };
    return { brief, fallback: false, model: result.model, error: null };
  }
  if (provider !== "anthropic" || !hasAnthropicKey()) {
    console.warn("[preparation] skip web_search", {
      provider,
      hasAnthropicKey: hasAnthropicKey(),
    });
    return {
      brief: fallbackPreparationBrief(deal.company.name, {
        catalogProductNames,
        dealProductNames,
      }),
      fallback: true,
      model: `fallback:provider_${provider}_key_${hasAnthropicKey() ? "on" : "off"}`,
      error: `provider=${provider} key=${hasAnthropicKey() ? "on" : "off"}`,
    };
  }

  // One call both searches (web_search tool) and writes the JSON, so there is no
  // point between research and generation to report: this path cannot show a
  // separate 生成中 stage and the panel goes from リサーチ中 to 完了/失敗.
  const result = await callClaudeHeavyJSONWithTools<PreparationResearchOutput>({ ...request, feature: "brief" });

  if (!result.parsed) {
    const error = formatAnthropicDebug(result.debug);
    console.warn("[preparation] web_search returned no JSON", error);
    return {
      brief: fallbackPreparationBrief(deal.company.name, {
        catalogProductNames,
        dealProductNames,
      }),
      fallback: true,
      model: "fallback:no_parse_or_call",
      error,
    };
  }

  return {
    brief: normalizePreparationOutput(result.parsed, {
      companyName: deal.company.name,
      catalogProductNames,
      dealProductNames,
      internalReviews,
    }),
    fallback: false,
    model: getAnthropicModelName(),
    error: null,
  };
}

export async function runPreparationBrief(briefId: string, dealId: string): Promise<void> {
  const { prisma } = await import("@/lib/db");
  try {
    await prisma.preparationBrief.update({
      where: { id: briefId },
      data: { status: "researching", error: null },
    });

    let generatingSaved = false;
    const saveGenerating = async () => {
      await prisma.preparationBrief.update({
        where: { id: briefId },
        data: { status: "generating" },
      });
      generatingSaved = true;
    };
    // Vertex saves 生成中 after its search call, while the formatting call runs.
    const result = await generatePreparationResearch(dealId, { onGenerating: saveGenerating });
    // The Anthropic path (and the fallback) has no such point: its one call
    // searches and generates together, so 生成中 is written just before 完了 as before.
    if (!generatingSaved) await saveGenerating();
    await prisma.preparationBrief.update({
      where: { id: briefId },
      data: {
        status: result.fallback ? "error" : "done",
        error: result.error,
        industrySummary: result.brief.industry_summary,
        hiringInsights: result.brief.hiring_insights as unknown as object,
        painHypotheses: result.brief.pain_hypotheses as unknown as object,
        proposalStory: result.brief.proposal_story ?? null,
        talkingPoints: result.brief.talking_points as object | undefined,
        sources: result.brief.sources as unknown as object,
        model: result.model,
      },
    });
    await prisma.aiLog.create({
      data: {
        dealId,
        step: "preparation_v2",
        input: {
          webSearchMaxUses: PREPARATION_WEB_SEARCH_MAX_USES,
        } as object,
        output: {
          fallback: result.fallback,
          status: result.fallback ? "error" : "done",
          sourcesCount: result.brief.sources.length,
          debug: result.error,
        } as object,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.preparationBrief.update({
      where: { id: briefId },
      data: { status: "error", error: message.slice(0, 2000) },
    });
  }
}
