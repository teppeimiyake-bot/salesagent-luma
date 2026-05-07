export const YOMI_FILTER_VALUES = [
  "NG",
  "ネタ",
  "Cヨミ",
  "Bヨミ",
  "Aヨミ",
  "受注",
] as const;

export type YomiFilterValue = (typeof YOMI_FILTER_VALUES)[number];

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
