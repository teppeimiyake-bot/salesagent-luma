/**
 * Deal × DealProduct の共通集計ヘルパー。
 * UI / API / KPI で重複しないよう、ここに集約する。
 */

export type DealProductLite = {
  id?: string;
  productName: string;
  planName?: string | null;
  probability: number;
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
 * 見込み金額（重み付き合計）= sum(amount * probability/100)
 */
export function pipelineAmount(items: DealProductLite[]): number {
  return items.reduce(
    (sum, p) => sum + (p.amount ?? 0) * ((p.probability ?? 0) / 100),
    0,
  );
}

/**
 * 代表確度（金額重み付き加重平均）
 *  - 全DealProductのamountが0/null → 単純平均（amountで重み付けできないため）
 *  - 全DealProductのprobabilityも0で空っぽ → 0
 */
export function weightedProbability(items: DealProductLite[]): number {
  if (items.length === 0) return 0;
  const totalAmt = items.reduce((s, p) => s + (p.amount ?? 0), 0);
  if (totalAmt === 0) {
    // 単純平均
    const sumProb = items.reduce((s, p) => s + (p.probability ?? 0), 0);
    return Math.round(sumProb / items.length);
  }
  const weighted = items.reduce(
    (s, p) => s + (p.amount ?? 0) * (p.probability ?? 0),
    0,
  );
  return Math.round(weighted / totalAmt);
}

/**
 * 受注済み金額の合計（yomiStatus が "受注" の DealProduct.amount の和）
 * KPI（受注実績）に使う
 */
export function wonAmount(items: DealProductLite[]): number {
  return items
    .filter((p) => p.yomiStatus === "受注")
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
 * Yomi バッジ色（ProbabilityBadge と整合）
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
