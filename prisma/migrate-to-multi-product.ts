/**
 * Deal を「1企業=1Deal、内部に複数プロダクト DealProduct」構造に再構築する移行スクリプト。
 *
 * 実行：
 *   --dry-run : 件数とサンプルだけ表示（DBは変更しない）
 *   なし      : 実際に移行を実行
 *
 * 流れ：
 *  1. 同一 Company の Deal 群をリストアップ
 *  2. 各群を「最も古い Deal」に統合
 *     - 旧 Deal の (productName/planName/probability/amount/ownerUserId) を DealProduct として再作成
 *     - Meeting/Task/Document/AiLog/RoleplaySession の dealId を統合先に付け替え
 *     - Deal本体（pipelineStage/nextAction/bant/expectedCloseDate）はマージルールで上書き
 *     - 統合元の Deal を物理削除
 *  3. 1社1Dealのものも、productName 等を DealProduct に切り出して空のDealにする
 *
 * 前提：このスクリプトを実行する時点では、deal テーブルに旧カラム
 *       (product_name/plan_name/probability/amount) がまだ生SQLレベルで残っている必要がある。
 *       Prismaクライアント生成は新スキーマで行うため、旧カラムは生SQL経由でアクセスする。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_reagey")) {
  throw new Error(
    `[safety] DATABASE_URL does not point to salesagent_reagey. Got: ${connectionString}`,
  );
}

const DRY = process.argv.includes("--dry-run");

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ============================================================
// pipelineStage 進度マップ（数値が大きいほど進んだ状態）
// ============================================================
const STAGE_PROGRESS: Record<string, number> = {
  // 商談前（0-9）
  "【商談前】商談予定": 1,
  "【商談前】商談打診中": 2,
  "【商談前】資料提出": 3,
  // 商談後（10-19）
  "【商談後】トスなし": 10,
  "【商談後】企画中": 12,
  "【商談後】提案中": 14,
  "【商談後】稟議中": 16,
  "【商談後】見積提出": 18,
  // 契約フェーズ（20-29）
  "契約書チェック中": 20,
  "契約締結": 25,
  "受注": 28,
};

function stageProgress(stage: string | null): number {
  if (!stage) return 0;
  return STAGE_PROGRESS[stage] ?? 0;
}

// ============================================================
// probability から yomiStatus へ逆引き
// ============================================================
function probabilityToYomi(prob: number): string {
  if (prob >= 100) return "受注";
  if (prob >= 80) return "Aヨミ";
  if (prob >= 60) return "Bヨミ";
  if (prob >= 40) return "Cヨミ";
  if (prob >= 20) return "ネタ";
  return "NG";
}

// ============================================================
// メイン処理
// ============================================================
type LegacyDeal = {
  id: string;
  company_id: string;
  owner_user_id: string | null;
  product_name: string;
  plan_name: string | null;
  title: string;
  status: string;
  pipeline_stage: string | null;
  probability: number;
  amount: number | null;
  next_action: string | null;
  next_action_at: Date | null;
  expected_close_date: Date | null;
  bant: unknown | null;
  bant_updated_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

async function fetchLegacyDeals(): Promise<LegacyDeal[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id, company_id, owner_user_id, product_name, plan_name, title, status::text as status,
            pipeline_stage, probability, amount, next_action, next_action_at, expected_close_date,
            bant, bant_updated_at, deleted_at, created_at, updated_at
     FROM deals
     ORDER BY company_id, created_at ASC`,
  )) as LegacyDeal[];
  return rows;
}

function pickMergedFields(group: LegacyDeal[]): {
  pipelineStage: string | null;
  nextAction: string | null;
  nextActionAt: Date | null;
  expectedCloseDate: Date | null;
  bant: unknown | null;
  bantUpdatedAt: Date | null;
  status: string;
  title: string;
  ownerUserId: string | null;
  deletedAt: Date | null;
} {
  // pipelineStage: 進度の高いもの
  const stageBest = [...group].sort((a, b) => stageProgress(b.pipeline_stage) - stageProgress(a.pipeline_stage))[0];
  // nextAction: 最も近い未来日（過去なら最も新しい）
  const now = new Date();
  const future = group.filter((d) => d.next_action_at && d.next_action_at >= now);
  const past = group.filter((d) => d.next_action_at && d.next_action_at < now);
  let nextSrc: LegacyDeal | undefined;
  if (future.length > 0) {
    nextSrc = future.sort((a, b) => a.next_action_at!.getTime() - b.next_action_at!.getTime())[0];
  } else if (past.length > 0) {
    nextSrc = past.sort((a, b) => b.next_action_at!.getTime() - a.next_action_at!.getTime())[0];
  } else {
    // next_action のみ持つ（日付なし）ものを採用
    nextSrc = group.find((d) => d.next_action) ?? undefined;
  }
  // bant: 最新の bantUpdatedAt
  const bantSrc = [...group]
    .filter((d) => d.bant_updated_at)
    .sort((a, b) => (b.bant_updated_at!.getTime() - a.bant_updated_at!.getTime()))[0];
  // expectedCloseDate: 最も新しい更新Deal
  const closeSrc = [...group].sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
  // status: 進度の高いもの（DealStatus enum の順序で）
  const STATUS_ORDER = ["LEAD", "HEARING", "PROPOSAL", "NEGOTIATION", "CLOSING", "WON", "LOST"];
  const statusBest = [...group].sort(
    (a, b) => STATUS_ORDER.indexOf(b.status) - STATUS_ORDER.indexOf(a.status),
  )[0];
  // title: 最も古いDealのtitle（その後人手で編集前提）
  const oldest = [...group].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
  // ownerUserId: 最も古いDealから引き継ぎ（DealProductごとに担当が違うので）
  const ownerSrc = oldest;
  // deletedAt: 全てがソフト削除されているなら維持、それ以外はnull
  const allDeleted = group.every((d) => d.deleted_at);
  return {
    pipelineStage: stageBest.pipeline_stage,
    nextAction: nextSrc?.next_action ?? null,
    nextActionAt: nextSrc?.next_action_at ?? null,
    expectedCloseDate: closeSrc.expected_close_date,
    bant: bantSrc?.bant ?? null,
    bantUpdatedAt: bantSrc?.bant_updated_at ?? null,
    status: statusBest.status,
    title: oldest.title,
    ownerUserId: ownerSrc.owner_user_id,
    deletedAt: allDeleted ? oldest.deleted_at : null,
  };
}

async function getProductIdMap(): Promise<Map<string, string>> {
  const products = await prisma.product.findMany({ select: { id: true, name: true } });
  const map = new Map<string, string>();
  for (const p of products) map.set(p.name, p.id);
  return map;
}

async function main() {
  console.log(`[migrate-to-multi-product] DRY=${DRY}`);

  // 既に DealProduct テーブルが存在することを前提
  const dpExists = (await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.deal_products')::text AS reg`,
  )) as { reg: string | null }[];
  if (!dpExists[0]?.reg) {
    throw new Error("deal_products テーブルがまだ存在しません。先に CREATE TABLE 用のSQL を流してください。");
  }

  const legacyDeals = await fetchLegacyDeals();
  console.log(`[migrate-to-multi-product] 旧スキーマ Deal件数: ${legacyDeals.length}`);

  // 同一 company_id でグルーピング
  const groups = new Map<string, LegacyDeal[]>();
  for (const d of legacyDeals) {
    const arr = groups.get(d.company_id) ?? [];
    arr.push(d);
    groups.set(d.company_id, arr);
  }

  console.log(`[migrate-to-multi-product] 統合後 Company数: ${groups.size}`);
  let multiCount = 0;
  for (const [, arr] of groups) {
    if (arr.length > 1) multiCount++;
  }
  console.log(`[migrate-to-multi-product] 複数Deal持ちCompany数: ${multiCount}`);

  if (DRY) {
    // サンプル：複数Deal持ちCompany上位5社を表示
    const sample = [...groups.entries()].filter(([, a]) => a.length > 1).slice(0, 10);
    for (const [cid, arr] of sample) {
      const c = await prisma.company.findUnique({ where: { id: cid }, select: { name: true } });
      const merged = pickMergedFields(arr);
      console.log(`  - ${c?.name}（${arr.length}件）`);
      for (const d of arr) {
        console.log(
          `      product=${d.product_name} plan=${d.plan_name ?? "-"} prob=${d.probability} amount=${d.amount ?? "-"} stage=${d.pipeline_stage ?? "-"}`,
        );
      }
      console.log(`    -> 統合後: stage=${merged.pipelineStage} nextAction=${merged.nextAction ?? "-"}`);
    }
    console.log("[migrate-to-multi-product] DRY-RUN 完了。実行する時は --dry-run なしで。");
    await pool.end();
    return;
  }

  const productIdMap = await getProductIdMap();
  let movedDealProducts = 0;
  let mergedDeals = 0;
  let updatedDeals = 0;

  // トランザクション
  await prisma.$transaction(async (tx) => {
    for (const [companyId, arr] of groups) {
      // 統合先Deal = 最も古い
      const sorted = [...arr].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      const survivor = sorted[0];
      const merged = pickMergedFields(arr);

      // すべてのDealから DealProduct を作成
      for (const d of arr) {
        const productId = productIdMap.get(d.product_name) ?? null;
        await tx.dealProduct.create({
          data: {
            dealId: survivor.id,
            productId,
            productName: d.product_name,
            planName: d.plan_name,
            probability: d.probability,
            amount: d.amount,
            yomiStatus: probabilityToYomi(d.probability),
            ownerUserId: d.owner_user_id,
          },
        });
        movedDealProducts++;
      }

      // survivor 以外のDealから関連レコードを付け替え
      const otherIds = sorted.slice(1).map((d) => d.id);
      if (otherIds.length > 0) {
        // dealId を付け替え（PostgreSQL は $N に明示型キャストが必要）
        const placeholders = otherIds.map((_, i) => `$${i + 2}::text`).join(",");
        await tx.$executeRawUnsafe(
          `UPDATE meetings SET deal_id = $1::text WHERE deal_id IN (${placeholders})`,
          survivor.id,
          ...otherIds,
        );
        await tx.$executeRawUnsafe(
          `UPDATE tasks SET deal_id = $1::text WHERE deal_id IN (${placeholders})`,
          survivor.id,
          ...otherIds,
        );
        await tx.$executeRawUnsafe(
          `UPDATE documents SET deal_id = $1::text WHERE deal_id IN (${placeholders})`,
          survivor.id,
          ...otherIds,
        );
        await tx.$executeRawUnsafe(
          `UPDATE ai_logs SET deal_id = $1::text WHERE deal_id IN (${placeholders})`,
          survivor.id,
          ...otherIds,
        );
        await tx.$executeRawUnsafe(
          `UPDATE roleplay_sessions SET deal_id = $1::text WHERE deal_id IN (${placeholders})`,
          survivor.id,
          ...otherIds,
        );

        // 統合元のDealを物理削除
        const delPlaceholders = otherIds.map((_, i) => `$${i + 1}::text`).join(",");
        await tx.$executeRawUnsafe(
          `DELETE FROM deals WHERE id IN (${delPlaceholders})`,
          ...otherIds,
        );
        mergedDeals += otherIds.length;
      }

      // survivor Deal をマージ後フィールドで更新
      await tx.deal.update({
        where: { id: survivor.id },
        data: {
          ownerUserId: merged.ownerUserId,
          status: merged.status as never,
          pipelineStage: merged.pipelineStage,
          nextAction: merged.nextAction,
          nextActionAt: merged.nextActionAt,
          expectedCloseDate: merged.expectedCloseDate,
          bant: merged.bant as never,
          bantUpdatedAt: merged.bantUpdatedAt,
          deletedAt: merged.deletedAt,
          // titleは触らない
        },
      });
      updatedDeals++;
    }
  });

  console.log(`[migrate-to-multi-product] 移行完了`);
  console.log(`  - 作成 DealProduct: ${movedDealProducts}件`);
  console.log(`  - 統合により削除した旧Deal: ${mergedDeals}件`);
  console.log(`  - 更新した存続Deal: ${updatedDeals}件`);

  // 最終件数
  const finalDeals = await prisma.deal.count();
  const finalDealProducts = await prisma.dealProduct.count();
  console.log(`  - 最終 Deal件数: ${finalDeals}`);
  console.log(`  - 最終 DealProduct件数: ${finalDealProducts}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
