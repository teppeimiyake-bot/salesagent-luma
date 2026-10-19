import { readSourceEvidenceBlocks, type SourceEvidenceBlock } from "./issue-evidence";

const MAX_TURNS = 2;
const MAX_SOURCE_CHARACTERS = 1200;
export const UNGROUNDED_ACTION_REASON = "AIからの提案です。原文との対応は未確認です。";

type ReasonDraft = { reason: string; reason_source_ids?: unknown };
type ActionDrafts = { next_actions: ReasonDraft[] };
type PublicActions<T extends ActionDrafts> = Omit<T, "next_actions"> & {
  next_actions: Array<Omit<T["next_actions"][number], "reason_source_ids">>;
};
type RejectionReason = "invalid_source_ids" | "invalid_source_id" | "duplicate_source_id"
  | "duplicate_source_turn" | "ambiguous_speakers" | "empty_turn"
  | "turn_limit_exceeded" | "source_character_budget_exceeded";

export interface ActionReasonAudit {
  index: number;
  requestedSourceIds: unknown;
  accepted: Array<{
    sourceId: number;
    sourceIds: number[];
    contextSourceIds: number[];
    sourceText: string;
    sourceRole: SourceEvidenceBlock["sourceRole"];
  }>;
  rejected: Array<{ sourceId: unknown; reason: RejectionReason }>;
  reason: string;
}

/** Replace generated factual premises with complete selected source passages.
 * Speaker labels, questions, conditions and uncertainty remain literal. A
 * selected passage is context for an AI proposal, not proof of its efficacy.
 * All other action fields and the provider's candidates stay untouched.
 */
export function groundActionReasons<T extends ActionDrafts>(transcript: string, candidates: T): {
  value: PublicActions<T>; applied: boolean; audit: ActionReasonAudit[];
} {
  const blocks = readSourceEvidenceBlocks(transcript);
  const audit: ActionReasonAudit[] = [];
  let applied = false;
  const nextActions = candidates.next_actions.map((candidate, index) => {
    const { reason_source_ids: requestedSourceIds, ...publicAction } = candidate;
    const entry: ActionReasonAudit = { index, requestedSourceIds, accepted: [], rejected: [], reason: UNGROUNDED_ACTION_REASON };
    if (!Array.isArray(requestedSourceIds)) {
      entry.rejected.push({ sourceId: null, reason: "invalid_source_ids" });
    } else {
      const seen = new Set<number>();
      const acceptedBlocks = new Set<SourceEvidenceBlock>();
      let sourceCharacters = 0;
      for (const sourceId of requestedSourceIds) {
        const reject = (reason: RejectionReason) => entry.rejected.push({ sourceId, reason });
        if (typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || !blocks.has(sourceId)) {
          reject("invalid_source_id"); continue;
        }
        if (seen.has(sourceId)) { reject("duplicate_source_id"); continue; }
        seen.add(sourceId);
        const block = blocks.get(sourceId)!;
        if (acceptedBlocks.has(block)) { reject("duplicate_source_turn"); continue; }
        if (!block.body.trim()) { reject("empty_turn"); continue; }
        if (block.ambiguousSpeakers) { reject("ambiguous_speakers"); continue; }
        if (entry.accepted.length >= MAX_TURNS) { reject("turn_limit_exceeded"); continue; }
        if (sourceCharacters + block.sourceText.length > MAX_SOURCE_CHARACTERS) {
          reject("source_character_budget_exceeded"); continue;
        }
        entry.accepted.push({ sourceId, sourceIds: [...block.sourceIds],
          contextSourceIds: block.sourceIds.filter(id => id !== sourceId),
          sourceText: block.sourceText, sourceRole: block.sourceRole });
        acceptedBlocks.add(block);
        sourceCharacters += block.sourceText.length;
      }
    }
    entry.accepted.sort((left, right) => left.sourceIds[0] - right.sourceIds[0]);
    if (entry.accepted.length) entry.reason = entry.accepted.map(source => `原文: ${source.sourceText}`).join("\n");
    audit.push(entry);
    if (entry.reason !== candidate.reason || Object.hasOwn(candidate, "reason_source_ids")) applied = true;
    return { ...publicAction, reason: entry.reason };
  });
  return { value: { ...candidates, next_actions: nextActions } as PublicActions<T>, applied, audit };
}
