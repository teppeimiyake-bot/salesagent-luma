export const YOMI_FILTER_VALUES = [
  "NG",
  "ネタ",
  "Cヨミ",
  "Bヨミ",
  "Aヨミ",
  "受注",
] as const;

export type YomiFilterValue = (typeof YOMI_FILTER_VALUES)[number];

/**
 * 商談一覧 `/deals` のデフォルトヨミ選択。
 * - クエリ `?yomi=` が一切無い場合（サイドバーから直接遷移 / 初回アクセス等）に適用
 * - 「すべて」ボタン押下時もこの状態に戻る（完全全件ではない）
 * - 明示的に `?yomi=` を空で渡すと、当該クエリ無しと同じ扱い（=デフォルト4種）
 *   ※「完全全件」を見たい場合はNG/受注を含めて手動で選ぶ運用にする
 */
export const DEFAULT_YOMI_VALUES: YomiFilterValue[] = [
  "ネタ",
  "Cヨミ",
  "Bヨミ",
  "Aヨミ",
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
