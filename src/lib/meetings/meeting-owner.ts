export const MEETING_OWNER_TYPES = [
  "own_meet",
  "guest_meet",
  "zoom",
  "in_person",
  "unknown",
] as const;

export type MeetingOwnerType = (typeof MEETING_OWNER_TYPES)[number];

export function isMeetingOwnerType(value: string): value is MeetingOwnerType {
  return MEETING_OWNER_TYPES.includes(value as MeetingOwnerType);
}

export function isOwnMeet(value: string | null | undefined): boolean {
  return value === "own_meet";
}
