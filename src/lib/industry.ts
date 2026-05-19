/**
 * 業界（Company.industry）の文字列パース・ユーティリティ
 *
 * 表記ルール（社長指示・2026-05）:
 * - 業界名の中の「・」（中黒）は 1つの業界名の一部。分割しない（例「広告・出版・マスコミ」で1業界）
 * - 「,」（半角カンマ）は 複数業界の区切り。これで分割して別々の業界として扱う
 *
 * DB の Company.industry の値そのものは書き換えず、解釈ロジックだけここに集約する。
 */

/**
 * industry 文字列を「,」で分割し、個別の業界名の配列にする。
 * - 「,」でのみ分割（「・」は保持）
 * - 各トークンは trim、空文字は除外
 * - null/空文字は空配列
 */
export function parseIndustries(industry: string | null | undefined): string[] {
  if (!industry) return [];
  return industry
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 複数の industry 文字列から、フィルター用の業界選択肢を生成する。
 * - すべて「,」で分割・trim・空除外
 * - 重複排除
 * - 件数（その業界に属する社の延べ数）の降順、同数なら五十音順で並べる
 */
export function buildIndustryOptions(
  industries: (string | null | undefined)[],
): string[] {
  const counts = new Map<string, number>();
  for (const raw of industries) {
    for (const name of parseIndustries(raw)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([name]) => name);
}

/**
 * ある社の industry が、指定された業界チップに該当するか判定する。
 * その社の industry を「,」で分割した集合のいずれかが selected と一致したらヒット。
 */
export function matchesIndustry(
  industry: string | null | undefined,
  selected: string,
): boolean {
  return parseIndustries(industry).includes(selected);
}
