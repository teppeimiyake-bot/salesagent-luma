import { timelineSourceTurns } from "./timeline-evidence";
import { readSourceEvidenceBlocks, type SourceEvidenceBlock } from "./issue-evidence";

const MAX_DEPTH = 24;
const MAX_NODES = 2_000;
const MAX_TEXT_LENGTH = 100_000;

// The same numeric id/ids notation as STEP2's trailing-reference guard, also
// recognized inside generated sentences. Only these explicit citation markers
// are eligible; ordinary parenthetical prose, business IDs and dates are not.
const reference = /[ \t\u3000]*([（(])[ \t\u3000]*[iｉ][dｄ][sｓ]?[ \t\u3000]*[:：][ \t\u3000]*([0-9０-９]{1,9}(?:[ \t\u3000]*[,，、][ \t\u3000]*[0-9０-９]{1,9}){0,31})[ \t\u3000]*([）)])/giu;
const quotedReference = /[ \t\u3000]*([（(])[ \t\u3000]*([0-9０-９]{1,9})[ \t\u3000]*([）)])/gu;

function idsKey(value: string): string {
  return [...new Set(value.normalize("NFKC").split(/[,、]/u).map(Number))].sort((a, b) => a - b).join(",");
}

/** Only a number immediately following an outer, complete quotation can be a
 * bare source reference. The quote must occur literally in that numbered source
 * block; omitting its final period needs no normalization or paraphrase matching.
 */
function stripQuotedReferences(text: string, blocks: ReadonlyMap<number, SourceEvidenceBlock>, literalNumbers: ReadonlySet<number>): string {
  const closers = new Map([["「", "」"], ["『", "』"], ["“", "”"], ['"', '"']]);
  const stack: Array<{ start: number; closer: string }> = [];
  const quotesByEnd = new Map<number, string>();
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      let escapes = 0;
      for (let before = index - 1; before >= 0 && text[before] === "\\"; before--) escapes++;
      if (escapes % 2) continue;
    }
    if (stack.length && character === stack[stack.length - 1].closer) {
      const opened = stack.pop()!;
      if (!stack.length && index > opened.start + 1 && index - opened.start <= 2_001)
        quotesByEnd.set(index + 1, text.slice(opened.start + 1, index));
    } else {
      const closer = closers.get(character);
      if (closer) stack.push({ start: index, closer });
    }
  }
  return text.replace(quotedReference, (marker, opening: string, digits: string, closing: string, offset: number) => {
    if ((opening === "(" && closing !== ")") || (opening === "（" && closing !== "）")) return marker;
    const quote = quotesByEnd.get(offset);
    const id = Number(digits.normalize("NFKC"));
    if (!quote || literalNumbers.has(id) || !Number.isSafeInteger(id) || id < 1) return marker;
    // A parenthesized quantity or date remains a quantity even beside a quote.
    if (/^(?:万?円|人|個|件|社|年|月|日|時間|回|[%％])/u.test(text.slice(offset + marker.length))) return marker;
    const block = blocks.get(id);
    return block && block.sourceText.includes(quote) ? "" : marker;
  });
}

export interface RecommendationSourceReferenceResult<T> {
  value: T;
  applied: boolean;
  changedPaths: string[];
  /** Oversized, cyclic or deeply nested branches are left intact, never truncated. */
  skippedPaths: string[];
}

/**
 * Remove generated source-ID annotations from recommendation display fields.
 * Run on generated topSales/strategy/nextActions before final literal-source
 * projections; never pass provider traces or audit records to this helper.
 * A marker present in the transcript is preserved, including normalized business
 * ID variants. All IDs in a marker must refer to real source lines to remove it.
 * Unchanged branches retain identity and provider values are never mutated.
 */
export function stripRecommendationSourceReferences<T>(transcript: string, recommendations: T): RecommendationSourceReferenceResult<T> {
  const sourceCount = timelineSourceTurns(transcript).length;
  const sourceBlocks = readSourceEvidenceBlocks(transcript);
  const sourceReferences = new Set([...transcript.matchAll(reference)].map((match) => idsKey(match[2])));
  // Preserve a number used literally in source parentheses, including business
  // identifiers. Ambiguous source/citation collisions deliberately remain.
  const literalNumbers = new Set([...transcript.matchAll(quotedReference)].map(match => Number(match[2].normalize("NFKC"))));
  const changedPaths: string[] = [];
  const skippedPaths: string[] = [];
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (value: unknown, path: string, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      skippedPaths.push(path);
      return value;
    }
    if (typeof value === "string") {
      if (value.length > MAX_TEXT_LENGTH) {
        skippedPaths.push(path);
        return value;
      }
      const labelled = value.replace(reference, (marker, opening: string, ids: string, closing: string) => {
        if ((opening === "(" && closing !== ")") || (opening === "（" && closing !== "）")) return marker;
        const key = idsKey(ids);
        if (sourceReferences.has(key)) return marker;
        const numbers = key.split(",").map(Number);
        return numbers.every((id) => Number.isSafeInteger(id) && id >= 1 && id <= sourceCount) ? "" : marker;
      });
      const cleaned = stripQuotedReferences(labelled, sourceBlocks, literalNumbers);
      if (cleaned !== value) changedPaths.push(path);
      return cleaned;
    }
    if (!value || typeof value !== "object") return value;
    if (ancestors.has(value)) {
      skippedPaths.push(path);
      return value;
    }
    const prototype = Object.getPrototypeOf(value);
    // Accept JSON objects from other realms, but do not inspect custom objects.
    if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) return value;
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      let changed = false;
      for (const key of Object.keys(value)) {
        const childPath = Array.isArray(value) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
        if (nodes >= MAX_NODES) {
          skippedPaths.push(childPath);
          break;
        }
        const descriptor = descriptors[key];
        if (!("value" in descriptor)) continue; // Never invoke getters.
        const cleaned = visit(descriptor.value, childPath, depth + 1);
        if (cleaned !== descriptor.value) {
          descriptors[key] = { ...descriptor, value: cleaned };
          changed = true;
        }
      }
      if (!changed) return value;
      return Object.defineProperties(Array.isArray(value) ? [] : Object.create(prototype), descriptors);
    } finally {
      ancestors.delete(value);
    }
  };

  const value = visit(recommendations, "", 0) as T;
  return { value, applied: changedPaths.length > 0, changedPaths, skippedPaths };
}
