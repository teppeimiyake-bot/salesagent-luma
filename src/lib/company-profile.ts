/**
 * 差出人（乙）会社プロファイル — 見積書・契約書PDFの全箇所で参照する単一の真実。
 *
 * 社長確定（2026-06-04 / docs/templates/QUOTE_CONTRACT_SPEC.md）：
 *   見積・契約とも下記「株式会社Luma／代表取締役 三宅 哲平」表記で統一する。
 *   見積実例の「合同会社／代表社員CEO」表記は使わない。
 *
 * 法人格について（auto-memory: project_luma_company_info）：
 *   2026年5〜6月に合同会社→株式会社へ移行中。本ツールの発行物は社長指定どおり
 *   「株式会社Luma」で出力する。表記を変える必要が出たらここだけ直せば全PDFに反映される。
 */
export const LUMA_COMPANY = {
  /** 社名 */
  name: "株式会社Luma",
  /** 代表者 役職＋氏名（PDF表示用、全角スペース区切り） */
  representative: "代表取締役　三宅　哲平",
  /** 代表者 氏名のみ（押印欄など） */
  representativeName: "三宅　哲平",
  /** 本店住所（契約書・見積書共通の差出人住所） */
  address: "東京都豊島区東池袋２－７－３",
  /** 契約書の押印欄で使う住所（ビル名込み・契約テンプレ準拠） */
  contractAddress: "東京都豊島区東池袋2-7-3 柄澤ビル3F",
} as const;

export type LumaCompany = typeof LUMA_COMPANY;
