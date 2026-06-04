/**
 * 見積書・契約書PDFで使う和暦日付・金額フォーマッタ。
 */

const ERA_NAME = "令和";
const REIWA_START_YEAR = 2019; // 令和元年 = 2019年

/**
 * 西暦Dateを和暦文字列に整形。
 *   2026-06-04 → "令和8年6月4日"
 * 令和のみ対応（本ツールが扱う期間は令和で十分）。
 */
export function toWareki(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const eraYear = y - REIWA_START_YEAR + 1;
  const label = eraYear === 1 ? "元" : String(eraYear);
  return `${ERA_NAME}${label}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * 西暦Dateを "202●年●月●日" 形式（契約書頭書の差込用）に整形。
 */
export function toSeireki(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 1234567 → "1,234,567" */
export function groupDigits(n: number): string {
  return Math.round(n).toLocaleString("ja-JP");
}

/** 1234567 → "¥1,234,567" */
export function yen(n: number): string {
  return `¥${groupDigits(n)}`;
}

/** 金額を「金●●円」表記（契約書本文用）。1000000 → "金1,000,000円" */
export function kingaku(n: number): string {
  return `金${groupDigits(n)}円`;
}
