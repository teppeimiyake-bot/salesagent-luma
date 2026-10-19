import { readSourceEvidenceBlocks } from "./issue-evidence";

type ParticipantRejectionReason = "invalid_participant" | "duplicate_speaker_label" | "not_speaker_or_attendee";

export interface MinutesParticipantAudit {
  /** The provider's draft is retained unchanged; it is never the public list itself. */
  candidates: unknown;
  accepted: Array<{ index: number; participant: string; basis: "speaker" | "attendance" | "unverifiable_transcript" }>;
  rejected: Array<{ index: number | null; participant?: string; reason: ParticipantRejectionReason }>;
}

const attendance = /同席|出席|参加|同行/u;
const negatedAttendance = /(?:同席|出席|参加|同行)(?:し|でき|され|いたし)?(?:ません|ない|ず)|欠席|不参加/u;
const honorific = /(?:様|さん|氏|殿)$/u;

/** The speaker label an entry names: 「話者2: 森田」「話者3（所属未確認）」「山田（顧客）」. */
function speakerOf(entry: string, speakers: readonly string[]): string | undefined {
  const label = entry.split(/[:：]/u)[0].trim();
  if (speakers.includes(label)) return label;
  return speakers.find((speaker) => entry === speaker || (entry.startsWith(speaker) && /^[\s（(、,]/u.test(entry.slice(speaker.length))));
}

/** The person an entry describes, without the speaker label and honorific: 「顧客: 部長の田中様」→「部長の田中」. */
function personOf(entry: string, speaker: string | undefined): string {
  const rest = speaker ? entry.slice(speaker.length).replace(/^[\s:：（(、,]+/u, "").replace(/[）)]\s*$/u, "") : entry;
  return rest.trim().replace(honorific, "").trim();
}

/** The source states, without negation, that this person attends (「部長の田中も同席しております」). */
function statedAttendance(transcript: string, person: string): boolean {
  if (!person) return false;
  return (transcript.match(/[^。！？!?\n]+/gu) ?? [])
    .some((sentence) => sentence.includes(person) && attendance.test(sentence) && !negatedAttendance.test(sentence));
}

/**
 * Participants are the speakers of this transcript, or people whose attendance the source states.
 * A person only mentioned in the conversation (「決済は工場長の石田です」) is not a participant (UI確認 2026-10-01 edge-02).
 * One speaker label is one speaker; a second entry under the same label needs stated attendance.
 * Without speaker labels the transcript cannot verify anyone, so the draft list is kept as written.
 */
export function groundMinutesParticipants(transcript: string, candidates: unknown): { participants: string[]; audit: MinutesParticipantAudit } {
  const audit: MinutesParticipantAudit = { candidates, accepted: [], rejected: [] };
  if (!Array.isArray(candidates)) {
    audit.rejected.push({ index: null, reason: "invalid_participant" });
    return { participants: [], audit };
  }
  const speakers = [...new Set([...readSourceEvidenceBlocks(transcript).values()].map((block) => block.speaker).filter((speaker): speaker is string => !!speaker))]
    .sort((left, right) => right.length - left.length);
  const usedLabels = new Set<string>();
  candidates.forEach((candidate, index) => {
    const entry = typeof candidate === "string" ? candidate.trim() : "";
    if (!entry) { audit.rejected.push({ index, reason: "invalid_participant" }); return; }
    if (!speakers.length) { audit.accepted.push({ index, participant: entry, basis: "unverifiable_transcript" }); return; }
    const speaker = speakerOf(entry, speakers);
    if (speaker && !usedLabels.has(speaker)) {
      usedLabels.add(speaker);
      audit.accepted.push({ index, participant: entry, basis: "speaker" });
      return;
    }
    if (statedAttendance(transcript, personOf(entry, speaker))) {
      audit.accepted.push({ index, participant: entry, basis: "attendance" });
      return;
    }
    audit.rejected.push({ index, participant: entry, reason: speaker ? "duplicate_speaker_label" : "not_speaker_or_attendee" });
  });
  return { participants: audit.accepted.map(({ participant }) => participant), audit };
}
