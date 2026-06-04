/**
 * 機能4（PMタブ）初期生成バックフィル。冪等。
 *
 * 受注系（isWonYomi）の DealProduct ごとに ProductionProject を1件生成する。
 * dealProductId は @unique なので、既に紐付くプロジェクトがあればスキップ（冪等）。
 *
 * 実行:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"; npx tsx scripts/backfill-production-projects.ts
 *
 * カテゴリ: categoryFromDealProduct（yomi接頭辞 → productName → Product）で判定。
 * プロジェクト名: 受注した商談名（Deal.title）をそのまま使う（2026-06 社長判断）。
 *   Deal.title が空の場合のみ「企業名 ＋ カテゴリ ＋ プラン名」へフォールバック。後でPM画面で手修正可。
 *   既存プロジェクトも projectName を Deal.title で上書きする（冪等・本日生成のため手編集ほぼ無い前提）。
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（他DB誤爆防止）。
 *
 * 今後の自動生成について（設計メモ）:
 *   理想は「DealProduct.yomiStatus が受注へ遷移した時」に hook で1件 upsert すること。
 *   遷移点は /api/deal-products/[id] の PATCH（yomiStatus 更新箇所）。
 *   そこで isWonYomi(new) && !isWonYomi(old) を検知し、本スクリプトと同じ upsert を呼ぶ。
 *   現状は受注データが Notion 取込由来でまとまって入るため、まずは本バックフィルで足りる。
 *   二重管理（Notion PMボード vs 本タブ）の解消方針が決まるまで自動 hook は保留。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isWonYomi } from "../src/lib/yomi-status";
import { categoryFromDealProduct } from "../src/lib/product-categories";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/**
 * プロジェクト名 = 受注した商談名（Deal.title）。
 * Deal.title が空の場合のみ「企業名 ＋ カテゴリ ＋ プラン名」へフォールバック。
 */
function buildProjectName(
  dealTitle: string | null | undefined,
  companyName: string | null | undefined,
  category: string | null,
  planName: string | null | undefined,
): string {
  const title = dealTitle?.trim();
  if (title) return title;
  const parts: string[] = [];
  if (companyName) parts.push(companyName);
  if (category) parts.push(category);
  if (planName) parts.push(planName);
  return parts.join(" ") || "無題プロジェクト";
}

async function main() {
  const dps = await prisma.dealProduct.findMany({
    select: {
      id: true,
      dealId: true,
      yomiStatus: true,
      productName: true,
      planName: true,
      product: { select: { name: true, category: true } },
      deal: { select: { id: true, title: true, company: { select: { name: true } } } },
    },
  });

  const won = dps.filter((d) => isWonYomi(d.yomiStatus));

  let created = 0;
  let renamed = 0; // 既存の projectName を Deal.title に更新した件数
  let unchanged = 0; // 既存で projectName が既に一致していた件数
  const byCategory: Record<string, number> = {};

  for (const d of won) {
    const category = categoryFromDealProduct(d);
    const catKey = category ?? "(未分類)";
    const projectName = buildProjectName(
      d.deal?.title,
      d.deal?.company?.name,
      category,
      d.planName,
    );

    // 冪等: dealProductId は @unique。既存があれば projectName を Deal.title へ上書きする。
    const existing = await prisma.productionProject.findUnique({
      where: { dealProductId: d.id },
      select: { id: true, projectName: true },
    });

    if (existing) {
      if (existing.projectName !== projectName) {
        await prisma.productionProject.update({
          where: { id: existing.id },
          data: { projectName },
        });
        renamed++;
      } else {
        unchanged++;
      }
      continue;
    }

    await prisma.productionProject.create({
      data: {
        dealId: d.dealId,
        dealProductId: d.id,
        category,
        projectName,
        status: "BEFORE_SHOOT",
      },
    });
    created++;
    byCategory[catKey] = (byCategory[catKey] ?? 0) + 1;
  }

  console.log("=== backfill-production-projects 完了 ===");
  console.log(`受注 DealProduct 総数: ${won.length}`);
  console.log(
    `新規生成: ${created}  /  projectName更新(Deal.title化): ${renamed}  /  既存据置(一致): ${unchanged}`,
  );
  console.log("新規生成のカテゴリ別内訳:", JSON.stringify(byCategory, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
