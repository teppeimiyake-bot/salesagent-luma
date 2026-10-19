/**
 * T17: 見積テンプレートAPIの共通処理（サーバー専用）
 *
 * route.ts からは Next のルートハンドラ以外の値を export できないため、
 * POST / PATCH で共有するバリデーションと変換をここに置く。
 */
import { z } from "zod";
import { prisma } from "@/lib/db";

export const templateLineSchema = z.object({
  name: z.string().trim().min(1),
  detail: z.string().nullable().optional(),
  qty: z.number().int().min(1).default(1),
  unit: z.string().trim().min(1).optional(),
  unitPrice: z.number().int().min(0).default(0),
  taxCategory: z.enum(["taxable", "non_taxable"]).default("taxable"),
  taxRate: z.number().int().min(0).max(100).default(10),
});

export type TemplateLineInput = z.infer<typeof templateLineSchema>;

export type TemplateLineData = {
  name: string;
  detail: string | null;
  qty: number;
  unit: string;
  unitPrice: number;
  taxCategory: string;
  taxRate: number;
  sortOrder: number;
};

/** 明細1行分の書き込みデータ（並び順は配列の添字で固定する） */
export function toTemplateLineData(l: TemplateLineInput, index: number): TemplateLineData {
  return {
    name: l.name.trim(),
    detail: l.detail?.trim() || null,
    qty: l.qty,
    unit: l.unit?.trim() || "式",
    unitPrice: l.unitPrice,
    taxCategory: l.taxCategory,
    taxRate: l.taxCategory === "non_taxable" ? 0 : l.taxRate,
    sortOrder: index,
  };
}

/** productId が実在しなかったことを表す番兵 */
export const INVALID_PRODUCT = Symbol("invalid-product");

/**
 * productId は FK が無い（スキーマ上ただの文字列）ため、存在しないIDを弾く。
 * null / 空文字 / 未指定はそのまま null（カテゴリ紐付けなしのテンプレート）。
 */
export async function resolveTemplateProductId(
  raw: string | null | undefined,
): Promise<string | null | typeof INVALID_PRODUCT> {
  const id = raw?.trim();
  if (!id) return null;
  const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
  return product ? product.id : INVALID_PRODUCT;
}
