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
 * 「完全受注」の Deal ID 一覧を返す。
 *   完全受注 = 全 DealProduct.yomiStatus が "受注" or "締結済み" を含む。
 *   DealProduct が0件の Deal は対象外。
 *
 * 社長判断 2026-05：受注済み案件は ToDo / Next Action から除外する（追いかけ完了）。
 *
 * 注意：プレフィックス（【映像】【SNS】【CATV】）付きでも素のヨミでも一致するよう
 *       部分一致（~）で判定する。yomi-status.ts の isWonYomi() と整合させること。
 */
export async function getFullyWonDealIds(): Promise<string[]> {
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
            OR (dp.yomi_status !~ '受注' AND dp.yomi_status !~ '締結済み')
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

/**
 * ToDo管理用「除外条件のセット」を返す（サーバ専用）。
 *
 * `excludeNGDealsWhere()` の上位互換。以下を全部弾く Prisma where を生成する：
 *
 *   A. bant.isNG = true
 *   B. pipelineStage = "【商談前】日程調整不可"
 *   C. 完全失注（全 DealProduct.yomiStatus が NG/失注）
 *   D. Deal.status = WON または LOST（受注済み / 失注済み）
 *   E. 完全受注（全 DealProduct.yomiStatus が 受注/締結済み）
 *
 * 社長判断 2026-05：受注済み・失注済み・NG の商談は ToDo 管理から除外する。
 * これにより、トップ画面・ToDo一覧・チーム画面・商談アクション由来のToDoが
 * すべて「追いかけ対象の生きてる商談」だけに絞られる。
 *
 * 既存の `excludeNGDealsWhere()` は KPI集計（nextActionRate等）で
 * 「WON/LOST を含めて判定したい」用途のために残してある。
 * ToDo 管理用途では必ずこちらを使うこと。
 *
 * 戻り値は Prisma の where に AND マージする想定:
 *
 *   const exclude = await excludeDoneAndNGDealsWhere();
 *   prisma.task.findMany({
 *     where: { deal: { ...activeDeal, AND: [...exclude.AND] } },
 *   });
 */
export async function excludeDoneAndNGDealsWhere(): Promise<{
  AND: Prisma.DealWhereInput[];
  fullyLostDealIds: string[];
  fullyWonDealIds: string[];
}> {
  const [fullyLostDealIds, fullyWonDealIds] = await Promise.all([
    getFullyLostDealIds(),
    getFullyWonDealIds(),
  ]);
  const excludedIds = [...new Set([...fullyLostDealIds, ...fullyWonDealIds])];
  return {
    AND: [
      // A. bant.isNG が true で無いこと
      { NOT: { bant: { path: ["isNG"], equals: true } } },
      // B. pipeline_stage が【商談前】日程調整不可で無いこと
      { NOT: { pipelineStage: "【商談前】日程調整不可" } },
      // D. Deal.status が WON / LOST で無いこと
      { status: { notIn: ["WON", "LOST"] } },
      // C + E. 完全失注 / 完全受注 で無いこと
      ...(excludedIds.length > 0
        ? [{ id: { notIn: excludedIds } } satisfies Prisma.DealWhereInput]
        : []),
    ],
    fullyLostDealIds,
    fullyWonDealIds,
  };
}
