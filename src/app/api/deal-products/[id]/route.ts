import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { probabilityToYomi, YOMI_TO_PROBABILITY } from "@/lib/deal-aggregations";
import { getCurrentPermission, hasPermission, getSession } from "@/lib/auth";
import { stripYomiPrefix } from "@/lib/yomi-status";
import { generateContractDraft, isAPlusYomi } from "@/lib/contract-generate";
import { syncWonProductToPayments } from "@/lib/payment-sync";
import { syncWonProductToPm } from "@/lib/pm-sync";
import { isWonYomi } from "@/lib/yomi-status";

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

  // 契約書 自動生成トリガー判定用に、更新前の yomiStatus を控える。
  const before = await prisma.dealProduct.findUnique({
    where: { id },
    select: { yomiStatus: true },
  });
  const prevYomi = before?.yomiStatus ?? null;

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

  // ============================================================
  // 依頼1：受注 → 入金管理の自動連携。
  //   受注ステータス（プレフィックス付き含む isWonYomi）へ「遷移」した時、
  //   入金管理（スポット）レコードが未作成なら1件だけ自動作成する。
  //   - 遷移検知（before が受注でなく after が受注）に限定し、受注内の別更新では走らない。
  //   - 同じ会社が既に入金管理にあれば重複作成しない（syncWonProductToPayments 側で判定）。
  //   - 失敗は PATCH 本体の成否に影響させない（ログのみ）。
  // ============================================================
  let paymentSync: Awaited<ReturnType<typeof syncWonProductToPayments>> | null = null;
  // 受注遷移で PM（受注管理）にも案件を1件起票する。
  // これが無かったため、バックフィル後に受注になった商材が PM 一覧に出ていなかった。
  let pmSync: Awaited<ReturnType<typeof syncWonProductToPm>> | null = null;
  if (isWonYomi(updated.yomiStatus) && !isWonYomi(prevYomi)) {
    try {
      paymentSync = await syncWonProductToPayments(prisma, updated.id);
    } catch (e) {
      console.error("[deal-products PATCH] payment sync failed:", e);
    }
    try {
      pmSync = await syncWonProductToPm(prisma, updated.id);
    } catch (e) {
      console.error("[deal-products PATCH] pm sync failed:", e);
    }
  }

  // ============================================================
  // 機能②トリガー：yomiStatus が「A+ヨミ」へ遷移した時、契約書ドラフトを自動生成。
  //   - 遷移検知（before が A+ヨミでなく、after が A+ヨミ）に限定し、A+ヨミ内での
  //     別更新で毎回走らないようにする。
  //   - generateContractDraft 側で「既存ドラフトあればスキップ（重複生成防止）」。
  //   - 生成失敗は PATCH 本体の成否に影響させない（ログのみ）。レスポンスに結果を付与。
  // ============================================================
  let contractDraft: { generated: boolean; skipped: boolean; documentId?: string } | null = null;
  if (
    updated.yomiStatus !== undefined &&
    isAPlusYomi(updated.yomiStatus) &&
    !isAPlusYomi(prevYomi)
  ) {
    try {
      const session = await getSession();
      const res = await generateContractDraft(updated.id, session?.userId ?? null);
      if (res.ok) {
        contractDraft = { generated: !res.skipped, skipped: res.skipped, documentId: res.documentId };
      } else {
        console.warn("[deal-products PATCH] contract draft not generated:", res.reason);
      }
    } catch (e) {
      console.error("[deal-products PATCH] contract draft generation failed:", e);
    }
  }

  return NextResponse.json({ dealProduct: updated, contractDraft, paymentSync, pmSync });
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
