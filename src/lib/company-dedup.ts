/**
 * 企業重複検出（マージ機能）の共通ロジック。
 * normalizeName / domainOf は prisma/scripts/dedup-survey.cjs の実証済みロジックを移植。
 */

/**
 * 社名正規化：株式会社/(株)/全半角/空白/記号/大小文字の揺れを吸収する。
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;
  // 全角英数 -> 半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
  s = s.replace(/　/g, " "); // 全角スペース
  // 法人格トークンを除去
  s = s.replace(/株式会社|（株）|\(株\)|㈱/g, "");
  s = s.replace(/有限会社|（有）|\(有\)|㈲/g, "");
  s = s.replace(/合同会社|（同）|\(同\)/g, "");
  s = s.replace(/一般社団法人|公益社団法人|社団法人/g, "");
  // 揺れやすい空白・記号を除去
  s = s.replace(/[\s・,.，。、'’"”\-‐－—_/／\\]/g, "");
  s = s.toLowerCase();
  return s.trim();
}

/**
 * URL からホスト名（ドメイン）を抽出。www. を除去。
 */
export function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  let s = url.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[\/?#]/)[0];
  return s;
}

/**
 * 企業の「情報充実度スコア」。値が埋まっているフィールド数 + 子データ件数で評価。
 * 統合先（surviving）のデフォルト選択に使う。
 */
export interface CompanyForScore {
  name?: string | null;
  industry?: string | null;
  websiteUrl?: string | null;
  websiteSummary?: string | null;
  note?: string | null;
  address?: string | null;
  ceoName?: string | null;
  establishedYear?: number | null;
  employeeCount?: number | null;
  capital?: string | null;
  phoneNumber?: string | null;
  logoUrl?: string | null;
  dealCount?: number;
  contactCount?: number;
}

export function richnessScore(c: CompanyForScore): number {
  let score = 0;
  // フィールド埋まり度（各1点）
  const fields: (string | number | null | undefined)[] = [
    c.industry,
    c.websiteUrl,
    c.websiteSummary,
    c.note,
    c.address,
    c.ceoName,
    c.establishedYear,
    c.employeeCount,
    c.capital,
    c.phoneNumber,
    c.logoUrl,
  ];
  for (const f of fields) {
    if (f !== null && f !== undefined && String(f).trim() !== "") score += 1;
  }
  // 子データは重み付け（商談=3点/件, 連絡先=1点/件）→ 実績がある企業を優先
  score += (c.dealCount ?? 0) * 3;
  score += (c.contactCount ?? 0) * 1;
  return score;
}

/**
 * Dismissed ペアのキー（companyId をソートして一意化）。
 */
export function dismissKey(a: string, b: string): { companyIdA: string; companyIdB: string } {
  return a < b
    ? { companyIdA: a, companyIdB: b }
    : { companyIdA: b, companyIdB: a };
}

/**
 * グループ内の全企業ペアが dismissed 済みかどうかを判定するためのキー集合を作る。
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}
