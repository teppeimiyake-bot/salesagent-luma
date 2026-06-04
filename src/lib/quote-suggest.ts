/**
 * 見積金額サジェスト（機能①）。
 *
 * 同一 商材カテゴリ × プラン × 企画案 の過去 DealProduct.amount 実績の中央値を返す。
 * フォールバック：該当 ProductPlan.basePrice。どちらも無ければ null。
 *
 * カテゴリは categoryFromDealProduct（yomi接頭辞 / productName から判定）を用いる。
 */
import { prisma } from "@/lib/db";
import { categoryFromDealProduct, type ProductCategory } from "@/lib/product-categories";

function median(nums: number[]): number | null {
  const arr = nums.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? Math.round((arr[mid - 1] + arr[mid]) / 2) : arr[mid];
}

export interface SuggestInput {
  category: ProductCategory | null;
  planName?: string | null;
  planProposals?: string[];
  productId?: string | null;
}

export interface SuggestResult {
  /** サジェスト金額（税抜・円）。null = 実績もbasePriceも無し */
  amount: number | null;
  /** 算出根拠 */
  source: "median" | "basePrice" | "none";
  /** median 算出に使った実績件数 */
  sampleSize: number;
}

/**
 * 過去実績の中央値 → ProductPlan.basePrice の順でサジェスト金額を返す。
 */
export async function suggestQuoteAmount(input: SuggestInput): Promise<SuggestResult> {
  const { category, planName, planProposals, productId } = input;

  // 実績集計：amount が入っている DealProduct を広めに取り、JS側でカテゴリ・プラン・企画案で絞る。
  const candidates = await prisma.dealProduct.findMany({
    where: {
      amount: { not: null, gt: 0 },
      ...(planName ? { planName } : {}),
    },
    select: {
      amount: true,
      planName: true,
      planProposals: true,
      yomiStatus: true,
      productName: true,
      product: { select: { name: true, category: true } },
    },
    take: 500,
  });

  const proposalSet = new Set((planProposals ?? []).filter(Boolean));
  const matched = candidates.filter((c) => {
    if (category) {
      const cat = categoryFromDealProduct(c);
      if (cat !== category) return false;
    }
    if (planName && c.planName !== planName) return false;
    // 企画案：指定があれば「共通の企画案を1つ以上含む」ものに限定
    if (proposalSet.size > 0) {
      const has = (c.planProposals ?? []).some((p) => proposalSet.has(p));
      if (!has) return false;
    }
    return true;
  });

  const med = median(matched.map((c) => c.amount as number));
  if (med != null) {
    return { amount: med, source: "median", sampleSize: matched.length };
  }

  // フォールバック：ProductPlan.basePrice
  if (productId && planName) {
    const plan = await prisma.productPlan.findFirst({
      where: { productId, name: planName, active: true },
      select: { basePrice: true },
    });
    if (plan?.basePrice && plan.basePrice > 0) {
      return { amount: plan.basePrice, source: "basePrice", sampleSize: 0 };
    }
  }

  return { amount: null, source: "none", sampleSize: 0 };
}
