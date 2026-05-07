/**
 * Deal の Next Action / ToDo 除外サーバヘルパー（prisma利用・サーバ専用）
 *
 * クライアントコンポーネントからは絶対に import しないこと。
 * 純粋判定（statusColor / isExcludedFromNextAction 等）は `@/lib/deal-status` を使う。
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

/**
 * 「完全失注」の Deal ID 一覧を返す。
 *   完全失注 = 全 DealProduct.yomiStatus が "NG" or "失注" を含む。
 *   DealProduct が0件の Deal は対象外。
 *
 * 社長判断 2026-05：完全失注は ToDo / Next Action から除外する（追いかけ対象外）。
 *
 * テーブル/カラム名は schema.prisma の @@map / @map に従い snake_case。
 */
export async function getFullyLostDealIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT d.id
    FROM deals d
    WHERE d.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM deal_products dp WHERE dp.deal_id = d.id)
      AND NOT EXISTS (
        SELECT 1 FROM deal_products dp
        WHERE dp.deal_id = d.id
          AND (
            dp.yomi_status IS NULL
            OR (dp.yomi_status !~ 'NG' AND dp.yomi_status !~ '失注')
          )
      )
  `;
  return rows.map((r) => r.id);
}

/**
 * Next Action / ToDo 用「除外条件のセット」を返す（サーバ専用）。
 *
 * 除外対象：
 *   A. bant.isNG = true
 *   B. pipelineStage = "【商談前】日程調整不可"
 *   C. 完全失注（全DealProductがNG/失注）  ← 2026-05追加
 *
 * 戻り値は Prisma の where に AND マージする想定:
 *
 *   const ngExclude = await excludeNGDealsWhere();
 *   prisma.deal.findMany({
 *     where: { ...activeFilter, AND: [...ngExclude.AND] },
 *   });
 */
export async function excludeNGDealsWhere(): Promise<{
  AND: Prisma.DealWhereInput[];
  fullyLostDealIds: string[];
}> {
  const fullyLostDealIds = await getFullyLostDealIds();
  return {
    AND: [
      // bant.isNG が true で無いこと
      { NOT: { bant: { path: ["isNG"], equals: true } } },
      // pipeline_stage が【商談前】日程調整不可で無いこと
      { NOT: { pipelineStage: "【商談前】日程調整不可" } },
      // 完全失注で無いこと
      ...(fullyLostDealIds.length > 0
        ? [{ id: { notIn: fullyLostDealIds } } satisfies Prisma.DealWhereInput]
        : []),
    ],
    fullyLostDealIds,
  };
}
