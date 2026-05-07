/**
 * yomiStatus（DealProduct.yomiStatus）の表示整形・判定ヘルパー
 *
 * 背景：
 *   Notion由来の yomiStatus は4種カテゴリのプレフィックスが付くものと付かないものがある。
 *     【映像】Cヨミ / 【映像】NG / 【映像】受注 / 【映像】ネタ / ...
 *     【SNS】Cヨミ / 【SNS】NG / 【SNS】受注 / 【SNS】ネタ / ...
 *     【CATV】Cヨミ / 【CATV】NG / 【CATV】受注 / 【CATV】ネタ / ...
 *     アライアンスはプレフィックスなし: "Cヨミ" "ネタ" "NG" "Bヨミ" "Aヨミ" "締結済み"
 *
 *   UI表示時はプロダクトカテゴリは別カラムに出ているのでプレフィックスは冗長。
 *   このヘルパーは表示用にプレフィックスを除去する。
 *
 * 2026-05 社長判断：
 *   import-luma-yomi.ts は現状維持（プレフィックス付きで取り込む）。
 *   DBには元の表記を保存し、UI表示でのみ整形する方針。
 */

const KNOWN_PREFIXES = ["映像", "SNS", "CATV"] as const;

/**
 * yomiStatus からカテゴリプレフィックス（【XXX】）を除去した「素のヨミ」を返す
 *   "【映像】Cヨミ" → "Cヨミ"
 *   "【SNS】NG"   → "NG"
 *   "Cヨミ"        → "Cヨミ"（アライアンスは元々プレフィックス無し）
 *   null/空        → そのまま
 */
export function stripYomiPrefix(yomi: string | null | undefined): string | null {
  if (!yomi) return yomi ?? null;
  const m = /^【([^】]+)】(.+)$/.exec(yomi);
  if (m && KNOWN_PREFIXES.includes(m[1] as typeof KNOWN_PREFIXES[number])) {
    return m[2];
  }
  return yomi;
}

/**
 * yomiStatus の "NG/失注" 系判定（部分一致）
 *   "【映像】NG" → true
 *   "【SNS】NG"  → true
 *   "NG"         → true
 *   "失注"       → true
 *   それ以外     → false
 */
export function isNgYomi(yomi: string | null | undefined): boolean {
  if (!yomi) return false;
  const bare = stripYomiPrefix(yomi);
  if (!bare) return false;
  return /NG|失注/.test(bare);
}

/**
 * 受注系判定
 *   "【映像】受注" → true
 *   "受注"         → true
 *   "締結済み"     → true
 */
export function isWonYomi(yomi: string | null | undefined): boolean {
  if (!yomi) return false;
  const bare = stripYomiPrefix(yomi);
  if (!bare) return false;
  return /受注|締結済み/.test(bare);
}
