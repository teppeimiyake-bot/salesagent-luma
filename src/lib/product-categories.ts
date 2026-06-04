/**
 * Lumaのプロダクトカテゴリ（管理者の商材作成 / 商談新規作成のグルーピング表示で使う）
 *
 * 2026-05 社長判断：
 *   Lumaのプロダクトは「映像 / SNS / CATV / アライアンス」の4種で運用する。
 *   過去のリージー名残（HP / コンサル / 営業支援 / SaaS / その他）は廃止。
 *   アライアンスはyomiStatusのプレフィックスを持たない（【映像】/【SNS】/【CATV】に対し
 *   アライアンスは "Cヨミ" "ネタ" "NG" などプレフィックスなし表記）。
 */
export const PRODUCT_CATEGORIES: { value: string; label: string; color: string }[] = [
  { value: "映像", label: "映像", color: "bg-rose-100 text-rose-800" },
  { value: "SNS", label: "SNS", color: "bg-pink-100 text-pink-800" },
  { value: "CATV", label: "CATV", color: "bg-sky-100 text-sky-800" },
  { value: "アライアンス", label: "アライアンス", color: "bg-emerald-100 text-emerald-800" },
];

export function categoryColor(value: string | null | undefined): string {
  return PRODUCT_CATEGORIES.find((c) => c.value === value)?.color ?? "bg-zinc-100 text-zinc-700";
}

export type ProductCategory = "映像" | "SNS" | "CATV" | "アライアンス";

const CATEGORY_VALUES: ProductCategory[] = ["映像", "SNS", "CATV", "アライアンス"];

/**
 * DealProduct から商材カテゴリ（映像/SNS/CATV/アライアンス）を判定する。
 * 優先順位：
 *   1. yomiStatus のカテゴリ接頭辞（【映像】等）— Luma実データはここで判定できる
 *   2. productName に映像/SNS/CATV/アライアンスが含まれるか
 *   3. Product.category（旧フィールド）or productName 全文一致
 * いずれも判定不能なら null。
 */
export function categoryFromDealProduct(dp: {
  yomiStatus?: string | null;
  productName?: string | null;
  product?: { name?: string | null; category?: string | null } | null;
}): ProductCategory | null {
  // 1. yomi 接頭辞
  const m = /^【([^】]+)】/.exec(dp.yomiStatus ?? "");
  if (m && CATEGORY_VALUES.includes(m[1] as ProductCategory)) {
    return m[1] as ProductCategory;
  }
  // 2/3. productName / Product.name / Product.category から部分一致
  const haystacks = [dp.productName, dp.product?.name, dp.product?.category].filter(
    (s): s is string => !!s,
  );
  for (const cat of CATEGORY_VALUES) {
    if (haystacks.some((h) => h.includes(cat))) return cat;
  }
  return null;
}
