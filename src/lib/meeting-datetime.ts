/**
 * 商談日時（T01）のJST変換ヘルパー（サーバー/クライアント共通）
 *
 * 設計メモ：
 *  - meetingStartAt / meetingEndAt は DB に timestamptz（=絶対時刻）で保存するが、
 *    業務上の見え方は常に JST。ブラウザやサーバーのタイムゾーン設定に依存させると
 *    サーバー描画とクライアント描画で値がズレる（hydration mismatch）ため、
 *    表示・入力の変換は必ず +09:00 固定で行う。
 *  - 既存 ms管理（ms-deal-row.tsx）の日付運用も `T00:00:00+09:00` 前提のため、
 *    meetingScheduledAt への同期もこの規約に合わせる。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date/ISO文字列 → datetime入力用の JST "YYYY-MM-DDTHH:mm"（null は ""） */
export function toJstDateTimeInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  const h = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day}T${h}:${mi}`;
}

/** datetime入力の JST "YYYY-MM-DDTHH:mm" → ISO文字列（"" は null） */
export function jstDateTimeInputToIso(s: string): string | null {
  if (!s) return null;
  const d = new Date(`${s}:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Date/ISO文字列 → JST の "YYYY-MM-DD"（null は ""） */
export function toJstDateStr(d: Date | string | null | undefined): string {
  return toJstDateTimeInput(d).slice(0, 10);
}

/**
 * 商談開始日時 → meetingScheduledAt（商談予定日・date-only運用）に同期する値。
 * ms管理の `dateStrToIso()` と同じ「JST 0:00 の瞬間」を返し、既存画面の表示規約を崩さない。
 */
export function meetingScheduledAtFromStart(start: Date | string | null | undefined): Date | null {
  const dateStr = toJstDateStr(start);
  if (!dateStr) return null;
  return new Date(`${dateStr}T00:00:00+09:00`);
}

/** 終了が開始より前（＝入力ミス）かどうか。どちらかが空なら false */
export function isEndBeforeStart(startIso: string | null, endIso: string | null): boolean {
  if (!startIso || !endIso) return false;
  return new Date(endIso).getTime() < new Date(startIso).getTime();
}

/**
 * 商談日時を1行の表示文字列にする（T15の要約表示用）。
 *
 * サーバー描画とクライアント描画で値がズレないよう、ここでも +09:00 固定で組み立てる
 * （`toLocaleString` はサーバーのTZ設定に引きずられるため使わない）。
 *
 * 例： "2026/08/28（金） 14:00–15:00"／終了未設定なら "2026/08/28（金） 14:00〜"
 */
const JST_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function formatJstMeetingRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): string | null {
  const s = toJstDateTimeInput(start);
  if (!s) return null;
  const [sDate, sTime] = s.split("T");
  const [y, mo, d] = sDate.split("-");
  // 曜日は「JSTの暦日の0:00」をUTCとして解釈して求める（TZ非依存）
  const weekday = JST_WEEKDAYS[new Date(`${sDate}T00:00:00Z`).getUTCDay()];
  const head = `${y}/${mo}/${d}（${weekday}） ${sTime}`;

  const e = toJstDateTimeInput(end);
  if (!e) return `${head}〜`;
  const [eDate, eTime] = e.split("T");
  // 日をまたぐ商談は終了側も日付から書く
  return eDate === sDate ? `${head}–${eTime}` : `${head}–${eDate.replace(/-/g, "/")} ${eTime}`;
}
