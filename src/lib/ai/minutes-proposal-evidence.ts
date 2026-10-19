import { findBantWithdrawal } from "./bant-withdrawal";

export interface MinutesProposalCandidate {
  text: string;
  source_quote: string;
  speech_act: "offered_option" | "factual_question" | "existing_state" | "permission_request" | "negated_proposal" | "other";
}

type RejectionReason = "invalid_candidates" | "invalid_candidate" | "legacy_string_without_source"
  | "not_offered_option" | "source_not_literal_eligible_sentences" | "factual_question"
  | "existing_state" | "permission_request" | "negated_proposal" | "historical_or_reported"
  | "omitted_adjacent_qualifier" | "superseded_budget_condition" | "no_explicit_option" | "limit_exceeded" | "source_quote_budget_exceeded";

export interface MinutesProposalAudit {
  /** The provider's candidates are retained unchanged, including rejected rows. */
  candidates: unknown;
  accepted: Array<{ index: number; source_quote: string; source_role: "seller" | "unspecified"; public_text: string }>;
  rejected: Array<{ index: number | null; reason: RejectionReason; later_source_quote?: string }>;
}

type SourceTurn = { body: string; role: "seller" | "unspecified"; lineIndex: number; speaker?: string };
// A second labelled segment is ambiguous even when it uses a personal name.
const extraSpeaker = /(?:^|[。！？!?\s])[^:：。！？!?\s]{1,24}\s*[:：]/u;

function sentences(text: string): Array<{ text: string; start: number; end: number }> {
  return [...text.matchAll(/[^。！？!?]+[。！？!?]?/gu)].flatMap((match) => {
    const value = match[0].trim();
    if (!value) return [];
    const start = match.index! + match[0].indexOf(value);
    return [{ text: value, start, end: start + value.length }];
  });
}

function quoteSource(quote: string, turns: SourceTurn[]): { turn: SourceTurn; adjacent: string[] } | undefined {
  // If an option was explicitly repeated, assess its latest literal occurrence.
  for (const turn of turns.toReversed()) {
    const parts = sentences(turn.body);
    for (const [index, part] of parts.entries()) {
      if (!turn.body.startsWith(quote, part.start)) continue;
      const last = parts.findIndex((end) => end.end === part.start + quote.length);
      if (last < index) continue;
      return { turn, adjacent: [parts[index - 1]?.text, parts[last + 1]?.text].filter((text): text is string => !!text) };
    }
  }
  return undefined;
}

const moneySource = String.raw`\d+(?:\.\d+)?(?:億|万|千)?円`;
const budgetTopic = "(?:予算|制作費|導入費用)";

function yen(amount: string): number {
  const unit = amount.match(/億|万|千/u)?.[0];
  return Number.parseFloat(amount) * (unit === "億" ? 100_000_000 : unit === "万" ? 10_000 : unit === "千" ? 1_000 : 1);
}

/** Only amounts explicitly used as a budget/目安 condition, not product prices. */
function budgetConditionAmounts(quote: string): Set<number> {
  const amounts = new Set<number>();
  for (const { text } of sentences(quote.normalize("NFKC").replace(/,/gu, ""))) {
    for (const match of text.matchAll(new RegExp(moneySource, "gu"))) {
      const before = text.slice(0, match.index).trim();
      const after = text.slice(match.index! + match[0].length).trim();
      const beforeBudget = new RegExp(`${budgetTopic}(?:の?(?:目安|金額|額))?(?:は|を|が|も|の|として)?$`, "u");
      const afterBudget = /^(?:(?:を|は|が)(?:仮の)?|(?:という|の))?(?:予算|制作費|導入費用|目安)(?:として|に|は|で|を|が|の|$)/u;
      if (beforeBudget.test(before) || afterBudget.test(after)) amounts.add(yen(match[0]));
    }
  }
  return amounts;
}

/** An explicit correction must target the same amount, rather than merely
 * mentioning a later price. This narrow grammar does not infer a replacement.
 */
function correctsAmount(sentence: string, amounts: Set<number>): boolean {
  const statement = sentence.normalize("NFKC").replace(/,/gu, "").trim().replace(/[。]$/u, "");
  const target = new RegExp(`^(?:(?:なお|ただし|すみません|申し訳ありません)[、]\\s*)?`
    + `(?:(?:先ほど|先程|当初|以前|前回|従来|これまで)の|先に(?:お伝え|提示)した)?`
    + `(?:${budgetTopic}(?:の?(?:目安|金額|額))?(?:は|の)?\\s*)?`
    + `(${moneySource})(?:(?:という|の)(?:仮の)?(?:予算|目安|金額|額))?(?:は|を|から)(.+)$`, "u");
  const match = statement.match(target);
  if (!match || !amounts.has(yen(match[1]))) return false;
  const predicate = match[2];
  return new RegExp(`^(?:${moneySource}に)?(?:訂正|修正|変更)(?:します|しました|する|した)$`, "u").test(predicate)
    || /^(?:撤回(?:します|しました|する|した)|取り下げ(?:ます|ました|る|た)|取り消(?:します|しました|す)|白紙に戻(?:します|しました|す))$/u.test(predicate)
    || /^(?:誤り|間違い)(?:です|でした)$/u.test(predicate)
    || /^訂正前の(?:数字|金額|額|目安|予算)として扱ってください$/u.test(predicate);
}

function laterBudgetCorrection(lines: string[], source: SourceTurn, quote: string): string | undefined {
  const amounts = budgetConditionAmounts(quote);
  if (!amounts.size) return undefined;
  const later = lines.slice(source.lineIndex + 1);
  // Reuse the established customer-only withdrawal→unknown guard. It already
  // excludes hypothetical/reported amounts and later explicit replacements.
  const withdrawal = findBantWithdrawal(later.join("\n"), "budget");
  if (withdrawal) return withdrawal.quote;
  for (const line of later) {
    const customer = line.match(/^\s*(?:顧客|先方|お客様)\s*[:：]\s*(.+)$/u);
    if (!customer || extraSpeaker.test(customer[1])) continue;
    if (sentences(customer[1]).some(({ text }) => correctsAmount(text, amounts))) return line;
  }
  return undefined;
}

/** A direct current seller statement at the start of the quoted passage.
 * Anchored affirmative endings keep questions, reported speech and hypothetical
 * descriptions from becoming offers. Subsequent scope/price conditions remain
 * in the unchanged literal passage, rather than being inferred from acceptance.
 */
function currentSellerOption(quote: string): { priceYen: number | null } | undefined {
  const first = sentences(quote)[0]?.text.normalize("NFKC").replace(/(?<=\d),(?=\d)/gu, "") ?? "";
  const item = String.raw`[^。！？!?「」『』"“”‘’、,]{1,80}`;
  const pricedOffer = new RegExp(`^(?:当社|弊社)は(?:税込|税抜)?(${moneySource})で${item}を提供(?:できます|します|いたします)[。！!]?$`, "u");
  const introducedOption = new RegExp(`^(?:(?:別|他)の|もう一つの)?(?:選択肢|方法|案|オプション)として${item}(?:を|も)(?:ご)?紹介(?:します|いたします)[。！!]?$`, "u");
  const price = first.match(pricedOffer);
  return price ? { priceYen: yen(price[1]) } : introducedOption.test(first) ? { priceYen: null } : undefined;
}

/** Only an explicit withdrawal of this option or refusal at its same price.
 * An excluded extra service (含まれません) is still valid scope information.
 */
function currentSellerOptionWithdrawn(quote: string, option: { priceYen: number | null }): boolean {
  return sentences(quote).slice(1).some(({ text }) => {
    const statement = text.normalize("NFKC").replace(/(?<=\d),(?=\d)/gu, "")
      .replace(/^(?:ただし|なお)[、]\s*/u, "").replace(/[。!！]$/u, "");
    if (/^(?:この|その)(?:案|選択肢|提案|提供)(?:は|を)(?:撤回(?:します|しました)|取り下げ(?:ます|ました)|見送り(?:ます|ました))$/u.test(statement)) return true;
    const deniedPrice = statement.match(new RegExp(`^(${moneySource})では提供(?:できません|しません|いたしません)$`, "u"));
    return !!deniedPrice && option.priceYen !== null && yen(deniedPrice[1]) === option.priceYen;
  });
}

/** Narrow surface exclusions and a positive option cue, not Japanese entailment.
 * The model's speech-act label alone cannot turn a factual question into an offer.
 */
function sourceRejection(quote: string, role: SourceTurn["role"]): RejectionReason | null {
  const permission = /(?:提案|紹介|説明)(?:させていただいて|して|をして)も(?:よろしい|いい|良い)(?:ですか|でしょうか)|(?:提案|紹介|説明)(?:して|させていただいて)(?:よろしい|いい|良い)(?:ですか|でしょうか)/u;
  const negatedProposal = /(?:提案|お勧め|おすすめ)(?:は|を)?(?:しない|しません(?!か)|いたしません(?!か)|していない|していません)|(?:提案|お勧め|おすすめ)(?:する)?(?:方針|予定)(?:では|は)(?:ない|ありません)|(?:提案|お勧め|おすすめ)[^。！？!?]{0,20}(?:(?:という)?(?:意味|こと)(?:では|じゃ)(?:ない|ありません)|見送|撤回|取り下げ)/u;
  const factualQuestion = /(?:して|されて)(?:います|いる)(?:か|でしょうか)|(?:どこ|誰|どなた|いつ|何人|どのくらい|どのように)[^。！？!?]{0,60}(?:ですか|でしょうか|ありますか)|(?:決まって|分かって|わかって)(?:います|いる)(?:か|でしょうか)|(?:方法|選択肢|考え方|案)(?:も|が|は)?(?:ある|あります)(?:か|でしょうか)|(?:おすすめ|お勧め)(?:ですか|でしょうか)/u;
  const existingState = /(?:共有|利用|使用|運用|導入|実施|掲載|管理)(?:されて|して)(?:います|いる)(?:[。！？!?]|$)/u;
  const historicalOrReported = /(?:提案|お勧め|おすすめ)(?:しました|いたしました|した(?!い)|していました)|と(?:いう(?:感想|話|意見|説明)を)?(?:伺|聞)|と(?:言|話)(?:って|して)(?:いました|いた)/u;
  const option = /(?:提案|お勧め|おすすめ)(?:し|いたし|です)|(?:方法|選択肢|考え方|案)(?:も|が|は)?(?:あります(?!か)|ある|考えられ)|(?:方法|選択肢|考え方|案)[^。！？!?]{0,70}(?:検討|考えたい|考えられ|よさそう)|(?:と|のが|ると|れば)よさそう|(?:ては|のは|するのは)いかが(?:です|でしょう)か|(?:し|してみ|使ってみ|試してみ|使い|試し)ませんか|(?:し|しま|考え|検討し|使い)ましょう/u;
  for (const sentence of sentences(quote).map((part) => part.text)) {
    if (permission.test(sentence)) return "permission_request";
    if (negatedProposal.test(sentence)) return "negated_proposal";
    if (factualQuestion.test(sentence)) return "factual_question";
    if (existingState.test(sentence)) return "existing_state";
    if (historicalOrReported.test(sentence)) return "historical_or_reported";
  }
  const sellerOption = role === "seller" ? currentSellerOption(quote) : undefined;
  if (sellerOption && currentSellerOptionWithdrawn(quote, sellerOption)) return "negated_proposal";
  return option.test(quote) || sellerOption ? null : "no_explicit_option";
}

/** Project only bounded, literal options. Public text uses the verified
 * quote rather than claiming that a generated paraphrase has equivalent meaning.
 * Conditions and uncertainty within that quote therefore survive unchanged.
 */
export function groundMinutesProposals(transcript: string, candidates: unknown): { proposals: string[]; audit: MinutesProposalAudit } {
  const audit: MinutesProposalAudit = { candidates, accepted: [], rejected: [] };
  if (!Array.isArray(candidates)) {
    audit.rejected.push({ index: null, reason: "invalid_candidates" });
    return { proposals: [], audit };
  }
  const lines = transcript.split(/\r?\n/u);
  const turns: SourceTurn[] = lines.flatMap((line, lineIndex) => {
    const labelled = line.match(/^\s*([^:：。！？!?]{1,40})\s*[:：]\s*(.+)$/u);
    const speaker = labelled?.[1].trim();
    if (speaker && /^(?:顧客|先方|お客様)(?:$|[（(\s])/u.test(speaker)) return [];
    const body = labelled?.[2] ?? line.trim();
    if (!body || extraSpeaker.test(body)) return [];
    const role = speaker && /^(?:営業(?:担当者?)?|当社|弊社|売り手)(?:$|[（(\s])/u.test(speaker) ? "seller" : "unspecified";
    return [{ body, role, lineIndex, speaker }];
  });
  let acceptedQuoteCharacters = 0;
  candidates.forEach((candidate, index) => {
    const reject = (reason: RejectionReason) => audit.rejected.push({ index, reason });
    if (index >= 6) { reject("limit_exceeded"); return; }
    if (typeof candidate === "string") { reject("legacy_string_without_source"); return; }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { reject("invalid_candidate"); return; }
    const row = candidate as Record<string, unknown>;
    if (typeof row.text !== "string" || !row.text.trim() || typeof row.source_quote !== "string"
      || !row.source_quote.trim() || row.source_quote.length > 700) { reject("invalid_candidate"); return; }
    if (row.speech_act !== "offered_option") { reject("not_offered_option"); return; }
    let quote = row.source_quote.trim();
    let source = quoteSource(quote, turns);
    if (!source) {
      // The prompt asks for the quote without the speaker label, but a model may still prefix its own label.
      // Drop it only when the rest is literally in a turn of that same speaker.
      const match = quote.match(/^([^:：。！？!?]{1,40})[:：][ \t\u3000]*(\S[\s\S]*)$/u);
      // A number-only "label" or a clock time ("14:00からの…") is part of the sentence, not a speaker.
      const labelled = match && !/^[\d０-９\s]+$/u.test(match[1]) && !(/[\d０-９]$/u.test(match[1]) && /^[\d０-９]/u.test(match[2])) ? match : null;
      const unlabelled = labelled ? quoteSource(labelled[2].trim(), turns) : undefined;
      if (labelled && unlabelled && unlabelled.turn.speaker === labelled[1].trim()) {
        quote = labelled[2].trim();
        source = unlabelled;
      }
    }
    if (!source) { reject("source_not_literal_eligible_sentences"); return; }
    const adjacentQualifier = /(?:場合|とき|際)に限|条件(?:です|とします)|ただし|但し|これは(?:営業側の)?仮説|(?:その)?(?:提案|案)[^。！？!?]{0,20}(?:取り下げ|撤回|見送)/u;
    if (source.adjacent.some((sentence) => adjacentQualifier.test(sentence))) { reject("omitted_adjacent_qualifier"); return; }
    const rejection = sourceRejection(quote, source.turn.role);
    if (rejection) { reject(rejection); return; }
    const correction = laterBudgetCorrection(lines, source.turn, quote);
    if (correction) {
      audit.rejected.push({ index, reason: "superseded_budget_condition", later_source_quote: correction });
      return;
    }
    if (acceptedQuoteCharacters + quote.length > 1000) { reject("source_quote_budget_exceeded"); return; }
    const label = source.turn.role === "seller" ? "営業側の検討案" : "商談中の検討案";
    audit.accepted.push({ index, source_quote: quote, source_role: source.turn.role, public_text: `${label}：${quote}` });
    acceptedQuoteCharacters += quote.length;
  });
  return { proposals: [...new Set(audit.accepted.map((record) => record.public_text))], audit };
}
