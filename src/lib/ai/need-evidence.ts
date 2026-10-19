import { BANT_UNKNOWN_VALUES } from "./bant-definitions";
import { isUnknownBantValue, normalizeUnconfirmedNeed } from "./bant-reconciliation";
import { groundIssueEvidence, type IssueEvidenceAudit } from "./issue-evidence";

const MAX_SOURCE_CHARACTERS = 1200;

export interface NeedEvidence {
  value: string;
  basis: "literal_source" | "unknown_source" | "no_valid_source";
  audit: IssueEvidenceAudit;
}

/** Classify before adding an attribution wrapper. Numbers in a Need sentence
 * do not make its explicitly unknown predicate known. This only recognizes
 * bounded unknown/stage forms; it is not a general customer-need classifier.
 */
function unknownNeedSource(sourceText: string): boolean {
  const body = sourceText.replace(/^\s*[^:：。！？!?]{1,40}\s*[:：]\s*/u, "");
  const sentences = (body.match(/[^。！？!?\r\n]+[。！？!?]?/gu) ?? []).map(part => part.trim()).filter(Boolean);
  const isUnknown = (sentence: string): boolean => {
    const stage = sentence.replace(/^(?:今回|本日|今日)(?:は|の目的は)/u, "");
    return normalizeUnconfirmedNeed(stage) !== stage ||
      isUnknownBantValue(sentence.replace(/[\d０-９]+/gu, ""));
  };
  if (!sentences.some(isUnknown)) return false;
  // An unrelated budget/date statement must not supply a concrete Need, while
  // an actual problem/desire must survive unknown budget or timing context.
  const explicitProblem = /(?:課題|問題)(?:です|である|になって(?!いません|いない)|となって(?!いません|いない)|(?:は|が)(?!(?:特に|引き続き|現在も|まだ)?(?:ありません|ない|なく)))|困って(?!いません|いない)|不足して(?!いません|いない|おりません|おらず)|足りない|足りません|少ない|少なく(?!ありません|ない)|にくい|づらい/u;
  const desire = /たい(?:です|と思ってい(?:ます|る)|と考えてい(?:ます|る))?[。！!]?$/u;
  // Match the wish's predicate, not nouns anywhere in the sentence: reducing
  // operating costs or implementation time is still a business need.
  const conditionDesire = /(?:目安にし|導入し|稼働し|開始し|公開し|面談し|打ち合わせし)たい(?:です|と思ってい(?:ます|る)|と考えてい(?:ます|る))?[。！!]?$/u;
  return !sentences.some(sentence => !isUnknown(sentence) &&
    (explicitProblem.test(sentence) || (desire.test(sentence) && !conditionDesire.test(sentence))));
}

/** Select one primary complete source passage. A single contiguous quote uses
 * the existing BANT quotation contract and keeps even late qualifications.
 * No generated Need paraphrase is accepted as a fallback or a status signal.
 */
export function groundNeedEvidence(transcript: string, requestedSourceIds: unknown): NeedEvidence {
  const grounded = groundIssueEvidence(transcript, requestedSourceIds);
  const audit: IssueEvidenceAudit = { requestedSourceIds, accepted: [], rejected: [...grounded.audit.rejected] };
  const requested = Array.isArray(requestedSourceIds) ? requestedSourceIds : [];
  const candidates = [...grounded.audit.accepted].sort((left, right) => requested.indexOf(left.sourceId) - requested.indexOf(right.sourceId));
  for (const entry of candidates) {
    if (audit.accepted.length) {
      audit.rejected.push({ sourceId: entry.sourceId, reason: "turn_limit_exceeded" });
    } else if (entry.sourceText.length > MAX_SOURCE_CHARACTERS) {
      audit.rejected.push({ sourceId: entry.sourceId, reason: "source_character_budget_exceeded" });
    } else {
      audit.accepted.push({ ...entry, publicText: `文字起こし記載: ${entry.sourceText}` });
    }
  }
  const selected = audit.accepted[0];
  if (!selected) return { value: BANT_UNKNOWN_VALUES.need, basis: "no_valid_source", audit };
  if (unknownNeedSource(selected.sourceText)) {
    return { value: BANT_UNKNOWN_VALUES.need, basis: "unknown_source", audit };
  }
  return { value: selected.publicText, basis: "literal_source", audit };
}
