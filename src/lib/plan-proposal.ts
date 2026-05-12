/**
 * 企画提案マスタ（PlanProposal）の表示色マップ・カテゴリ抽出ヘルパ。
 *
 * - DBには name 文字列で保管されるため、name から色・カテゴリを引く。
 * - color は Notion の multi_select 色名（blue / brown / orange / purple / green / yellow / pink / red / gray / default）を踏襲。
 *   Notion 由来でない手入力タグは color="default" としておけば FALLBACK で安全に表示される。
 * - 映像プランの DealProduct.planProposals でのみ使う想定。
 */

export interface PlanProposalColor {
  bg: string;
  text: string;
  border: string;
}

/** Notion multi_select の色名 → Tailwind クラス */
const NOTION_COLOR_MAP: Record<string, PlanProposalColor> = {
  blue: { bg: "bg-sky-100", text: "text-sky-800", border: "border-sky-200" },
  brown: { bg: "bg-amber-100", text: "text-amber-900", border: "border-amber-300" },
  orange: { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-200" },
  purple: { bg: "bg-violet-100", text: "text-violet-800", border: "border-violet-200" },
  green: { bg: "bg-emerald-100", text: "text-emerald-800", border: "border-emerald-200" },
  yellow: { bg: "bg-yellow-100", text: "text-yellow-800", border: "border-yellow-200" },
  pink: { bg: "bg-pink-100", text: "text-pink-800", border: "border-pink-200" },
  red: { bg: "bg-rose-100", text: "text-rose-800", border: "border-rose-200" },
  gray: { bg: "bg-zinc-100", text: "text-zinc-700", border: "border-zinc-200" },
  default: { bg: "bg-zinc-100", text: "text-zinc-700", border: "border-zinc-200" },
};

/** UIの色セレクト用：選べる色の一覧 */
export const PLAN_PROPOSAL_COLOR_OPTIONS: { value: string; label: string }[] = [
  { value: "blue", label: "Blue（青）" },
  { value: "brown", label: "Brown（茶）" },
  { value: "orange", label: "Orange（橙）" },
  { value: "purple", label: "Purple（紫）" },
  { value: "green", label: "Green（緑）" },
  { value: "yellow", label: "Yellow（黄）" },
  { value: "pink", label: "Pink（桃）" },
  { value: "red", label: "Red（赤）" },
  { value: "gray", label: "Gray（灰）" },
  { value: "default", label: "Default（無彩）" },
];

const FALLBACK: PlanProposalColor = {
  bg: "bg-zinc-100",
  text: "text-zinc-700",
  border: "border-zinc-200",
};

/** color 名から Tailwind クラスを引く（未知なら無彩） */
export function planProposalColorClass(color: string | null | undefined): PlanProposalColor {
  if (!color) return FALLBACK;
  return NOTION_COLOR_MAP[color] ?? FALLBACK;
}

/**
 * 企画提案名のプレフィックス（角括弧【】）からカテゴリを機械抽出する。
 * 例:
 *   「【採用】ドラマ風動画」    → "採用"
 *   「【SNS】縦型ショート動画」  → "SNS"
 *   「【会社紹介】CM」          → "会社紹介"
 *   「IR動画」                  → "その他"（プレフィックス無し）
 */
export function planProposalCategory(name: string): string {
  const m = name.match(/^【([^】]+)】/);
  return m ? m[1] : "その他";
}

/** name から色を引く便利関数（マスタ join 済みなら color を直接使う方が良い） */
export function planProposalColorByName(
  name: string,
  masters: { name: string; color: string }[],
): PlanProposalColor {
  const found = masters.find((m) => m.name === name);
  return planProposalColorClass(found?.color);
}
