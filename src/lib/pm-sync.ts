/**
 * 受注 → PM（受注管理）の自動連携。
 *
 * 背景：
 *   ProductionProject は当初 scripts/backfill-production-projects.ts の一括生成だけで
 *   作られており、バックフィル後に受注へ変わった商材は PM 一覧に出てこなかった
 *   （例：岩泉町役場の映像。deal_products は「受注」なのに案件が無い）。
 *   バックフィルスクリプト自身の設計メモにも「本来は受注遷移時に hook で1件 upsert」と
 *   書かれていたので、ここで仕組み化する。
 *
 * 冪等性：
 *   ProductionProject.dealProductId は @unique。既にあれば何もしない。
 *
 * 初期ステータス：
 *   SNS は継続契約なので CONTRACTED（契約中）、それ以外は BEFORE_SHOOT（撮影前）。
 */
import type { Prisma } from "@prisma/client";
import type { prisma } from "@/lib/db";
import { isWonYomi } from "@/lib/yomi-status";
import { categoryFromDealProduct } from "@/lib/product-categories";

/** トランザクションでも通常クライアントでも受けられる最小型（payment-sync と同じ方針）。 */
type Db = typeof prisma | Prisma.TransactionClient;

export type PmSyncResult =
  | { created: true; productionProjectId: string }
  | { created: false; reason: "not_won" | "no_deal" | "already_exists" };

/**
 * プロジェクト名 = 受注した商談名（Deal.title）。
 * 空の場合のみ「企業名 ＋ カテゴリ ＋ プラン名」へフォールバック。
 * （backfill-production-projects.ts と同じ規則。変更時は両方そろえること）
 */
function buildProjectName(
  dealTitle: string | null | undefined,
  companyName: string | null | undefined,
  category: string | null,
  planName: string | null | undefined,
): string {
  const title = dealTitle?.trim();
  if (title) return title;
  const parts = [companyName, category, planName].filter((s): s is string => !!s);
  return parts.join(" ") || "無題プロジェクト";
}

/**
 * 指定 DealProduct が受注になったとき、PM案件（ProductionProject）を未作成なら1件作成する。
 *
 * @param db prisma クライアント（or トランザクションクライアント）
 * @param dealProductId 受注になった DealProduct の id
 */
export async function syncWonProductToPm(db: Db, dealProductId: string): Promise<PmSyncResult> {
  const dp = await db.dealProduct.findUnique({
    where: { id: dealProductId },
    select: {
      id: true,
      dealId: true,
      productName: true,
      planName: true,
      yomiStatus: true,
      product: { select: { name: true, category: true } },
      deal: {
        select: {
          id: true,
          title: true,
          deletedAt: true,
          companyId: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!dp || !dp.deal || dp.deal.deletedAt) return { created: false, reason: "no_deal" };
  if (!isWonYomi(dp.yomiStatus)) return { created: false, reason: "not_won" };

  const existing = await db.productionProject.findUnique({
    where: { dealProductId: dp.id },
    select: { id: true },
  });
  if (existing) return { created: false, reason: "already_exists" };

  const category = categoryFromDealProduct(dp);
  const created = await db.productionProject.create({
    data: {
      dealId: dp.dealId,
      dealProductId: dp.id,
      companyId: dp.deal.companyId ?? null,
      category,
      projectName: buildProjectName(dp.deal.title, dp.deal.company?.name, category, dp.planName),
      status: category === "SNS" ? "CONTRACTED" : "BEFORE_SHOOT",
    },
    select: { id: true },
  });

  return { created: true, productionProjectId: created.id };
}
