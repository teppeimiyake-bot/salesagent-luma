import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { probabilityToYomi, YOMI_TO_PROBABILITY } from "@/lib/deal-aggregations";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { stripYomiPrefix } from "@/lib/yomi-status";

const updateSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  productName: z.string().min(1).optional(),
  planName: z.string().nullable().optional(),
  planProposals: z.array(z.string().min(1)).optional(),
  probability: z.number().int().min(0).max(100).optional(),
  amount: z.number().int().nullable().optional(),
  yomiStatus: z.string().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});

/**
 * yomiStatus（接頭辞付き含む）から確度% を引く。
 * 例: 「【映像】Aヨミ」→ 70 / 「Cヨミ」→ 30 / 「締結済み」→ 100 / 不明 → null
 */
function probabilityFromYomi(yomi: string | null | undefined): number | null {
  if (!yomi) return null;
  const stripped = stripYomiPrefix(yomi);
  if (!stripped) return null;
  if (stripped === "締結済み") return 100;
  if (stripped in YOMI_TO_PROBABILITY) return YOMI_TO_PROBABILITY[stripped];
  return null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // 社長判断（パターンB）：
  //   - yomiStatus が変更される && リクエストに probability が含まれていない場合、
  //     YOMI_TO_PROBABILITY 由来の値で probability を自動上書きする
  //   - リクエストに probability が含まれている場合は手入力を尊重（自動上書きしない）
  // フラグ列は持たない。どの値も「現時点の有効値」として一視同仁に扱う。
  let probability = data.probability;
  let yomiStatus = data.yomiStatus;
  if (yomiStatus !== undefined && data.probability === undefined) {
    const auto = probabilityFromYomi(yomiStatus);
    if (auto != null) probability = auto;
  }
  // probability だけ更新時、yomiStatus も逆引きで合わせる（手入力UIサポート用、既存動作維持）
  if (data.probability != null && yomiStatus === undefined) {
    yomiStatus = probabilityToYomi(data.probability);
  }

  const updated = await prisma.dealProduct.update({
    where: { id },
    data: {
      productId: data.productId,
      productName: data.productName,
      planName: data.planName,
      ...(data.planProposals !== undefined ? { planProposals: data.planProposals } : {}),
      probability,
      amount: data.amount,
      yomiStatus,
      ownerUserId: data.ownerUserId,
      notes: data.notes,
    },
    include: {
      owner: { select: { id: true, name: true, avatarColor: true } },
      product: { select: { id: true, name: true } },
    },
  });

  // 自動セット：yomiStatus を「受注」に変更し、親Dealにまだ contractDate が無い場合は本日付をセット。
  // KPI実績は contractDate ベースで集計するため、運用負荷を下げるためのデフォルト動作。
  // ユーザーが商談詳細で contractDate を手動編集すれば上書きされる。
  if (yomiStatus === "受注") {
    const parent = await prisma.deal.findUnique({
      where: { id: updated.dealId },
      select: { contractDate: true },
    });
    if (parent && !parent.contractDate) {
      await prisma.deal.update({
        where: { id: updated.dealId },
        data: { contractDate: new Date() },
      });
    }
  }

  return NextResponse.json({ dealProduct: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  await prisma.dealProduct.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
