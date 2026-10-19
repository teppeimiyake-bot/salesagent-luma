/**
 * 期日（due date）まわりの純粋関数。
 *
 * React やクライアント API に依存しないため、
 * サーバーコンポーネント・クライアントコンポーネントの双方から安全に import できる。
 * （"use client" を付けないこと）
 *
 * 日付の区切りは常に JST（+09:00 固定）。サーバー（Cloud Run は UTC）とブラウザ（JST）で
 * 暦日がズレると表示文字列が変わり hydration mismatch（React #418）になるため、
 * 実行環境のタイムゾーン（setHours / getDate 等）には依存させない。
 * 規約は src/lib/meeting-datetime.ts と同じ。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 任意の日付値を「JST の暦日番号」（1970-01-01 JST を 0 とする通し日数）に正規化する。
 * 不正な値・null の場合は null を返す。
 */
function jstDayNumber(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  const time = dt.getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((time + JST_OFFSET_MS) / DAY_MS);
}

/**
 * 今日（JST の暦日）を基準にした、対象日までの日数差を返す。
 * - 負: 期限超過 / 0: 今日 / 正: 未来
 * - 不正値・null の場合は null。
 * - now は基準時刻（省略時は現在時刻。テスト用に差し替え可能）。
 */
export function daysUntil(
  d: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  const target = jstDayNumber(d);
  const today = jstDayNumber(now);
  if (target === null || today === null) return null;
  return target - today;
}

/**
 * 期日（nextActionAt 等）の状態を判定する。
 * - "overdue": 今日より過去（期限超過）
 * - "today":   今日が期日
 * - "future":  今日より先 / 期日未設定
 */
export function dueState(
  d: Date | string | null | undefined,
  now?: Date,
): "overdue" | "today" | "future" {
  const diff = daysUntil(d, now);
  if (diff === null) return "future";
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "future";
}

/**
 * 日付値 → JST の暦日での "M/D"（期日バッジの補足表示用。ゼロ埋めなし）。
 * 例: 2026-08-10T15:00:00Z（= JST 8/11 0:00）→ "8/11"
 */
export function jstMonthDayLabel(d: Date | string): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  const jst = new Date(dt.getTime() + JST_OFFSET_MS);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

/**
 * <input type="date"> の "YYYY-MM-DD" → その日の JST 0:00 を表す ISO 文字列（期日の保存用）。
 * 例: "2026-08-11" → "2026-08-10T15:00:00.000Z"
 * - ブラウザのタイムゾーンに依存させない（+09:00 固定。ms-deal-row の dateStrToIso と同じ形）。
 * - 空文字・形式不正・存在しない日付（2026-02-30 等）は null。
 *   空文字（期日クリア）との区別は呼び出し側で行うこと。
 */
export function jstDateInputToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const dt = new Date(`${v}T00:00:00+09:00`);
  const time = dt.getTime();
  if (Number.isNaN(time)) return null;
  // Date は 2026-02-30 を 3/2 に繰り上げるため、JST の暦日に戻して一致を確かめる
  if (new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10) !== v) return null;
  return dt.toISOString();
}
