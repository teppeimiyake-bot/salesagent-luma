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
