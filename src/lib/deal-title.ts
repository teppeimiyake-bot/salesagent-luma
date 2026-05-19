/**
 * 商談タイトル自動生成ロジック（サーバー/クライアント共通）
 *
 * フォーマット：「商談日(YYYY/MM/DD) 会社名 担当者名」
 *  - 商談日 = Deal.appointmentDate（初回商談日）
 *  - 会社名 = Company.name
 *  - 担当者名 = Deal.owner.name（自社の営業担当。顧客側 Contact ではない）
 *
 * 設計メモ：
 *  - appointmentDate は DB に UTC で保存されるが、業務上は JST の暦日が正。
 *    UTC のまま日付を取り出すと JST 0:00〜8:59 のデータが前日にずれるため、
 *    必ず JST(+09:00) に変換してから年月日を取り出す。
 *  - 区切りはスペース（new-deal-dialog の既存プレビュー実装と一致）。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date を JST の YYYY/MM/DD 文字列にする */
export function formatAppointmentDateJST(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const jst = new Date(date.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/**
 * 商談タイトルを「商談日 会社名 担当者名」で生成する。
 *  - appointmentDate が無い場合は日付パートを省略
 *  - companyName が無い場合は null を返す（呼び出し側で従来タイトルを維持）
 */
export function buildDealTitle(input: {
  appointmentDate: Date | string | null | undefined;
  companyName: string | null | undefined;
  ownerName: string | null | undefined;
}): string | null {
  const company = input.companyName?.trim();
  if (!company) return null;

  const parts: string[] = [];
  if (input.appointmentDate) {
    parts.push(formatAppointmentDateJST(input.appointmentDate));
  }
  parts.push(company);
  const owner = input.ownerName?.trim();
  if (owner) parts.push(owner);

  return parts.join(" ");
}
