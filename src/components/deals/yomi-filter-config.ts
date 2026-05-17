/**
 * 商談一覧 `/deals` のヨミフィルタ設定。
 *
 * ヨミ（受注確度）は7段階の独立した区分（deal-aggregations.ts の YOMI_OPTIONS と整合）：
 *   受注(100%) / A+ヨミ(90%) / Aヨミ(70%) / Bヨミ(50%) / Cヨミ(30%) / ネタ(10%) / NG(0%)
 * 「A+ヨミ」は独立した1区分であり、複数区分をまとめるショートカットではない。
 *
 * 並び順は確度の低い順（NG → 受注）に揃える。
 */
export const YOMI_FILTER_VALUES = [
  "NG",
  "ネタ",
  "Cヨミ",
  "Bヨミ",
  "Aヨミ",
  "A+ヨミ",
  "受注",
] as const;

export type YomiFilterValue = (typeof YOMI_FILTER_VALUES)[number];

/**
 * 商談一覧 `/deals` のデフォルトヨミ選択。
 * - クエリ `?yomi=` が一切無い場合（サイドバーから直接遷移 / 初回アクセス等）に適用
 * - 受注確度の高い案件（A+ヨミ/Aヨミ/Bヨミ/Cヨミ）にフォーカスする運用
 * - 「ネタ」「NG」「受注」は初期表示から外す（手動で各バッジをクリックすれば追加できる）
 * - 明示的に `?yomi=` を空で渡すと、当該クエリ無しと同じ扱い（= このデフォルト4種）
 */
export const DEFAULT_YOMI_VALUES: YomiFilterValue[] = [
  "A+ヨミ",
  "Aヨミ",
  "Bヨミ",
  "Cヨミ",
];

export function expandYomiValues(values: YomiFilterValue[]): string[] {
  const prefixes = ["", "【映像】", "【SNS】", "【CATV】"];
  const expanded = new Set<string>();
  for (const v of values) {
    for (const pre of prefixes) {
      expanded.add(`${pre}${v}`);
    }
  }
  return Array.from(expanded);
}
