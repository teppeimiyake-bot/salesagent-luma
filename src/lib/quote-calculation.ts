export type QuoteTaxCategory = "taxable" | "non_taxable";

export interface CalculableQuoteLine {
  name: string;
  detail?: string | null;
  qty: number;
  unitPrice: number;
  unit: string;
  taxCategory: QuoteTaxCategory;
  taxRate: number;
}

export interface QuoteTaxGroup {
  taxCategory: QuoteTaxCategory;
  taxRate: number;
  base: number;
  tax: number;
}

export interface QuoteTotals {
  subtotal: number;
  taxableBase: number;
  nonTaxableBase: number;
  taxTotal: number;
  grandTotal: number;
  groups: QuoteTaxGroup[];
}

export function lineAmount(line: Pick<CalculableQuoteLine, "qty" | "unitPrice">): number {
  return Math.round(line.qty * line.unitPrice);
}

/** T14 §7: 税率・税区分ごとに円未満を切り捨て、サーバー計算を正とする。 */
export function calculateQuote(lines: CalculableQuoteLine[]): QuoteTotals {
  const grouped = new Map<string, QuoteTaxGroup>();
  let subtotal = 0;

  for (const line of lines) {
    const amount = lineAmount(line);
    subtotal += amount;
    const taxRate = line.taxCategory === "non_taxable" ? 0 : line.taxRate;
    const key = `${line.taxCategory}:${taxRate}`;
    const group = grouped.get(key) ?? {
      taxCategory: line.taxCategory,
      taxRate,
      base: 0,
      tax: 0,
    };
    group.base += amount;
    grouped.set(key, group);
  }

  const groups = [...grouped.values()]
    .map((group) => ({
      ...group,
      tax: group.taxCategory === "taxable" ? Math.floor((group.base * group.taxRate) / 100) : 0,
    }))
    .sort((a, b) => b.taxRate - a.taxRate || a.taxCategory.localeCompare(b.taxCategory));
  const taxableBase = groups
    .filter((group) => group.taxCategory === "taxable")
    .reduce((sum, group) => sum + group.base, 0);
  const nonTaxableBase = groups
    .filter((group) => group.taxCategory === "non_taxable")
    .reduce((sum, group) => sum + group.base, 0);
  const taxTotal = groups.reduce((sum, group) => sum + group.tax, 0);

  return { subtotal, taxableBase, nonTaxableBase, taxTotal, grandTotal: subtotal + taxTotal, groups };
}

export function validateQuoteLines(lines: CalculableQuoteLine[]): string | null {
  if (lines.length === 0) return "明細を1行以上入力してください";
  for (const [index, line] of lines.entries()) {
    const label = `明細${index + 1}`;
    if (!line.name.trim()) return `${label}の品目を入力してください`;
    if (!Number.isInteger(line.qty) || line.qty <= 0) return `${label}の数量は1以上の整数にしてください`;
    if (!Number.isInteger(line.unitPrice) || line.unitPrice < 0) return `${label}の単価は0以上の整数にしてください`;
    if (!line.unit.trim()) return `${label}の単位を入力してください`;
    if (line.taxCategory !== "taxable" && line.taxCategory !== "non_taxable") {
      return `${label}の税区分を選択してください`;
    }
    if (!Number.isInteger(line.taxRate) || line.taxRate < 0 || line.taxRate > 100) {
      return `${label}の税率が不正です`;
    }
  }
  return null;
}

export function normalizeHonorific(clientName: string, honorific: string): { clientName: string; honorific: string } {
  const cleanHonorific = honorific === "様" ? "様" : "御中";
  const suffixPattern = /(?:御中|様)\s*$/;
  return { clientName: clientName.trim().replace(suffixPattern, "").trim(), honorific: cleanHonorific };
}

export function formatJstDate(value: Date | string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
