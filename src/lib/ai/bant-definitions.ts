export const BANT_KEYS = ["budget", "authority", "need", "timeline"] as const;

export type BantKey = (typeof BANT_KEYS)[number];
export type BantStatus = "confirmed" | "estimated" | "unknown";

export const BANT_DEFINITIONS: Record<BantKey, string> = {
  budget: "予算感（金額／確保状況／会計年度）",
  authority: "決裁者決裁構造",
  need: "ニーズ課題",
  timeline: "導入時期",
};

export const BANT_LABELS: Record<BantKey, string> = {
  budget: "Budget",
  authority: "Authority",
  need: "Need",
  timeline: "Timeline",
};

export const BANT_UNKNOWN_VALUES: Record<BantKey, string> = {
  budget: "未確定: 予算感（金額／確保状況／会計年度）を確認する必要あり",
  authority: "未確定: 決裁者決裁構造を確認する必要あり",
  need: "未確定: ニーズ課題を確認する必要あり",
  timeline: "未確定: 導入時期を確認する必要あり",
};

export function formatBantDefinitions(): string {
  return BANT_KEYS.map((key) => `- ${BANT_LABELS[key]}: ${BANT_DEFINITIONS[key]}`).join("\n");
}
