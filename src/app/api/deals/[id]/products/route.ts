import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { probabilityToYomi, YOMI_TO_PROBABILITY } from "@/lib/deal-aggregations";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { stripYomiPrefix, isWonYomi } from "@/lib/yomi-status";
import { syncWonProductToPayments } from "@/lib/payment-sync";

/**
 * yomiStatus（接頭辞付き含む）から確度% を引く。不明なら null。
 */
function probabilityFromYomi(yomi: string | null | undefined): number | null {
  if (!yomi) return null;
  const stripped = stripYomiPrefix(yomi);
  if (stripped === "締結済み") return 100;
  if (stripped && stripped in YOMI_TO_PROBABILITY) return YOMI_TO_PROBABILITY[stripped];
  return null;
}

/**
 * POST /api/deals/[id]/products
 * Deal にプロダクトを追加
 */
const createSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  productName: z.string().min(1),
  planName: z.string().nullable().optional(),
  planProposals: z.array(z.string().min(1)).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  amount: z.number().int().nullable().optional(),
  yomiStatus: z.string().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id: dealId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, deletedAt: true },
  });
  if (!deal || deal.deletedAt) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }
  const finalYomi =
    data.yomiStatus ??
    (data.probability != null ? probabilityToYomi(data.probability) : null);

  // 社長判断（パターンB）：
  //   新規作成時、yomiStatus が指定されていて probability がリクエスト未指定なら、
  //   YOMI_TO_PROBABILITY 由来の値で確度を自動セット。
  //   probability がリクエストに含まれていれば手入力を尊重。
  let finalProbability = data.probability;
  if (finalProbability === undefined) {
    const auto = probabilityFromYomi(finalYomi);
    finalProbability = auto ?? 0;
  }

  const created = await prisma.dealProduct.create({
    data: {
      dealId,
      productId: data.productId ?? null,
      productName: data.productName,
      planName: data.planName ?? null,
      planProposals: data.planProposals ?? [],
      probability: finalProbability,
      amount: data.amount ?? null,
      yomiStatus: finalYomi,
      ownerUserId: data.ownerUserId ?? null,
      notes: data.notes ?? null,
    },
    include: {
      owner: { select: { id: true, name: true, avatarColor: true } },
      product: { select: { id: true, name: true } },
    },
  });

  // 自動セット：新規追加が「受注」なら、親Dealに contractDate が無ければ本日付
  if (finalYomi === "受注") {
    const parent = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { contractDate: true },
    });
    if (parent && !parent.contractDate) {
      await prisma.deal.update({
        where: { id: dealId },
        data: { contractDate: new Date() },
      });
    }
  }

  // 依頼1：受注プロダクトとして新規追加された場合も、入金管理（スポット）へ自動連携。
  //   同じ会社が既に入金管理にあれば重複作成しない（sync 側で判定）。失敗はログのみ。
  let paymentSync: Awaited<ReturnType<typeof syncWonProductToPayments>> | null = null;
  if (isWonYomi(created.yomiStatus)) {
    try {
      paymentSync = await syncWonProductToPayments(prisma, created.id);
    } catch (e) {
      console.error("[deals/products POST] payment sync failed:", e);
    }
  }

  return NextResponse.json({ dealProduct: created, paymentSync });
}
