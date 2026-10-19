/**
 * 機能フラグ（サーバー専用）
 *
 * 先方（Luma）の運用に影響を出さないため、エンハンス機能は既定OFFで入れ、
 * 検証が済んだ環境から環境変数でONにする。
 * 参照：実装計画_録音・商談履歴作成.html §7「フラグOFF時は完全に現状どおり」
 *
 * 使い方：サーバーコンポーネント／APIルートで判定し、結果を props で渡す。
 * （クライアントから process.env を直接読むと NEXT_PUBLIC_ が必要になるため、
 *   サーバー側で解決する方式にしている）
 */

function isOn(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * FEATURE_MEET：商談日時（T01）／Google Meet自動発行（T02）まわりのUI。
 * OFF の間は商談詳細に商談日時の入力欄を出さない＝現行画面のまま。
 */
export function isMeetFeatureEnabled(): boolean {
  return isOn(process.env.FEATURE_MEET);
}

export function isAutoBantFeatureEnabled(): boolean {
  return isOn(process.env.FEATURE_AUTO_BANT);
}

export function isPreparationV2Enabled(): boolean {
  return isOn(process.env.FEATURE_PREPARATION_V2);
}

export function isPreparationCronEnabled(): boolean {
  return isOn(process.env.FEATURE_PREPARATION_CRON);
}

/**
 * FEATURE_MEET_AUTO_RECORD：Meetの自動録画・自動文字起こしと成果物の自動取り込み（T16）。
 * OFF の間は商談詳細に何も足さず、録音は従来どおりブラウザ録音のまま＝現行画面のまま。
 */
export function isMeetAutoRecordEnabled(): boolean {
  return isOn(process.env.FEATURE_MEET_AUTO_RECORD);
}

/** T14: サンプル準拠の見積書UI・計算・発行フロー。既定OFF。 */
export function isQuotePdfV2Enabled(): boolean {
  return isOn(process.env.FEATURE_QUOTE_PDF_V2);
}
