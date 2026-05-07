/**
 * リード獲得経由（LeadSource）の表示色マップ。
 * DBには文字列で保管されるため、name から色を引く。
 */

export interface LeadSourceColor {
  bg: string;
  text: string;
  border: string;
}

const COLOR_MAP: Record<string, LeadSourceColor> = {
  MS: { bg: "bg-blue-100", text: "text-blue-800", border: "border-blue-300" },
  交流会経由: { bg: "bg-violet-100", text: "text-violet-800", border: "border-violet-300" },
  紹介: { bg: "bg-emerald-100", text: "text-emerald-800", border: "border-emerald-300" },
  HP経由: { bg: "bg-amber-100", text: "text-amber-800", border: "border-amber-300" },
  SNS経由: { bg: "bg-fuchsia-100", text: "text-fuchsia-800", border: "border-fuchsia-300" },
  その他: { bg: "bg-zinc-100", text: "text-zinc-700", border: "border-zinc-300" },
};

const FALLBACK: LeadSourceColor = {
  bg: "bg-zinc-50",
  text: "text-zinc-600",
  border: "border-zinc-200",
};

export function leadSourceColor(name: string | null | undefined): LeadSourceColor {
  if (!name) return FALLBACK;
  return COLOR_MAP[name] ?? FALLBACK;
}

/**
 * 初期投入する LeadSource マスタ（seed と admin で参照）
 * Luma版：自社顧客（=リージー版で言う「Luma顧客企業」）の概念は無いため「紹介」に置換。
 */
export const DEFAULT_LEAD_SOURCES: { name: string; sortOrder: number }[] = [
  { name: "MS", sortOrder: 1 },
  { name: "交流会経由", sortOrder: 2 },
  { name: "紹介", sortOrder: 3 },
  { name: "HP経由", sortOrder: 4 },
  { name: "SNS経由", sortOrder: 5 },
  { name: "その他", sortOrder: 6 },
];
