import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { suggestQuoteAmount } from "@/lib/quote-suggest";
import { prisma } from "@/lib/db";
import { categoryFromDealProduct } from "@/lib/product-categories";

/**
 * POST /api/quotes/suggest
 * DealProduct を起点に、過去実績中央値→basePrice の見積金額サジェストを返す。
 *   body: { dealProductId } もしくは { category, planName, planProposals, productId }
 */
const schema = z.object({
  dealProductId: z.string().uuid().optional(),
  category: z.enum(["映像", "SNS", "CATV", "アライアンス"]).nullable().optional(),
  planName: z.string().nullable().optional(),
  planProposals: z.array(z.string()).optional(),
  productId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.dealProductId) {
    const dp = await prisma.dealProduct.findUnique({
      where: { id: parsed.data.dealProductId },
      include: { product: { select: { name: true, category: true } } },
    });
    if (!dp) return NextResponse.json({ error: "DealProduct not found" }, { status: 404 });
    const category = categoryFromDealProduct(dp);
    const result = await suggestQuoteAmount({
      category,
      planName: dp.planName,
      planProposals: dp.planProposals,
      productId: dp.productId,
    });
    return NextResponse.json({ ...result, category });
  }

  const result = await suggestQuoteAmount({
    category: parsed.data.category ?? null,
    planName: parsed.data.planName,
    planProposals: parsed.data.planProposals,
    productId: parsed.data.productId,
  });
  return NextResponse.json(result);
}
