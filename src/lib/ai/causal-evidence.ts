import { readSourceEvidenceBlocks } from "./issue-evidence";

const selectionOutcome = /(?:面接|選考)[^。！？!?\r\n]{0,35}(?:進[むまみ]|移行|申[し]?込|少な|減)|説明会(?:後|から)[^。！？!?\r\n]{0,20}(?:移行|進[むまみ])|(?:学生|応募者|候補者)[^。！？!?\r\n]{0,20}辞退/u;
const causalTopic = /原因|理由|因果関係/u;
const genericCause = /^(?:ただ[、し]?\s*|その|この)?(?:原因|理由|因果関係)(?:は|が|について|を)/u;
/** Also read by the long-record excerpt (long-transcript.ts) to keep the lines this guard reads. */
export const uninvestigated = /未集計|未調査|未確認|不明|分から|分かりません|わから|わかりません|(?:集計|調査|調べ|分析|検証|比較)[^。！？!?]{0,24}(?:してい(?:な|ません)|できてい(?:な|ません)|てい(?:な|ません)|しておらず|できておらず|ておらず)/u;
export const verified = /(?:原因|理由|因果関係)[^。！？!?]{0,70}(?:確認しました|確認できました|確認済み|判明しました|特定しました|検証しました|裏付けられました)/u;
const literalField = /^(?:quote|source_quote|sourceText|transcript)$/u;
const literalLabel = /^\s*(?:原文|文字起こし記載|(?:顧客発言|発言|顧客が明示した内容)（[^）\r\n]*原文[^）\r\n]*）)\s*[:：]/u;
const assertion = /(?:その)?原因(?:と|に)なっている/gu;

type Span = { start: number; end: number };

function quotationSpans(text: string): Span[] {
  const closing = new Map([["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]);
  const stack: Array<{ start: number; closing: string }> = [];
  const spans: Span[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      let escapes = 0;
      for (let before = index - 1; before >= 0 && text[before] === "\\"; before--) escapes++;
      if (escapes % 2) continue;
    }
    if (stack.length && character === stack[stack.length - 1].closing) {
      const opened = stack.pop()!;
      if (!stack.length) spans.push({ start: opened.start, end: index + 1 });
    } else {
      const endQuote = closing.get(character);
      if (endQuote) stack.push({ start: index, closing: endQuote });
    }
  }
  if (stack.length) spans.push({ start: stack[0].start, end: text.length });
  return spans;
}

function maskQuotes(text: string): string {
  return quotationSpans(text).reduce((masked, span) => masked.slice(0, span.start)
    + " ".repeat(span.end - span.start) + masked.slice(span.end), text);
}

/** The latest explicit customer statement about selection/dropout causes wins.
 * A generic "原因は…" can refer only to the immediately preceding sentence in
 * the same turn. Unrelated SNS, budget or other uncertainty cannot activate it.
 */
function uncertainSelectionCause(transcript: string): string | undefined {
  let sourceQuote: string | undefined;
  for (const block of new Set(readSourceEvidenceBlocks(transcript).values())) {
    if (block.sourceRole !== "customer" || block.ambiguousSpeakers || block.sourceText.length > 2_000) continue;
    let previousSelection = false;
    for (const part of maskQuotes(block.body).match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
      const sentence = part.trim();
      const related = selectionOutcome.test(sentence) || (previousSelection && genericCause.test(sentence));
      previousSelection = selectionOutcome.test(sentence);
      if (!related || !causalTopic.test(sentence) || /[?？]|(?:です|ます|ません)か[。]?\s*$|もし|仮に/u.test(sentence)) continue;
      if (/未(?:集計|調査|確認)(?:では|じゃ)(?:ない|ありません)/u.test(sentence)) continue;
      if (uninvestigated.test(sentence)) sourceQuote = block.sourceText;
      else if (verified.test(sentence)) sourceQuote = undefined;
    }
  }
  return sourceQuote;
}

export interface CausalRecommendationResult<T> {
  value: T;
  applied: boolean;
  changedPaths: string[];
  skippedPaths: string[];
  /** Exact customer turn establishing the currently unverified causal claim. */
  sourceQuote?: string;
}

/** Narrow repair for an asserted recruitment-outcome cause when the customer
 * explicitly says those causes/reasons have not been established. It does not
 * classify every causal expression or rewrite verified and unrelated causes.
 * Run on generated recommendations only, before final literal projections.
 */
export function constrainUnverifiedCausalRecommendations<T>(transcript: string, recommendations: T): CausalRecommendationResult<T> {
  const sourceQuote = uncertainSelectionCause(transcript);
  const changedPaths: string[] = [];
  const skippedPaths: string[] = [];
  if (!sourceQuote) return { value: recommendations, applied: false, changedPaths, skippedPaths };
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, field: string, depth: number): unknown => {
    if (++nodes > 2_000 || depth > 24) { skippedPaths.push(path); return value; }
    if (typeof value === "string") {
      if (value.length > 100_000) { skippedPaths.push(path); return value; }
      if (literalField.test(field) || literalLabel.test(value) || !value || transcript.includes(value)) return value;
      const spans = quotationSpans(value);
      const masked = maskQuotes(value);
      const cleaned = value.replace(/[^\r\n]+/gu, (line, lineOffset: number) => {
        if (literalLabel.test(line)) return line;
        return line.replace(/[^。！？!?]+[。！？!?]?/gu, (sentence, sentenceOffset: number) => {
          if (!selectionOutcome.test(sentence)) return sentence;
          const start = lineOffset + sentenceOffset;
          const unquoted = masked.slice(start, start + sentence.length);
          if (/[?？]|断定でき(?:ない|ません)|原因では(?:ない|ありません)/u.test(unquoted)) return sentence;
          return sentence.replace(assertion, (phrase, offset: number) => {
            const position = start + offset;
            if (spans.some(span => position < span.end && position + phrase.length > span.start)) return phrase;
            // A selection outcome elsewhere in the sentence does not make an
            // unrelated budget or operational cause eligible. Only "その原因"
            // can refer back across a comma, to the nearest nonempty clause.
            const clauses = sentence.slice(0, offset).split(/[、,；;]/u);
            const topic = phrase.startsWith("その")
              ? clauses.filter(clause => clause.trim()).at(-1) ?? ""
              : clauses.at(-1) ?? "";
            if (!selectionOutcome.test(topic)) return phrase;
            if (/^(?:か|のか|可能性|とは|わけでは)/u.test(sentence.slice(offset + phrase.length))) return phrase;
            return "課題との因果関係を確認すべき";
          });
        });
      });
      if (cleaned !== value) changedPaths.push(path);
      return cleaned;
    }
    if (!value || typeof value !== "object" || literalField.test(field)) return value;
    if (ancestors.has(value)) { skippedPaths.push(path); return value; }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) return value;
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      let changed = false;
      for (const key of Object.keys(value)) {
        const childPath = Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
        if (nodes >= 2_000) { skippedPaths.push(childPath); break; }
        const descriptor = descriptors[key];
        if (!("value" in descriptor)) continue;
        const cleaned = visit(descriptor.value, childPath, key, depth + 1);
        if (cleaned !== descriptor.value) { descriptors[key] = { ...descriptor, value: cleaned }; changed = true; }
      }
      return changed ? Object.defineProperties(Array.isArray(value) ? [] : Object.create(prototype), descriptors) : value;
    } finally { ancestors.delete(value); }
  };
  const value = visit(recommendations, "", "", 0) as T;
  return { value, applied: changedPaths.length > 0, changedPaths, skippedPaths, sourceQuote };
}
