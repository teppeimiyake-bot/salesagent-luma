/**
 * 受注済みなのに PM案件（ProductionProject）が無い DealProduct を洗い出して起票する。
 *
 *   dry-run: npx tsx prisma/scripts/backfill-missing-pm.ts [--prod|--staging]
 *   反映   : 上記に --apply を付ける
 *
 * 背景：受注遷移時の自動起票が無かった期間に受注になった商材（岩泉町役場の映像など）が
 * PM 一覧に出ていなかった。今後は src/lib/pm-sync.ts の hook が拾うので、これは取りこぼし分の穴埋め。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import * as dotenv from "dotenv";
import { isWonYomi } from "../../src/lib/yomi-status";
import { categoryFromDealProduct } from "../../src/lib/product-categories";

const APPLY = process.argv.includes("--apply");
const PROD = process.argv.includes("--prod");
const STAGING = process.argv.includes("--staging");

dotenv.config({
  path: PROD ? ".env.production.local" : STAGING ? ".env.staging" : ".env",
  override: true,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

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

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const expected = PROD ? "ep-round-band-aoj5sgyq" : STAGING ? "ep-wispy-sun-ao9ahi1c" : "salesagent_luma";
  if (!url.includes(expected)) throw new Error(`想定外のDBに接続しています（期待: ${expected}）`);
  console.log(`接続先: ${PROD ? "本番 Neon" : STAGING ? "ステージング" : "ローカル"}`);

  const dps = await prisma.dealProduct.findMany({
    select: {
      id: true,
      dealId: true,
      // 素の PrismaClient を使うのでテナント境界のExtensionが効かない。
      // tenant_id は自分で引き継がないと "" のまま INSERT されて FK 違反になる。
      tenantId: true,
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
          company: { select: { name: true } },
        },
      },
      productionProject: { select: { id: true } },
    },
  });

  const missing = dps.filter(
    (d) => isWonYomi(d.yomiStatus) && d.deal && !d.deal.deletedAt && !d.productionProject,
  );

  console.log(`受注 DealProduct: ${dps.filter((d) => isWonYomi(d.yomiStatus)).length}件`);
  console.log(`うち PM案件が無い: ${missing.length}件`);
  for (const d of missing) {
    const category = categoryFromDealProduct(d);
    console.log(
      `  ${d.deal?.company?.name ?? "(企業なし)"} / ${d.productName} [${category ?? "未分類"}] ← ${d.yomiStatus}`,
    );
  }

  if (!APPLY) {
    console.log("\n*** dry-run です。反映するには --apply を付けてください。 ***");
    return;
  }

  let created = 0;
  for (const d of missing) {
    const category = categoryFromDealProduct(d);
    await prisma.productionProject.create({
      data: {
        tenantId: d.tenantId,
        dealId: d.dealId,
        dealProductId: d.id,
        companyId: d.deal?.companyId ?? null,
        category,
        projectName: buildProjectName(d.deal?.title, d.deal?.company?.name, category, d.planName),
        status: category === "SNS" ? "CONTRACTED" : "BEFORE_SHOOT",
      },
      select: { id: true },
    });
    created++;
  }
  console.log(`\n*** ${created}件を起票しました。 ***`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
