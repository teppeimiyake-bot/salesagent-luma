/**
 * Deal × DealProduct の共通集計ヘルパー。
 * UI / API / KPI で重複しないよう、ここに集約する。
 */
import { isWonYomi } from "@/lib/yomi-status";

export type DealProductLite = {
  id?: string;
  productName: string;
  planName?: string | null;
  /**
   * probability列はDB残置（社長判断 A案 2026-05）。
   * UI/集計では使わないが、ヨミ↔probability の内部整合・Notion同期のため列自体は維持。
   * 集計ヘルパー（totalProposedAmount / representativeYomi 等）は probability を参照しないので optional。
   */
  probability?: number;
  amount: number | null;
  yomiStatus?: string | null;
};

/**
 * 提案金額合計（重み付けなし）
 */
export function totalProposedAmount(items: DealProductLite[]): number {
  return items.reduce((sum, p) => sum + (p.amount ?? 0), 0);
}

/**
 * DealProduct 単体が「受注」か判定。
 * Luma の実データは Notion由来で yomiStatus にカテゴリ接頭辞が付く（"【映像】受注" 等）ほか、
 * アライアンスは "締結済み" を使う。よって完全一致 "受注" では取りこぼす。
 * → isWonYomi()（接頭辞除去 + 受注/締結済み の部分一致）で判定する。
 */
export function isWonProduct(p: DealProductLite): boolean {
  return isWonYomi(p.yomiStatus);
}

/**
 * Deal が「受注」か判定。
 * 配下 DealProduct のいずれかが受注（isWonProduct）なら受注扱い。
 *
 * 背景（2026-05 受注率0%不具合の修正）：
 *   Notion取込（import-luma-yomi.ts）は Deal.status / Deal.contractDate を設定しないため、
 *   Deal.status はずっと既定値 LEAD のまま。受注の唯一の事実は DealProduct.yomiStatus。
 *   よって受注判定・受注率・受注金額はすべて yomiStatus ベースに統一する。
 */
export function isWonDeal(items: DealProductLite[]): boolean {
  return items.some(isWonProduct);
}

/**
 * 受注済み金額の合計（yomiStatus が 受注/締結済み の DealProduct.amount の和）
 * KPI（受注実績）に使う
 */
export function wonAmount(items: DealProductLite[]): number {
  return items
    .filter(isWonProduct)
    .reduce((s, p) => s + (p.amount ?? 0), 0);
}

/**
 * 代表プロダクト（提案金額が最も大きい）
 * 一覧表示でメインに見せるプロダクト名用
 */
export function representativeProduct(items: DealProductLite[]): DealProductLite | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))[0];
}

/**
 * 一覧表示用の主要プロダクト名（金額降順上位N件 + "他M件"）
 */
export function topProductLabels(items: DealProductLite[], limit = 2): {
  primary: DealProductLite[];
  rest: number;
} {
  if (items.length === 0) return { primary: [], rest: 0 };
  const sorted = [...items].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  return {
    primary: sorted.slice(0, limit),
    rest: Math.max(0, sorted.length - limit),
  };
}

/**
 * Yomi（受注ヨミ）→ probability 変換テーブル
 * リージー定義：受注100 / A+90 / A70 / B50 / C30 / ネタ10 / NG0
 */
export const YOMI_TO_PROBABILITY: Record<string, number> = {
  受注: 100,
  "A+ヨミ": 90,
  Aヨミ: 70,
  Bヨミ: 50,
  Cヨミ: 30,
  ネタ: 10,
  NG: 0,
};

export const YOMI_OPTIONS = ["受注", "A+ヨミ", "Aヨミ", "Bヨミ", "Cヨミ", "ネタ", "NG"] as const;
export type Yomi = (typeof YOMI_OPTIONS)[number];

/**
 * probability から Yomi の逆引き（ぴったり一致 or 近似）
 * probability列はDB残置（社長判断 A案 2026-05）。ヨミ↔probability の内部整合維持に使う。
 */
export function probabilityToYomi(prob: number): Yomi {
  if (prob >= 100) return "受注";
  if (prob >= 90) return "A+ヨミ";
  if (prob >= 70) return "Aヨミ";
  if (prob >= 50) return "Bヨミ";
  if (prob >= 30) return "Cヨミ";
  if (prob >= 10) return "ネタ";
  return "NG";
}

/**
 * ヨミの並び順ランク（社長判断 2026-05）
 *   受注 > A+ヨミ > Aヨミ > Bヨミ > Cヨミ > ネタ > NG
 * 値が大きいほど受注に近い。降順ソートで「受注が先頭」になる。
 * カテゴリ接頭辞（【映像】等）が付いていても判定できるよう stripYomiPrefix 相当の処理を内蔵。
 */
const YOMI_RANK: Record<string, number> = {
  受注: 7,
  "A+ヨミ": 6,
  Aヨミ: 5,
  Bヨミ: 4,
  Cヨミ: 3,
  ネタ: 2,
  NG: 1,
};

/** 接頭辞（【映像】【SNS】【CATV】）を外した素のヨミを返す */
function bareYomi(yomi: string | null | undefined): string {
  if (!yomi) return "";
  const m = /^【[^】]+】(.+)$/.exec(yomi);
  return m ? m[1] : yomi;
}

/**
 * 単一ヨミ文字列の並び順ランク（不明・null は 0 = 最下位）
 */
export function yomiRank(yomi: string | null | undefined): number {
  const bare = bareYomi(yomi);
  if (bare === "締結済み") return YOMI_RANK["受注"];
  return YOMI_RANK[bare] ?? 0;
}

/**
 * 代表ヨミ：Deal配下の DealProduct のうち最も受注に近いヨミを返す。
 * 「代表確度」の置き換え。一覧でのヨミ表示・ヨミ順ソートに使う。
 *  - DealProduct が0件 → null
 *  - すべて未設定 → null
 */
export function representativeYomi(items: DealProductLite[]): string | null {
  let best: { yomi: string; rank: number } | null = null;
  for (const p of items) {
    if (!p.yomiStatus) continue;
    const rank = yomiRank(p.yomiStatus);
    if (rank === 0) continue;
    if (!best || rank > best.rank) {
      best = { yomi: bareYomi(p.yomiStatus), rank };
    }
  }
  return best?.yomi ?? null;
}

/**
 * Deal の代表ヨミランク（ヨミ順ソート用）。
 * representativeYomi が null（ヨミ未設定の商談）の場合は 0 = 最下位。
 */
export function dealYomiRank(items: DealProductLite[]): number {
  return yomiRank(representativeYomi(items));
}

/**
 * Yomi バッジ色（ヨミ7段階の表示色）
 */
export function yomiColor(yomi: string | null | undefined): {
  bg: string;
  text: string;
  border: string;
} {
  switch (yomi) {
    case "受注":
      return { bg: "bg-emerald-100", text: "text-emerald-800", border: "border-emerald-300" };
    case "A+ヨミ":
      return { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" };
    case "Aヨミ":
      return { bg: "bg-sky-100", text: "text-sky-800", border: "border-sky-300" };
    case "Bヨミ":
      return { bg: "bg-amber-100", text: "text-amber-800", border: "border-amber-300" };
    case "Cヨミ":
      return { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-300" };
    case "ネタ":
      return { bg: "bg-zinc-100", text: "text-zinc-700", border: "border-zinc-300" };
    case "NG":
      return { bg: "bg-red-100", text: "text-red-700", border: "border-red-300" };
    default:
      return { bg: "bg-zinc-50", text: "text-zinc-500", border: "border-zinc-200" };
  }
}
