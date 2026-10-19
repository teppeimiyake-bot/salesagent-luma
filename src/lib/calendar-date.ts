/**
 * 日付だけの値（受注計上日など）と、KPI の月・週への振り分けに使う日本時間の暦日。
 *
 * 保存：入力した暦日の UTC 0:00（例: 2026-10-01 → 2026-10-01T00:00:00.000Z）。商談画面の日付欄・「本日でセット」・
 * 受注時の自動設定・KPI 画面の編集欄はこの形で保存する。
 * 集計・表示：保存された時刻を日本時間の暦日として読む。以前の保存形式（日本時間 0:00 ＝前日の UTC 15:00、
 * 受注した時刻そのもの）も同じ暦日になるので、既存のデータを書き換えずに月・週へ振り分けられる。
 * 実行環境のタイムゾーンに依存しない（サーバーは UTC、ブラウザは日本時間でも同じ結果）。
 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日本時間の暦日（年・月・日）。 */
export function jstCalendarParts(date: Date): { year: number; month: number; day: number } {
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  return { year: jst.getUTCFullYear(), month: jst.getUTCMonth() + 1, day: jst.getUTCDate() };
}

/** 日本時間の暦日の "YYYY-MM-DD"。 */
export function jstYmd(date: Date): string {
  const { year, month, day } = jstCalendarParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" に日数を足した "YYYY-MM-DD"（暦日の計算。タイムゾーンに依存しない）。 */
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 入力された暦日 "YYYY-MM-DD" を保存する値（その日の UTC 0:00 の ISO）にする。存在しない日付は null。 */
export function dateOnlyInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}
