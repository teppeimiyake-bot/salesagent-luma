import { BANT_KEYS, BANT_UNKNOWN_VALUES, type BantKey, type BantStatus } from "./bant-definitions";
import { findBantWithdrawal } from "./bant-withdrawal";
import { groundTimeline, splitRunOnSpeakerTurns, timelineEvidenceLines, timelineSourceTurns } from "./timeline-evidence";

export const BANT_RECENT_MEETINGS_LIMIT = 5;

export type MeetingBantEvidence = {
  value: string;
  status: "estimated" | "unknown";
  source_meeting_id: string;
  quote: string;
};

const MEETING_FIELDS: Record<BantKey, string> = {
  budget: "bantBudget",
  authority: "bantAuthority",
  need: "bantNeed",
  timeline: "bantTimeline",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compact(value: unknown): string {
  return text(value).replace(/\s+/gu, "");
}

/** A conversation stage alone is not a customer need. Preserve all other text. */
export function normalizeUnconfirmedNeed(value: string): string {
  return /^(?:情報収集|情報交換)(?:(?:の)?段階)?(?:のみ)?(?:です)?[。.]?$/u.test(compact(value))
    ? BANT_UNKNOWN_VALUES.need : value;
}

function hasBudgetAmount(value: string): boolean {
  return /(?:[\d０-９一二三四五六七八九十百千万億兆,.，．]+(?:億|万|千)?円|[¥￥][\d０-９,.，．]+)/u.test(value);
}

/** Limited explicit tentative-budget forms; this is not a general semantic classifier. */
function hasTentativeBudget(value: unknown): boolean {
  const clauses = text(value).split(/[。\r\n、,；;]/u).map(compact).filter(Boolean);
  const amountClauses = clauses.filter(hasBudgetAmount);
  if (!amountClauses.length) return false;
  const unapproved = /(?:承認待ち|未承認)|承認(?:は|が|を)?(?:まだ|現時点では)?(?:未取得|未了|未完了|取れてい(?:ない|ません)|取得してい(?:ない|ません)|得られてい(?:ない|ません))/u;
  const approved = /(?:承認済み|承認済|承認を取得済み|承認されました|承認されています|確保済み|確保しました|確保しています)/u;
  // "導入時期は検討中" must not qualify a separately approved budget.
  return amountClauses.some((clause) => !approved.test(clause) &&
    (/(?:目安|仮予算|概算|暫定予算|検討中)/u.test(clause) || unapproved.test(clause))) ||
    (!amountClauses.some((clause) => approved.test(clause)) && clauses.some((clause) => unapproved.test(clause)));
}

type TimelineDate = { year?: number; month: number; day?: number };

function timelineDates(value: string): TimelineDate[] {
  return Array.from(value.matchAll(/(?:(\d{4})年)?(\d{1,2})月(?:(\d{1,2})日)?|(\d{4})[-/](\d{1,2})[-/](\d{1,2})/gu), (match) => ({
    year: match[1] || match[4] ? Number(match[1] || match[4]) : undefined,
    month: Number(match[2] || match[5]),
    day: match[3] || match[6] ? Number(match[3] || match[6]) : undefined,
  }));
}

/** Bound explicit provisional timing to its own date, not a budget or meeting date. */
function hasTentativeTimeline(value: unknown, referenceValue?: unknown): boolean {
  const referenceDates = timelineDates(compact(referenceValue).normalize("NFKC"));
  const clauses = text(value).normalize("NFKC").split(/[。\r\n、,；;]/u).map(compact).filter(Boolean);
  const lifecycle = /導入|運用開始|利用開始|稼働開始|本番稼働|公開|納品/u;
  const otherSubject = /面談|打ち合わせ|会議|商談|見積|資料|予算|制作費|費用|金額/u;
  const conditional = /(?:導入|運用開始|利用開始|稼働開始|本番稼働)(?:する)?(?:なら|場合(?:は)?|としたら)/u;
  const hope = /希望(?!(?:では(?:なく|ない|ありません)|でなく|(?:は|が)?(?:ない|ありません)|し(?:てい)?(?:ない|ません)|してい(?:た|ました)|だった|でした))/u;
  const unresolvedTiming = /(?:正式(?:な)?(?:導入)?(?:時期|日付|日程)|導入時期)(?:は|が)?(?:まだ)?(?:未確定|未定)(?:です|である)?$/u;

  return clauses.some((clause, index) => {
    const dates = timelineDates(clause);
    // Ambiguous multi-date clauses need semantic analysis beyond this guard.
    if (dates.length !== 1 || otherSubject.test(clause)) return false;
    const date = dates[0];
    if (referenceDates.length && !referenceDates.some((reference) =>
      reference.month === date.month &&
      (!reference.year || !date.year || reference.year === date.year) &&
      (!reference.day || !date.day || reference.day === date.day),
    )) return false;
    const previous = clauses[index - 1] ?? "";
    const previousCondition = !timelineDates(previous).length && !otherSubject.test(previous) && conditional.test(previous);
    // A Timeline value supplies the subject for "2027年6月希望". Quotes
    // require an explicit lifecycle subject (possibly just before a comma).
    const hasSubject = lifecycle.test(clause) || previousCondition || referenceValue === undefined;
    if (!hasSubject) return false;
    if (conditional.test(clause) || previousCondition || hope.test(clause) || unresolvedTiming.test(clause)) return true;
    const next = clauses[index + 1] ?? "";
    return !timelineDates(next).length && !otherSubject.test(next) && unresolvedTiming.test(next);
  });
}

function isUnresolvedStatement(statement: string): boolean {
  // A mixed statement with an actual amount/date is not unknown-only. Preserve
  // its concrete information; tentative budget certainty is handled separately.
  if (/[\d０-９]/u.test(statement) || hasBudgetAmount(statement)) return false;
  const clauses = statement.split(/[、,]|だが|ですが|ものの/u);
  if (clauses.slice(0, -1).some((clause) =>
    /(?:確認済み|確定済み|承認済み|確保済み|合意済み|決定済み|(?:が|は)課題(?:で|です)?$|不足している$|必要です$)/u.test(clause),
  )) return false;
  // In "決裁者は社長、承認経路は未確認", the uncertainty belongs to
  // the approval path. A bare enumeration ("決裁者、承認経路は未確認")
  // has no separate predicate and remains unresolved.
  if (clauses.slice(0, -1).some((clause) =>
    /(?:決裁者|決裁権者|決裁する人)(?:は|が|[:：]).+/u.test(clause) && !isUnresolvedStatement(clause),
  )) return false;
  return /(?:不明|未確認|未確定|未設定|未定)(?:です|である|となっている)?$/u.test(statement) ||
    /(?:分からない|分かりません|わからない|わかりません|分かっていない|分かっていません|確認できていない|確認できていません)(?:です)?$/u.test(statement) ||
    /(?:かどうか|するか)(?:も|は)?決めてい(?:ない|ません)$/u.test(statement);
}

function isUnknownPlaceholder(candidate: string): boolean {
  return !candidate ||
    /^(?:未確定|未確認|未設定|不明|確認できず|該当する発言なし)/u.test(candidate) ||
    /^未定(?:$|[:：])/u.test(candidate);
}

/** Unknown placeholders and narrowly recognizable unknown-only explanations are not evidence. */
export function isUnknownBantValue(value: unknown): boolean {
  const candidate = compact(value);
  // An unknown prefix must not discard an explicitly provisional amount.
  if (hasTentativeBudget(value)) return false;
  if (isUnknownPlaceholder(candidate)) return true;
  const statements = text(value).split(/[。\r\n]/u).map(compact).filter(Boolean);
  return statements.some(isUnresolvedStatement) && statements.every((statement) =>
    isUnresolvedStatement(statement) || /^(?:今回|本日)(?:は情報交換(?:が目的)?|の目的は情報交換)(?:です|である)?$/u.test(statement),
  );
}

/** Correct only explicit uncertainty; never promote a model's unknown to confirmed. */
export function constrainBantStatus(
  key: BantKey,
  value: unknown,
  status: BantStatus,
  quote?: unknown,
): BantStatus {
  if (key === "need" && typeof value === "string" && normalizeUnconfirmedNeed(value) !== value) return "unknown";
  if (isUnknownBantValue(value)) return "unknown";
  if (key === "authority") {
    // Knowing the contact's role is not evidence of final decision authority.
    // Use the last decision-maker statement so an older unknown cannot undo a
    // subsequently identified approver; unknown approval steps alone do not
    // erase an identified decision-maker either.
    const lastDecision = text(value).split(/[。;；\r\n]/u).map(compact).filter(part => /決裁者|決裁権者|決裁する人/u.test(part)).at(-1) ?? "";
    if (/(?:誰が)?(?:最終)?(?:決裁者|決裁権者|決裁する人)(?:か|なのか)?(?:(?:と|や|および|[、,・／/])(?:正式な)?承認経路)?(?:は|が|も)?(?:まだ)?(?:未確認|未確定|未定|不明|確認できていません|確認できていない)(?:です|である)?$/u.test(lastDecision)) return "unknown";
  }
  if (key === "budget" && status === "confirmed" &&
    (hasTentativeBudget(value) || hasTentativeBudget(quote))) return "estimated";
  if (key === "timeline" && status === "confirmed" &&
    (hasTentativeTimeline(value) || hasTentativeTimeline(quote, value))) return "estimated";
  return status;
}

/** Same evidence item regardless of key order (Postgres jsonb returns keys reordered). */
function sameEvidence(item: unknown, evidence: MeetingBantEvidence): boolean {
  return isRecord(item) && Object.keys(item).length === Object.keys(evidence).length &&
    (Object.keys(evidence) as Array<keyof MeetingBantEvidence>).every((field) => item[field] === evidence[field]);
}

function fieldText(value: unknown): string {
  return isRecord(value) ? text(value.value) : text(value);
}

function meetingTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

function recentMeetings(meetings: readonly unknown[]): Array<Record<string, unknown>> {
  return meetings
    .filter(isRecord)
    .filter((meeting) => text(meeting.id) && Number.isFinite(meetingTimestamp(meeting.meetingDate)))
    .map((meeting) => ({ meeting, timestamp: meetingTimestamp(meeting.meetingDate) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, BANT_RECENT_MEETINGS_LIMIT)
    .map(({ meeting }) => meeting);
}

/** Generated/unknown-origin minutes and derived BANT are not quotation sources. */
export function bantQuotationSources(meeting: unknown): string[] {
  if (!isRecord(meeting)) return [];
  const sources = [text(meeting.transcript)];
  // manual_text alone is insufficient: its transcript can also produce AI
  // minutes. Generated minutes have minutesJson; legacy unknown provenance is
  // deliberately not inferred to be manual.
  if (meeting.sourceType === "manual_text" && meeting.minutesJson === null) {
    sources.push(text(meeting.minutes));
  }
  return sources.filter(Boolean);
}

function isNeedHypothesis(value: unknown): boolean {
  return /仮説|推測|推定|可能性|かもしれ(?:ない|ません)/u.test(text(value));
}

function groundedNeedValue(key: BantKey, value: unknown, source?: Record<string, unknown>): unknown {
  if (key !== "need") return value;
  if (typeof value === "string") {
    const normalized = normalizeUnconfirmedNeed(value);
    if (normalized !== value) return normalized;
  }
  if (!isNeedHypothesis(value)) return recoverExplicitNeedStatement(source, value) || value;
  const statement = text(value).replace(/^文字起こし記載\s*[:：]\s*/u, "");
  // A quoted unknown fragment cannot validate a new hypothetical need appended
  // by an earlier AI step. Require this actual statement in primary evidence.
  const originals = source ? bantQuotationSources(source) : [];
  if (originals.some((original) => original.includes(statement))) return value;
  // Retain independently stated facts in mixed text, but never invent a
  // paraphrase or promote an unknown/question fragment to a concrete need.
  const factualStatements = (statement.match(/[^。\r\n]+。?/gu) ?? []).map((part) => part.trim()).filter((part) =>
    !isNeedHypothesis(part) && !/[?？]|未確認|未確定|未集計|不明|分から|分かりません|わから|わかりません/u.test(part) &&
    /課題|困って|不足|解決|改善したい|必要|希望/u.test(part) &&
    originals.some((original) => original.includes(part)),
  );
  return factualStatements.length ? factualStatements.join("\n") : BANT_UNKNOWN_VALUES.need;
}

/** Keep only unfinished customer turns with contiguous indented paste wraps. */
function customerNeedBodies(original: string): string[] {
  const bodies: string[] = [];
  let body: string | null = null;
  let previousLine = "";
  let separator = "";
  const flush = () => {
    if (body !== null) bodies.push(body);
    body = null;
  };
  for (const rawLine of original.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (!rawLine) continue;
    const ending = rawLine.match(/\r?\n$/u)?.[0] ?? "";
    const line = rawLine.slice(0, rawLine.length - ending.length);
    const customer = line.match(/^[ \t\u3000]*(?:顧客|先方|お客様)\s*[:：]([\s\S]*)$/u);
    if (customer) {
      flush();
      body = customer[1];
    } else if (body !== null && previousLine.trim() && /^[ \t\u3000]+\S/u.test(line) &&
      !/^[ \t\u3000]*[^:：\r\n]{1,40}[:：]/u.test(line) &&
      !/[。！？!?．.][」』"”）)]*$/u.test(previousLine.trim())) {
      body += separator + line;
    } else {
      flush();
    }
    previousLine = line;
    separator = ending;
  }
  flush();
  return bodies;
}

/** A multi-sentence paraphrase cannot serve as a literal quote. When its first
 * claim exactly matches an explicit customer problem statement (apart from the
 * final copula), retain that supported statement instead of appended inference.
 * "少ない" describes a concrete problem here; it is not a denial of the problem.
 */
function recoverExplicitNeedStatement(source: Record<string, unknown> | undefined, value: unknown): string {
  if (!source || typeof value !== "string" || isUnknownBantValue(value)) return "";
  const first = value.split(/[。\r\n]/u)[0].trim().replace(/(?:です|である)$/u, "");
  const core = first.replace(/(?:(?:こと|点|部分)が課題|という課題(?:を解決したい|がある|を抱えている)?)$/u, "");
  if (core === first || core.length < 12) return "";
  const matches = new Set<string>();
  for (const original of bantQuotationSources(source)) {
    for (const body of customerNeedBodies(original)) {
      if (/(?:営業|当社|弊社|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(body)) continue;
      for (const part of body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
        const sentence = part.trim();
        const comparison = sentence.replace(/[ \t\u3000]*\r?\n[ \t\u3000]+/gu, "");
        if (!comparison.includes(core)) continue;
        // Refuse reported, conditional, unresolved, withdrawn or denied claims.
        if (/他社|他の会社|別会社|競合|同業|[「」『』“”"?？]|仮説|可能性|未確認|未確定|不明|分から|わから|もし|仮に|なら|場合|撤回|取り下げ|解消|解決済|によると|によれば/u.test(comparison)) return "";
        if (!["こと", "点", "部分"].some(noun => comparison === `${core}${noun}が課題です。` || comparison === `${core}${noun}が課題である。`)) return "";
        matches.add(sentence);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : "";
}

/** Recover a current numeric budget declaration and its adjacent approval
 * qualification. Do not pick an earlier matching amount over a later budget
 * correction or unknown statement, and never use quoted/other-company prices.
 */
function recoverBudgetQuote(source: Record<string, unknown>, value: unknown): string {
  const amounts = (candidate: string) => [...candidate.normalize("NFKC").matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:万|億)?円/gu)].map(match => match[0].replace(/,/gu, ""));
  const requested = [...new Set(amounts(text(value)))];
  if (requested.length !== 1 || isUnknownBantValue(value)) return "";
  let latest = "";
  for (const original of bantQuotationSources(source)) {
    for (const body of customerNeedBodies(original)) {
      const sentences = body.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
      for (let index = 0; index < sentences.length; index++) {
        const sentence = sentences[index].trim();
        if (!/予算/u.test(sentence)) continue;
        const found = [...new Set(amounts(sentence))];
        if (!found.length && !/未確認|未確定|未定|不明|撤回|訂正|取り下げ/u.test(sentence)) continue;
        latest = "";
        if (found.length !== 1 || found[0] !== requested[0] || /他社|他の会社|別会社|競合|[「」『』“”"?？]|もし|仮に|なら|場合|撤回|取り下げ|未定|不明/u.test(sentence)) continue;
        const next = sentences[index + 1] ?? "";
        const qualification = /承認|確保|目安|仮の/u.test(next) && !amounts(next).length ? next : "";
        const literal = sentences[index] + qualification;
        if (literal.length > 600 || !original.includes(literal)) continue;
        // A tentative value needs a source that actually retains its caveat.
        if (hasTentativeBudget(value) && !hasTentativeBudget(literal)) continue;
        latest = literal.trim();
      }
    }
  }
  return latest;
}

/** Recover an unambiguous, explicitly positive customer sentence, not a paraphrase. */
function recoverNeedQuote(source: Record<string, unknown>, value: unknown): string {
  if (isUnknownBantValue(value) || isNeedHypothesis(value)) return "";
  const needle = text(value).replace(/[。．.!！]+$/u, "").trim();
  if (!needle) return "";
  const quotes = new Set<string>();
  for (const original of bantQuotationSources(source)) {
    for (const body of customerNeedBodies(original)) {
      if (/(?:営業|当社|弊社|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u.test(body) ||
        /(?:^|[\s。！？!?])[^\s:：\d０-９]{1,20}\s*[:：]/u.test(body)) continue;
      for (const part of body.match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
        const sentence = part.trim();
        // Compare only validated wrap whitespace differently; the returned quote
        // keeps the original line endings and indentation, without truncation.
        const comparison = sentence.replace(/[ \t\u3000]*\r?\n[ \t\u3000]+/gu, "");
        if (!comparison.includes(needle)) continue;
        // A customer can quote an adviser or discuss another company's problem.
        // These literal matches do not establish the customer's own Need.
        if (/他社|他の会社|別会社|競合|同業|[「」『』“”"]|(?:と|って)(?:説明|聞|言|伝え|教え|報告)|によると|によれば/u.test(comparison)) return "";
        // Do not select an earlier positive occurrence over a contradictory or
        // unknown occurrence in the same source. Leave ambiguous evidence empty.
        if (isNeedHypothesis(comparison) || /[?？]|(?:です|ます|でしょう|なの|なのです)か(?:ね|な|しら)?[。.!！]?$|未確認|未確定|未集計|未調査|不明|分から|分かりません|わから|わかりません|ない|ありません|ません|なく|無い|もし|仮に|なら|場合|撤回|取り下げ|解消済|解消した|解消しました|解決済/u.test(comparison)) return "";
        if (/(?:課題|問題)(?:は|が)?(?:引き続き|現在も|まだ)?(?:あります|ある|残っています)|(?:課題|問題)(?:です|である|となっています|になっています)|不足してい(?:る|ます)|困ってい(?:る|ます)|必要です|希望してい(?:る|ます)|改善したい|削減したい|統一したい/u.test(comparison)) quotes.add(sentence);
      }
    }
  }
  return quotes.size === 1 ? [...quotes][0] : "";
}

/** Recover only a date-matched, source-grounded Timeline passage from this meeting. */
function recoverTimelineQuote(source: Record<string, unknown>, value: unknown): string {
  if (isUnknownBantValue(value)) return "";
  const dates = timelineDates(compact(value).normalize("NFKC"));
  const saved = text(source.bantTimeline);
  if (dates.length !== 1 || !/^文字起こし記載\s*[:：]/u.test(saved)) return "";
  const expected = dates[0];
  const matchesDate = (candidate: TimelineDate) => candidate.month === expected.month &&
    (expected.year === undefined || candidate.year === expected.year) &&
    (expected.day === undefined || candidate.day === expected.day);
  for (const stored of bantQuotationSources(source)) {
    // T04: the meeting analysis reads a one-line transcript per speaker turn (splitRunOnSpeakerTurns); read it the same way.
    const original = splitRunOnSpeakerTurns(stored);
    const selected = timelineSourceTurns(original).filter((turn) => saved.includes(turn.text) &&
      timelineDates(compact(turn.text).normalize("NFKC")).some(matchesDate));
    // Do not choose between multiple dates/turns or infer a source from derived
    // prose. The existing guard rejects sales questions and unrelated schedules.
    if (selected.length !== 1) continue;
    const grounded = groundTimeline(original, selected.map((turn) => turn.id));
    if (!grounded.sourceIds.length) continue;
    const quote = grounded.sourceQuotes.join("\n");
    const quoteDates = timelineDates(compact(quote).normalize("NFKC"));
    if (quoteDates.length !== 1 || !matchesDate(quoteDates[0])) continue;
    // Preserve complete conditional context, including original CRLFs. Do not
    // truncate at the old 240-character quotation limit and lose a late caveat.
    for (const literal of [quote, quote.replace(/\n/gu, "\r\n")]) {
      if (literal && original.includes(literal)) return literal;
    }
  }
  return "";
}

const TIMELINE_WITHDRAWAL = /撤回|取り下げ|取り消|白紙/u;

/** T06: a quote made only of a withdrawal line (no independent timing evidence) must not appear as the source. */
function isWithdrawalOnlyTimelineQuote(quote: string): boolean {
  return TIMELINE_WITHDRAWAL.test(quote) && !timelineEvidenceLines(quote).length;
}

/**
 * T06: the meeting's grounded Timeline evidence lines (without leading withdrawal context saved before
 * the fix), when every date they carry also appears in the value. Returns the literal passage or "".
 */
function recoverSavedTimelineEvidence(source: Record<string, unknown>, value: unknown): string {
  const saved = text(source.bantTimeline);
  if (isUnknownBantValue(value) || !/^文字起こし記載\s*[:：]/u.test(saved)) return "";
  const evidence = timelineEvidenceLines(saved.replace(/^文字起こし記載\s*[:：]\s*/u, ""));
  if (!evidence.length) return "";
  const valueDates = timelineDates(compact(value).normalize("NFKC"));
  const evidenceDates = timelineDates(compact(evidence.join("\n")).normalize("NFKC"));
  if (!evidenceDates.every((date) => valueDates.some((candidate) => candidate.month === date.month &&
    (date.year === undefined || candidate.year === undefined || candidate.year === date.year)))) return "";
  for (const stored of bantQuotationSources(source)) {
    const original = splitRunOnSpeakerTurns(stored);
    for (const literal of [evidence.join("\n"), evidence.join("\r\n")]) {
      if (original.includes(literal)) return literal;
    }
  }
  return "";
}

function verifyAutomaticItem(
  item: Record<string, unknown>,
  key: BantKey,
  meetings: readonly unknown[],
): Record<string, unknown> {
  const source = recentMeetings(meetings).find((meeting) => text(meeting.id) === text(item.source_meeting_id));
  const candidate = text(item.quote);
  let quote = candidate && source && bantQuotationSources(source).some((original) => original.includes(candidate))
    ? candidate : "";
  const sourceId = source ? text(source.id) : "";
  const requested = item.status === "confirmed" || item.status === "estimated" || item.status === "unknown"
    ? item.status : "estimated";
  const value = groundedNeedValue(key, item.value, source);
  if (value !== item.value && !isUnknownBantValue(value) && source) quote = originalQuote(source, text(value));
  if (!quote && key === "need" && source) quote = recoverNeedQuote(source, value);
  if (!quote && key === "budget" && source) quote = recoverBudgetQuote(source, value);
  const withdrawalOnly = key === "timeline" && !!quote && isWithdrawalOnlyTimelineQuote(quote);
  if (withdrawalOnly) quote = source ? recoverSavedTimelineEvidence(source, value) : "";
  if (!quote && key === "timeline" && source) quote = recoverTimelineQuote(source, value);
  let status = constrainBantStatus(key, value, requested, quote);
  if (key === "need" && isNeedHypothesis(value) && status === "confirmed") status = "estimated";
  // A saved/paraphrased concrete value can remain useful without a quotation,
  // but an absent primary citation cannot justify confirmed certainty.
  if (!quote && status === "confirmed") status = "estimated";
  if (item.value === value && text(item.quote) === quote && text(item.source_meeting_id) === sourceId && item.status === status) return item;
  return { ...item, value, quote, source_meeting_id: sourceId, status };
}

/** Only quote a literal passage that also exists in the stored source, never a generated paraphrase. */
function originalQuote(meeting: Record<string, unknown>, value: string): string {
  const candidates = value
    .replace(/^文字起こし記載\s*[:：]\s*/u, "")
    .split(/\r?\n|\s+\/\s+/u)
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  for (const source of bantQuotationSources(meeting)) {
    for (const candidate of candidates) {
      if (source.includes(candidate)) return candidate.slice(0, 240);
    }
  }
  return "";
}

/** Find the newest concrete value or explicit withdrawal; skip mere missing information. */
function meetingWithdrawal(meeting: Record<string, unknown>, key: BantKey): MeetingBantEvidence | null {
  for (const original of bantQuotationSources(meeting)) {
    const withdrawal = findBantWithdrawal(original, key);
    if (withdrawal) return { ...withdrawal, status: "unknown", source_meeting_id: text(meeting.id) };
  }
  return null;
}

export function findMeetingBantEvidence(
  meetings: readonly unknown[],
  key: BantKey,
): MeetingBantEvidence | null {
  for (const meeting of recentMeetings(meetings)) {
    const withdrawal = meetingWithdrawal(meeting, key);
    if (withdrawal) return withdrawal;
    const value = text(groundedNeedValue(key, meeting[MEETING_FIELDS[key]], meeting));
    if (isUnknownBantValue(value)) continue;
    return {
      value,
      status: "estimated",
      source_meeting_id: text(meeting.id),
      quote: (key === "timeline" ? recoverTimelineQuote(meeting, value) : key === "need" ? recoverNeedQuote(meeting, value) : key === "budget" ? recoverBudgetQuote(meeting, value) : "") || originalQuote(meeting, value),
    };
  }
  return null;
}

/** A previous manual edit is not meeting evidence for a newly generated proposal. */
function hasSuggestionEvidence(
  suggestion: unknown,
  key: BantKey,
  meetings: readonly unknown[],
): boolean {
  if (!isRecord(suggestion) || !text(suggestion.value)) return false;
  const sourceId = text(suggestion.source_meeting_id);
  const source = recentMeetings(meetings).find((meeting) => text(meeting.id) === sourceId);
  if (!source) return false;
  if (groundedNeedValue(key, suggestion.value, source) !== suggestion.value) return false;
  const quote = text(suggestion.quote);
  if (quote && bantQuotationSources(source).some((original) => original.includes(quote))) return true;
  if (key === "need" && recoverNeedQuote(source, suggestion.value)) return true;
  if (key === "timeline" && recoverTimelineQuote(source, suggestion.value)) return true;
  if (quote) return false;
  // Deterministic meeting BANT may be a paraphrase. Keep it estimated and leave
  // the quote empty; do not manufacture a verbatim citation for it.
  return suggestion.status === "estimated" &&
    !isUnknownBantValue(suggestion.value) &&
    text(suggestion.value) === text(source[MEETING_FIELDS[key]]);
}

/**
 * Fill only missing, non-manual deal BANT from saved meeting results.
 * Repair unsupported proposals that already exist beside protected manual fields.
 * This projection neither writes data nor invokes AI. Explicit automatic
 * uncertainty also constrains status; manual edits/items and metadata stay intact.
 */
export function reconcileBantFromMeetings(
  existing: unknown,
  meetings: readonly unknown[],
): Record<string, unknown> {
  const current = isRecord(existing) ? existing : {};
  const currentItems = isRecord(current.items) ? current.items : {};
  const currentSuggestions = isRecord(current.aiSuggestion) ? current.aiSuggestion : {};
  const manualFields = isRecord(current.manualFields) ? current.manualFields : {};
  let result = current;
  const changes: Array<{ key: BantKey; evidence: MeetingBantEvidence }> = [];
  const ordered = recentMeetings(meetings);

  for (const key of BANT_KEYS) {
    const latestEvidence = findMeetingBantEvidence(meetings, key);
    const barrierIndex = ordered.findIndex((meeting) => meetingWithdrawal(meeting, key));
    const superseded = (item: unknown): boolean => {
      if (!isRecord(item) || barrierIndex < 0 || !latestEvidence) return false;
      const sourceIndex = ordered.findIndex((meeting) => text(meeting.id) === text(item.source_meeting_id));
      const newestIndex = ordered.findIndex((meeting) => text(meeting.id) === latestEvidence.source_meeting_id);
      // A citation to the withdrawal itself cannot support the withdrawn value,
      // even when its literal quote still contains the historical amount/date.
      return sourceIndex >= barrierIndex && newestIndex >= 0 && newestIndex < barrierIndex;
    };
    const applicableItem = manualFields[key] === true ? currentSuggestions[key] : currentItems[key];
    if (latestEvidence && (latestEvidence.status === "unknown" || superseded(applicableItem))) {
      if (manualFields[key] === true) {
        // A read must not invent a proposal beside a protected manual field.
        if (Object.prototype.hasOwnProperty.call(currentSuggestions, key)) {
          result = { ...result, aiSuggestion: {
            ...(isRecord(result.aiSuggestion) ? result.aiSuggestion : {}), [key]: latestEvidence,
          } };
        }
      } else {
        changes.push({ key, evidence: latestEvidence });
        // T18 C4: a read of an already reconciled aggregate must return it unchanged, not a rebuilt copy.
        if (result[key] !== latestEvidence.value || !sameEvidence(isRecord(result.items) ? result.items[key] : undefined, latestEvidence)) {
          result = { ...result, [key]: latestEvidence.value, items: {
            ...(isRecord(result.items) ? result.items : {}), [key]: latestEvidence,
          } };
        }
      }
      continue;
    }
    if (manualFields[key] === true) {
      // A manual field on its own must not imply that AI has proposed a change.
      if (!Object.prototype.hasOwnProperty.call(currentSuggestions, key)) continue;
      if (hasSuggestionEvidence(currentSuggestions[key], key, meetings)) {
        const suggestion = currentSuggestions[key];
        if (isRecord(suggestion)) {
          const verified = verifyAutomaticItem(suggestion, key, meetings);
          if (verified !== suggestion) {
            result = { ...result, aiSuggestion: {
              ...(isRecord(result.aiSuggestion) ? result.aiSuggestion : {}),
              [key]: verified,
            } };
          }
        }
        continue;
      }
      const evidence = findMeetingBantEvidence(meetings, key);
      const suggestions = { ...(isRecord(result.aiSuggestion) ? result.aiSuggestion : {}) };
      if (evidence) suggestions[key] = evidence;
      else delete suggestions[key];
      result = { ...result };
      if (Object.keys(suggestions).length) result.aiSuggestion = suggestions;
      else delete result.aiSuggestion;
      continue;
    }
    const currentItem = currentItems[key];
    if (isRecord(currentItem)) {
      const verified = verifyAutomaticItem(currentItem, key, meetings);
      if (verified !== currentItem) {
        if (result === current) result = { ...current };
        if (result.items === current.items || !isRecord(result.items)) result.items = { ...currentItems };
        (result.items as Record<string, unknown>)[key] = verified;
      }
    }
    const itemSourceId = isRecord(currentItem) ? text(currentItem.source_meeting_id) : "";
    const itemSource = recentMeetings(meetings).find((meeting) => text(meeting.id) === itemSourceId);
    const groundedValue = groundedNeedValue(key, fieldText(current[key]), itemSource);
    if (groundedValue !== fieldText(current[key])) {
      if (result === current) result = { ...current };
      result[key] = groundedValue;
      if (!isRecord(currentItem)) {
        if (result.items === current.items || !isRecord(result.items)) result.items = { ...currentItems };
        (result.items as Record<string, unknown>)[key] = { value: BANT_UNKNOWN_VALUES.need, status: "unknown", source_meeting_id: "", quote: "" };
      }
    }
    if (!isUnknownBantValue(fieldText(result[key]))) continue;
    // An explicit unknown-only explanation is information, not a missing value.
    // Do not replace it with an older positive meeting result on a read.
    if (!isUnknownPlaceholder(compact(fieldText(result[key])))) continue;
    // The card prefers the top-level value. Repair inconsistent historical shapes
    // before looking at meetings, retaining the existing item's status and source.
    const existingItemValue = fieldText(isRecord(result.items) ? result.items[key] : undefined);
    if (!isUnknownBantValue(existingItemValue)) {
      if (result === current) result = { ...current, items: { ...currentItems } };
      result[key] = existingItemValue;
      continue;
    }
    const evidence = findMeetingBantEvidence(meetings, key);
    if (!evidence) continue;
    if (result === current) result = { ...current };
    if (result.items === current.items || !isRecord(result.items)) result.items = { ...currentItems };
    result[key] = evidence.value;
    (result.items as Record<string, unknown>)[key] = evidence;
  }

  if (changes.length && current.updatedBy !== "manual") {
    const summary = changes.map(({ key, evidence }) => {
      const label = key === "budget" ? "予算" : "導入時期";
      return evidence.status === "unknown"
        ? `直近の商談で${label}の従来条件が撤回され、現在は未定です。`
        : `${label}は後の商談で更新されています: ${evidence.value}`;
    }).join("\n");
    if (result.summary !== summary) result = { ...result, summary };
  }
  return result;
}
