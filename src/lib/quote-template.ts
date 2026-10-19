/**
 * T17: 見積テンプレート ⇄ 見積明細の変換（純関数）
 *
 * テンプレート明細（QuoteTemplateLine）には id / templateId / tenantId / sortOrder という
 * 「テンプレート側の都合」のフィールドが付いている。これを見積フォームへそのまま
 * スプレッドすると、見積の POST/PATCH に余計なキーが混ざる＝バリデーション事故のもとになる。
 * ここで落とすフィールドを一箇所に固定しておく。
 */

import type { CalculableQuoteLine, QuoteTaxCategory } from "@/lib/quote-calculation";

/** テンプレート明細（APIから返る形。余計なフィールドが付いていてよい） */
export type TemplateLineLike = {
  id?: string;
  templateId?: string;
  tenantId?: string;
  sortOrder?: number;
  name: string;
  detail?: string | null;
  qty?: number | null;
  unit?: string | null;
  unitPrice?: number | null;
  taxCategory?: string | null;
  taxRate?: number | null;
};

/** 見積明細（フォーム／APIが受け取る形） */
export type QuoteLineDraft = {
  name: string;
  detail: string | null;
  qty: number;
  unit: string;
  unitPrice: number;
  taxCategory: QuoteTaxCategory;
  taxRate: number;
};

function toTaxCategory(value: string | null | undefined): QuoteTaxCategory {
  return value === "non_taxable" ? "non_taxable" : "taxable";
}

/**
 * テンプレート明細を見積明細へ変換する。
 * - id / templateId / tenantId / sortOrder は落とす（並び順は配列の順序で表現する）
 * - name / detail / qty / unit / unitPrice / taxCategory / taxRate は保持する
 * - 不課税行の税率は 0 に寄せる（calculateQuote と同じ扱いにするため）
 */
export function templateLinesToQuoteLines(lines: TemplateLineLike[]): QuoteLineDraft[] {
  return lines.map((line) => {
    const taxCategory = toTaxCategory(line.taxCategory);
    const qty = Number.isInteger(line.qty) && (line.qty as number) > 0 ? (line.qty as number) : 1;
    const unitPrice =
      Number.isInteger(line.unitPrice) && (line.unitPrice as number) >= 0 ? (line.unitPrice as number) : 0;
    const taxRate =
      taxCategory === "non_taxable"
        ? 0
        : Number.isInteger(line.taxRate) && (line.taxRate as number) >= 0
          ? (line.taxRate as number)
          : 10;
    return {
      name: line.name,
      detail: line.detail ?? null,
      qty,
      unit: (line.unit ?? "").trim() || "式",
      unitPrice,
      taxCategory,
      taxRate,
    };
  });
}

/** 変換結果はそのまま calculateQuote / validateQuoteLines に渡せる。 */
export function toCalculableLines(lines: QuoteLineDraft[]): CalculableQuoteLine[] {
  return lines;
}

/** 明細に人が入力した内容が入っているか（テンプレート適用前の確認に使う） */
export function hasUserEnteredLines(
  lines: Array<{ name: string; unitPrice: number }>,
): boolean {
  return lines.some((line) => line.name.trim() !== "" || line.unitPrice !== 0);
}
