/**
 * 期日（due date）まわりの純粋関数。
 *
 * React やクライアント API に依存しないため、
 * サーバーコンポーネント・クライアントコンポーネントの双方から安全に import できる。
 * （"use client" を付けないこと）
 */

/**
 * 任意の日付値を「日付のみ（ローカル0時）」の Date に正規化する。
 * 不正な値・null の場合は null を返す。
 */
function normalizeToDay(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return null;
  const day = new Date(dt);
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * 今日（ローカル0時）を基準にした、対象日までの日数差を返す。
 * - 負: 期限超過 / 0: 今日 / 正: 未来
 * - 不正値・null の場合は null。
 */
export function daysUntil(d: Date | string | null | undefined): number | null {
  const target = normalizeToDay(d);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 期日（nextActionAt 等）の状態を判定する。
 * - "overdue": 今日より過去（期限超過）
 * - "today":   今日が期日
 * - "future":  今日より先 / 期日未設定
 */
export function dueState(d: Date | string | null | undefined): "overdue" | "today" | "future" {
  const diff = daysUntil(d);
  if (diff === null) return "future";
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "future";
}
