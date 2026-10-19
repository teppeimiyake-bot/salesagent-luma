import { readSourceEvidenceBlocks, type SourceEvidenceBlock } from "./issue-evidence";

export interface MinutesAction {
  action: string;
  owner: string;
  due: string;
}

export interface MinutesActionCandidate extends MinutesAction {
  source_quote: string;
}

type RejectionReason = "invalid_candidates" | "invalid_candidate" | "missing_source_quote"
  | "source_not_literal_complete_sentences" | "ambiguous_speakers" | "ambiguous_source_owner"
  | "question" | "negated_action" | "no_explicit_self_intention" | "omitted_adjacent_qualifier"
  | "candidate_limit_exceeded" | "source_quote_budget_exceeded" | "duplicate_source_quote";

export interface MinutesActionAudit {
  /** Retain the provider's draft unchanged; it is never the public action. */
  candidates: unknown;
  accepted: Array<{
    index: number;
    sourceIds: number[];
    source_quote: string;
    source_speaker?: string;
    confirmation_source_ids?: number[];
    confirmation_source_quote?: string;
    public_action: MinutesAction;
  }>;
  rejected: Array<{ index: number | null; reason: RejectionReason }>;
}

function sentences(text: string): Array<{ text: string; start: number; end: number }> {
  return [...text.matchAll(/[^。！？!?]+[。！？!?]?/gu)].flatMap(match => {
    const value = match[0].trim();
    if (!value) return [];
    const start = match.index! + match[0].indexOf(value);
    return [{ text: value, start, end: start + value.length }];
  });
}

function passageBody(block: SourceEvidenceBlock): string {
  // Unlike the analysis body, sourceText preserves original CRLF and spacing.
  return block.speaker
    ? block.sourceText.replace(/^\s*[^:：。！？!?]{1,40}\s*[:：][ \t\u3000]*/u, "")
    : block.sourceText;
}

function sourceMatch(quote: string, block: SourceEvidenceBlock): { block: SourceEvidenceBlock; adjacent: string[]; final: boolean } | undefined {
  const body = passageBody(block);
  const parts = sentences(body);
  for (const [index, part] of parts.entries()) {
    if (!body.startsWith(quote, part.start)) continue;
    const last = parts.findIndex(end => end.end === part.start + quote.length);
    if (last < index) continue;
    return { block, adjacent: [parts[index - 1]?.text, parts[last + 1]?.text].filter((part): part is string => !!part),
      final: last === parts.length - 1 };
  }
  return undefined;
}

/** A transcript written one utterance per labelled line (the timed transcription does this) splits one speaker's
 * turn into blocks. The first sentence of the same speaker's directly following line is adjacent context, exactly
 * as if the lines were one turn: a caveat or withdrawal (ただし…, …ればの話です, 撤回します) qualifies what was said
 * just before it. A preceding line is not added — its caveat qualifies that earlier statement, not the next promise.
 * Blank lines, another speaker and mixed-speaker lines delimit the turn, as for the Timeline context. */
function followingSameSpeakerSentence(transcript: string, blocks: SourceEvidenceBlock[]) {
  const spans = new Map<SourceEvidenceBlock, { start: number; end: number }>();
  let cursor = 0;
  for (const block of blocks) {
    const start = transcript.indexOf(block.sourceText, cursor);
    spans.set(block, { start, end: start + block.sourceText.length });
    cursor = start + block.sourceText.length;
  }
  return (block: SourceEvidenceBlock): string | undefined => {
    const next = blocks[blocks.indexOf(block) + 1];
    if (!next || next.speaker !== block.speaker || next.ambiguousSpeakers) return undefined;
    if (!/^\r?\n$/u.test(transcript.slice(spans.get(block)!.end, spans.get(next)!.start))) return undefined;
    return sentences(passageBody(next))[0]?.text;
  };
}

/** The prompt asks for the quote without the speaker label, but a model may still prefix its own
 * label (gemini-3.5-flash-lite returned "営業：では、…送付します。"). Only that leading label is split off. */
function leadingLabel(quote: string): { speaker: string; body: string } | null {
  const match = quote.match(/^([^:：。！？!?]{1,40})[:：][ \t\u3000]*(\S[\s\S]*)$/u);
  // A number-only "label" or a clock time ("明日10:00までに…") is part of the sentence, not a speaker.
  if (!match || /^[\d０-９\s]+$/u.test(match[1]) || (/[\d０-９]$/u.test(match[1]) && /^[\d０-９]/u.test(match[2]))) return null;
  return { speaker: match[1].trim(), body: match[2].trim() };
}

/** An action inside reported speech is not a commitment by this turn's speaker. */
function withoutQuotedContent(text: string): string {
  const closers = new Map([["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]);
  const stack: string[] = [];
  return [...text].map(character => {
    if (stack.length && character === stack[stack.length - 1]) { stack.pop(); return " "; }
    const closer = closers.get(character);
    if (closer) { stack.push(closer); return " "; }
    return stack.length ? " " : character;
  }).join("");
}

// Humble sales verbs (お送りします・ご用意します…) take the same します endings as the kango verbs and are treated
// exactly like 送付・提出・連絡・確認 in every check below (intention, adjacent qualifiers, withdrawal), nothing more.
const intention = /(?:確認|連絡|共有|送付|提出|準備|整理|調整|相談|検討|作成|案内|手配|調査|集計|説明|回答|お送り|お持ち|お届け|お渡し|お伝え|お知らせ|用意|提示|報告|持参)(?:します|いたします|しておきます|する予定です|するつもりです|(?:し|してみ)たい(?:と思います|です))|(?:お話し|話)(?:します|す予定です|すつもりです|してみたいと思います)/u;
const firstPerson = /(?:私(?:たち)?|わたし|こちら|当社|弊社|我々|当方)(?:は|が|も|で|から)/u;
// The name is explicitly apposed to "私", not inferred from a が subject or
// an earlier introduction under a generic speaker label.
const selfApposition = /^(?:私|わたし)[、,]\s*[\p{Script=Han}\p{Script=Katakana}A-Za-zー・]{1,20}(?:は|が|も)/u;
const actionWords = /確認|連絡|共有|送付|提出|準備|整理|調整|相談|検討|作成|案内|手配|調査|集計|説明|回答|お送り|お持ち|お届け|お渡し|お伝え|お知らせ|用意|提示|報告|持参|お話し|話/gu;
const condition = /(?:場合|とき|際)(?:に限|のみ|だけ)|(?:れば|たら|なら)(?:の話|に限|だけ)|条件(?:です|とします)/u;

function committingClause(sentence: string): string | undefined {
  const unquoted = withoutQuotedContent(sentence);
  const match = unquoted.match(intention);
  if (!match || unquoted.slice(match.index! + match[0].length).replace(/[。！!\s]/gu, "")) return undefined;
  // Conditional opportunities and requests do not become assigned plans. A
  // direct "社内でも話してみたいと思います" still retains that exact intention.
  if (/できれば|できると|(?:機会|機会も)[^。]{0,30}(?:検討でき|設けられ)|(?:して|いただけ)(?:れば|ると)(?:幸い|ありがたい)/u.test(unquoted)) return undefined;
  const before = unquoted.slice(0, match.index);
  const self = before.match(selfApposition);
  // Keep ordinary punctuation after the explicit self subject: it can separate
  // the deadline, object and recipient within the same promised action. Earlier
  // reported/conditional clauses still end at the same semantic boundaries.
  const lastClause = before.split(/(?:たら|なら|れば|場合(?:は|には)|ので|から|(?:です|ます|ました|でした)が)/u).at(-1) ?? before;
  const mainClause = self ? lastClause : lastClause.split(/[、,]/u).at(-1) ?? lastClause;
  // A conjunction (では・それでは) at the sentence start or right after a comma is not a topic marker:
  // transcription can drop its comma (「では11月20日までに見積書を送付します。」, 2026-09-29). A では left at
  // the start by the clause split above (御社ならでは・来週からでは) and negations (ではなく) are still checked,
  // as is the rest of the clause.
  const conjunctionSlot = /(?:^|[、,])\s*$/u.test(before.slice(0, before.length - mainClause.length));
  const selfless = self && mainClause.startsWith(self[0]) ? mainClause.slice(self[0].length) : mainClause;
  const subject = conjunctionSlot ? selfless.replace(/^\s*(?:それ)?では(?![な無](?:い|く|かっ|けれ))/u, "") : selfless;
  // Do not assign another person's stated action to the source speaker. This
  // bounded check deliberately declines ambiguous topic/subject constructions.
  if (/(?:は|が)/u.test(subject) && !firstPerson.test(subject)) return undefined;
  return mainClause + unquoted.slice(match.index);
}

function quoteRejection(quote: string): RejectionReason | null {
  const unquoted = withoutQuotedContent(quote);
  if (/[?？]/u.test(unquoted) || sentences(unquoted).some(({ text }) => /(?:です|ます|ません|でしょう|よろしい)か[。！!]?\s*$/u.test(text))) return "question";
  if (/(?:し|いたし|でき)ません|しない|(?:予定|つもり|対応|連絡|提出|送付|確認|お送り|お持ち|お届け|お渡し|お伝え|お知らせ|用意|提示|報告|持参)[^。！？!?]{0,20}(?:撤回|取り下げ|取り消|見送|未定|未確定)|(?:という)?(?:意味|こと)(?:では|じゃ)(?:ない|ありません)/u.test(unquoted)) return "negated_action";
  return sentences(quote).some(({ text }) => committingClause(text)) ? null : "no_explicit_self_intention";
}

function omittedQualifier(quote: string, adjacent: string[]): boolean {
  const actions = [...new Set(quote.match(actionWords) ?? [])];
  return adjacent.some(part => {
    if (/ただし|但し|(?:その)?(?:予定|対応|計画)[^。！？!?]{0,20}(?:取り下げ|撤回|見送)/u.test(part) || condition.test(part)) return true;
    return /しません|いたしません|しない|(?:予定|つもり)(?:は|が)?(?:ない|ありません)|撤回|取り下げ|取り消/u.test(part)
      && actions.some(action => part.includes(action));
  });
}

// Absolute dates and relative deadlines as spoken. Relative ones (来週の金曜日・明日中・今週中) are kept in
// their original wording and never converted to calendar dates (UI確認 2026-10-01 edge-02).
const temporal = /^(?:(?:[0-9０-９]{4}年)?[0-9０-９]{1,2}月[0-9０-９]{1,2}日|[0-9０-９]{4}[-/][0-9０-９]{1,2}[-/][0-9０-９]{1,2}|(?:本日|今日|明日|明後日)中?|(?:今|来|再来)週(?:の?(?:[月火水木金土日]曜日?|末|中))?|(?:今|来|再来)月(?:の?(?:末|中))?|[0-9０-９]+(?:時間|日|週間))$/u;
const dateAndClock = /^(?:(?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日|[0-9]{4}[-/][0-9]{1,2}[-/][0-9]{1,2}|本日|今日|明日|明後日)[ \t]*(?:(?:[01]?[0-9]|2[0-3])時(?:[0-5]?[0-9]分)?|(?:[01]?[0-9]|2[0-3]):[0-5][0-9])$/u;
const dueSuffix = /(?:までに|まで|以内に|以内|中に|に)$/u;

function isDeadlineExpression(bare: string): boolean {
  return temporal.test(bare) || dateAndClock.test(bare.normalize("NFKC"));
}

/** The deadline literally precedes the action: 「Xまでに」「X以内に」「X中に」, or 「明日中に」 for a bare ending in 中. */
function startsWithDeadline(text: string, bare: string): boolean {
  return text.startsWith(`${bare}までに`) || text.startsWith(`${bare}以内に`) || text.startsWith(`${bare}中に`)
    || (bare.endsWith("中") && text.startsWith(`${bare}に`));
}

/** The whole text is one deadline phrase such as 「来週の金曜日までに」「明日中に」. */
function isDeadlinePhrase(text: string): boolean {
  const bare = /^(.+?)(?:までに|以内に|中に)$/u.exec(text)?.[1];
  if (bare && isDeadlineExpression(bare)) return true;
  const withinDay = /^(.+中)に$/u.exec(text)?.[1];
  return !!withinDay && isDeadlineExpression(withinDay);
}

/** Committing clauses of the quote that may carry a deadline. A clause starting a sentence with only a deadline
 * and a comma (「では来週の金曜日までに、構成案と見積もり書をお送りします。」) belongs to the same action. */
function deadlineClauses(quote: string): string[] {
  const clauses: string[] = [];
  for (const { text } of sentences(quote)) {
    const plain = committingClause(text);
    if (!plain || /候補|未合意|未確定|未定|仮置き|もし|なら|場合|たら|れば/u.test(text)) continue;
    clauses.push(plain);
    const unquoted = withoutQuotedContent(text);
    const head = unquoted.slice(0, unquoted.length - plain.length);
    if (!/[、,]\s*$/u.test(head)) continue;
    const lead = (head.replace(/[、,]\s*$/u, "").split(/[、,]/u).at(-1) ?? "").trim().replace(/^(?:それ)?では\s*/u, "");
    if (isDeadlinePhrase(lead)) {
      clauses.push(`${lead}${plain}`);
    }
  }
  return clauses;
}

/** Only a literally stated deadline on a committing sentence may fill due.
 * Candidate meeting dates, hypothetical timing and generated dates stay unknown.
 * When the draft left due unknown, the deadline literally stated before the committed action is used as spoken.
 */
function literalDue(quote: string, draftDue: unknown, readFromQuote = true): string {
  // A separate adjoining conditional sentence still qualifies the whole action.
  if (condition.test(quote)) return "未確認";
  const clauses = deadlineClauses(quote);
  const draft = typeof draftDue === "string" ? draftDue.trim() : "";
  if (draft && draft !== "未確認") {
    if (draft.length > 60) return "未確認";
    const bare = draft.replace(dueSuffix, "");
    if (!isDeadlineExpression(bare)) return "未確認";
    for (const plain of clauses) {
      const index = plain.indexOf(draft);
      if (index >= 0 && startsWithDeadline(plain.slice(index), bare)) return draft;
    }
    return "未確認";
  }
  if (!readFromQuote) return "未確認";
  // No usable draft: take the longest deadline expression immediately before 「までに・以内に・中に」 in the clause.
  for (const plain of clauses) {
    for (const marker of plain.matchAll(/までに|以内に|中に|(?<=中)に/gu)) {
      for (let start = Math.max(0, marker.index! - 30); start < marker.index!; start++) {
        const bare = plain.slice(start, marker.index!);
        if (isDeadlineExpression(bare) && startsWithDeadline(plain.slice(start), bare)) return plain.slice(start, marker.index! + marker[0].length);
      }
    }
  }
  return "未確認";
}

/** A following customer can explicitly accept a requested submission deadline.
 * Only this two-sentence shape is projected to the original action sentence;
 * questions alone and unanswered/qualified requests still are not commitments.
 */
function acceptedSubmissionConfirmation(quote: string, draftDue: unknown, source: SourceEvidenceBlock, blocks: SourceEvidenceBlock[]): { action: string; confirmation: SourceEvidenceBlock } | undefined {
  const parts = sentences(quote);
  if (parts.length !== 2 || !/^この(?:提出)?期限でよろしいでしょうか[。?？]$/u.test(parts[1].text)
    || source.sourceRole !== "seller" || !source.body.trimEnd().endsWith(quote)) return undefined;
  const action = parts[0].text;
  const actor = withoutQuotedContent(action);
  if (quoteRejection(action) || (!selfApposition.test(actor) && actor.match(firstPerson)?.index !== 0)) return undefined;
  // The customer's acceptance must match the deadline the draft named; it is never read from the quote here.
  const due = literalDue(action, draftDue, false);
  if (due === "未確認") return undefined;
  const bare = due.replace(/(?:までに|まで|以内に|以内|中に|に)$/u, "");
  const clause = committingClause(action)!;
  const dateEnd = clause.indexOf(`${bare}までに`);
  if (dateEnd < 0) return undefined;
  const delivery = clause.slice(dateEnd + bare.length + "までに".length).replace(/^[、,\s]+/u, "");
  // Match the literal object before an optional recipient and delivery channel.
  // A shared date alone cannot ground acceptance of a different document/action.
  const object = delivery.match(/^(.{1,160})を[、,]?(?:[^、,。！？!?]{1,40}(?:へ|に))?(?:メールで)?(?:送付|提出)(?:します|いたします)[。！!]?$/u)?.[1];
  if (!object) return undefined;
  const confirmation = blocks[blocks.indexOf(source) + 1];
  if (!confirmation || confirmation.sourceRole !== "customer" || confirmation.ambiguousSpeakers) return undefined;
  const response = withoutQuotedContent(confirmation.body);
  if (condition.test(response) || /[?？]|ただし|但し|もし|場合|たら|なら|れば|未合意|未確定|未定|(?:し|いたし)ません|していません|拒否|撤回|取り消|取り下げ/u.test(response)
    || sentences(response).some(({ text }) => quoteRejection(text) === "question")) return undefined;
  const accepted = sentences(response).some(({ text }) => {
    const match = text.match(/^(.{1,120})を(.{1,60})までに(?:メールで)?(?:送って|送付して|提出して)いただくこと(?:で|に)合意します[。！!]?$/u);
    if (!match || match[2] !== bare) return false;
    const acceptedObject = match[1];
    return object === acceptedObject || object.endsWith(`した${acceptedObject}`) || object.endsWith(`する${acceptedObject}`);
  });
  return accepted ? { action, confirmation } : undefined;
}

/** Literal projection for minutes, not a generator of recommended next steps. */
export function groundMinutesActions(transcript: string, candidates: unknown): { next_actions: MinutesAction[]; audit: MinutesActionAudit } {
  const audit: MinutesActionAudit = { candidates, accepted: [], rejected: [] };
  if (!Array.isArray(candidates)) {
    audit.rejected.push({ index: null, reason: "invalid_candidates" });
    return { next_actions: [], audit };
  }
  const blocks = [...new Set(readSourceEvidenceBlocks(transcript).values())];
  const followingSentence = followingSameSpeakerSentence(transcript, blocks);
  const seen = new Set<string>();
  let quoteCharacters = 0;
  candidates.forEach((candidate, index) => {
    const reject = (reason: RejectionReason) => { audit.rejected.push({ index, reason }); };
    if (index >= 6) { reject("candidate_limit_exceeded"); return; }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { reject("invalid_candidate"); return; }
    const row = candidate as Record<string, unknown>;
    if (typeof row.source_quote !== "string" || !row.source_quote.trim()) { reject("missing_source_quote"); return; }
    if (typeof row.action !== "string" || !row.action.trim()) { reject("invalid_candidate"); return; }
    let quote = row.source_quote.trim();
    let matches = blocks.map(block => sourceMatch(quote, block)).filter((match): match is NonNullable<typeof match> => !!match);
    if (!matches.length) {
      // Drop a leading label only when every literal occurrence of the rest is in a turn of that same speaker.
      const labelled = leadingLabel(quote);
      const unlabelled = labelled ? blocks.map(block => sourceMatch(labelled.body, block)).filter((match): match is NonNullable<typeof match> => !!match) : [];
      if (labelled && unlabelled.length && unlabelled.every(({ block }) => block.speaker === labelled.speaker)) {
        quote = labelled.body;
        matches = unlabelled;
      }
    }
    if (!matches.length) { reject("source_not_literal_complete_sentences"); return; }
    if (matches.some(({ block }) => block.ambiguousSpeakers)) { reject("ambiguous_speakers"); return; }
    if (new Set(matches.map(({ block }) => block.speaker)).size > 1) { reject("ambiguous_source_owner"); return; }
    const source = matches.at(-1)!;
    const following = source.final ? followingSentence(source.block) : undefined;
    const adjacent = following ? [...source.adjacent, following] : source.adjacent;
    if (omittedQualifier(quote, adjacent)) { reject("omitted_adjacent_qualifier"); return; }
    const rejection = quoteRejection(quote);
    const confirmed = rejection === "question" ? acceptedSubmissionConfirmation(quote, row.due, source.block, blocks) : undefined;
    if (rejection && !confirmed) { reject(rejection); return; }
    const publicQuote = confirmed?.action ?? quote;
    if (seen.has(publicQuote)) { reject("duplicate_source_quote"); return; }
    if (quoteCharacters + quote.length > 1200) { reject("source_quote_budget_exceeded"); return; }
    const publicAction = { action: publicQuote, owner: source.block.speaker || "未確認", due: literalDue(publicQuote, row.due) };
    audit.accepted.push({ index, sourceIds: [...source.block.sourceIds], source_quote: quote, source_speaker: source.block.speaker,
      ...(confirmed ? { confirmation_source_ids: [...confirmed.confirmation.sourceIds], confirmation_source_quote: confirmed.confirmation.sourceText } : {}), public_action: publicAction });
    seen.add(publicQuote);
    quoteCharacters += quote.length;
  });
  return { next_actions: audit.accepted.map(({ public_action }) => public_action), audit };
}
