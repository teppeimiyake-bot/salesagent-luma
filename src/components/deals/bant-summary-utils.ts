import { isUnknownBantValue } from "@/lib/ai/bant-reconciliation";

export type BantKey = "budget" | "authority" | "need" | "timeline";
export type BantStatus = "confirmed" | "estimated" | "unknown";
// Manual text entry does not review certainty. This display-only state also
// overrides historical manual fields that were automatically marked confirmed.
export type BantCardStatus = BantStatus | "unreviewed";

export type BantItem = {
  value?: string;
  status?: BantStatus;
  source_meeting_id?: string;
  quote?: string;
};

export type BantManualFields = Partial<Record<BantKey, boolean>>;

export type BantValue = {
  budget?: string | { value?: string };
  authority?: string | { value?: string };
  need?: string | { value?: string };
  timeline?: string | { value?: string };
  summary?: string;
  confidence?: number;
  updatedBy?: "auto" | "manual" | string;
  manualFields?: BantManualFields;
  items?: Partial<Record<BantKey, BantItem>>;
  aiSuggestion?: Partial<Record<BantKey, BantItem | string | { value?: string }>>;
};

export type BantMeetingRef = {
  id: string;
  title: string | null;
  meetingDate: Date | string;
};

export type BantCardView = {
  key: BantKey;
  value: string;
  status: BantCardStatus;
  isManual: boolean;
  source?: {
    href?: string;
    label: string;
    quote: string;
  };
  aiSuggestion: string;
};

export function countBantCardStatuses(
  cards: ReadonlyArray<Pick<BantCardView, "status">>,
): Record<BantCardStatus, number> {
  const counts: Record<BantCardStatus, number> = {
    confirmed: 0,
    estimated: 0,
    unknown: 0,
    unreviewed: 0,
  };
  for (const card of cards) counts[card.status] += 1;
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** UTF-8 を Latin-1 として読んだ文字化け（ãª 等）を元の日本語へ戻す。 */
export function repairUtf8Mojibake(text: string): string {
  if (!text) return text;
  const hasCjk = /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
  const hasMojibake = /[ÃÂãåæçèé]/.test(text);
  if (hasCjk || !hasMojibake) return text;
  try {
    const bytes = Uint8Array.from([...text].map((ch) => ch.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(repaired) && !repaired.includes("\uFFFD")) {
      return repaired;
    }
  } catch {
    return text;
  }
  return text;
}

function fieldText(value: string | { value?: string } | undefined): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value.value === "string") return value.value.trim();
  return "";
}

export function bantText(initial: BantValue | null | undefined, key: BantKey): string {
  const direct = initial?.[key];
  const directText = fieldText(direct);
  if (directText) return directText;
  return cleanText(initial?.items?.[key]?.value);
}

function itemText(value: BantItem | string | { value?: string } | undefined): string {
  if (typeof value === "string") return value.trim();
  if (isRecord(value)) return cleanText(value.value);
  return "";
}

function isUnknownValue(value: string): boolean {
  return isUnknownBantValue(value);
}

function validStatus(value: unknown): value is BantStatus {
  return value === "confirmed" || value === "estimated" || value === "unknown";
}

function shortDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  // サーバー（UTC）とブラウザで出典日付がズレないよう JST 固定
  return date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", timeZone: "Asia/Tokyo" });
}

function meetingLabels(meetings: BantMeetingRef[]): Map<string, string> {
  const ordered = [...meetings].sort(
    (a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime(),
  );
  return new Map(
    ordered.map((meeting, index) => [
      meeting.id,
      meeting.title || `第${index + 1}回商談`,
    ]),
  );
}

function resolveSource(
  item: BantItem | undefined,
  meetings: BantMeetingRef[],
  labels: Map<string, string>,
): BantCardView["source"] {
  const sourceMeetingId = item?.source_meeting_id?.trim();
  if (!sourceMeetingId) return undefined;
  const meeting = meetings.find((m) => m.id === sourceMeetingId);
  const quote = item?.quote?.trim() ?? "";
  if (!meeting) {
    return {
      label: `出典：商談ID ${sourceMeetingId}`,
      quote,
    };
  }
  const dateLabel = shortDate(meeting.meetingDate);
  return {
    href: `#meeting-${sourceMeetingId}`,
    label: `出典：${labels.get(sourceMeetingId) ?? "商談"}${dateLabel ? `（${dateLabel}）` : ""}`,
    quote,
  };
}

export function resolveBantCardView(
  bant: BantValue | null | undefined,
  key: BantKey,
  meetings: BantMeetingRef[] = [],
): BantCardView {
  const value = bantText(bant, key);
  const item = bant?.items?.[key];
  const isManual = bant?.manualFields?.[key] === true;
  const status =
    isUnknownValue(value)
      ? "unknown"
      : isManual
        ? "unreviewed"
        : validStatus(item?.status)
          ? item.status
          : "estimated";
  const labels = meetingLabels(meetings);
  const suggestion = itemText(bant?.aiSuggestion?.[key]);
  return {
    key,
    value,
    status,
    isManual,
    source: resolveSource(item, meetings, labels),
    aiSuggestion: suggestion === value ? "" : suggestion,
  };
}

export function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function resolveUpdateMode(initial: BantValue | null): "auto" | "manual" | null {
  if (initial?.updatedBy === "auto") return "auto";
  if (initial?.updatedBy === "manual") return "manual";
  if (initial?.manualFields && Object.values(initial.manualFields).some(Boolean)) return "manual";
  return null;
}
