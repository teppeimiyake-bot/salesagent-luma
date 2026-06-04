/**
 * 入金管理 Phase 10：Phase 9 で受注DealProduct全件から自動生成した余剰エントリ
 * （source_key='dpid::<dealProductId>'）を削除する。冪等。
 *
 * 背景：
 *   入金管理の正本はスプレッドシート（source_key='spot::'/'recurring::' の 57+11 行）。
 *   Phase 9 で CRM の受注プロダクト全件(129)から生成した dpid:: エントリは、
 *   シートに無い空行を大量に生み不整合。Phase 10 で廃止する。
 *
 * 安全策：
 *   - 削除対象は source_key が 'dpid::' で始まる行のみ（厳密限定）。
 *     シート由来行（'spot::'/'recurring::'）や手入力行には一切触れない。
 *   - RecurringBillingPeriod は RecurringBilling 削除時に onDelete: Cascade で連鎖削除される。
 *   - 実データ（Company/Deal/DealProduct）は触らない。
 *
 * 実行（dev）:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx scripts/cleanup-dpid-payments.ts          # 削除実行
 *   npx tsx scripts/cleanup-dpid-payments.ts --dry    # 件数のみ
 *
 * 本番（オーケストレーターが後で実施）:
 *   SEED_ALLOW_PROD=1 DATABASE_URL="<prod>" npx tsx scripts/cleanup-dpid-payments.ts
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（本番は SEED_ALLOW_PROD=1 必須）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const DRY = process.argv.includes("--dry");

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log(`=== cleanup-dpid-payments ${DRY ? "(DRY)" : ""} ===`);

  const where = { sourceKey: { startsWith: "dpid::" } };

  const spotCount = await prisma.invoiceRecord.count({ where });
  const recCount = await prisma.recurringBilling.count({ where });
  // 連鎖削除される月次セル数（参考表示）
  const periodCount = await prisma.recurringBillingPeriod.count({
    where: { billing: { sourceKey: { startsWith: "dpid::" } } },
  });
  console.log(
    `対象: InvoiceRecord(dpid::)=${spotCount} / RecurringBilling(dpid::)=${recCount} ` +
      `（連鎖削除 RecurringBillingPeriod=${periodCount}）`,
  );

  if (DRY) {
    console.log("DRY: 削除はスキップ");
  } else {
    const delSpot = await prisma.invoiceRecord.deleteMany({ where });
    const delRec = await prisma.recurringBilling.deleteMany({ where }); // periods は Cascade
    console.log(`削除完了: InvoiceRecord=${delSpot.count} / RecurringBilling=${delRec.count}`);
  }

  // 残存確認
  const remSpot = await prisma.invoiceRecord.count();
  const remSheetSpot = await prisma.invoiceRecord.count({
    where: { sourceKey: { startsWith: "spot::" } },
  });
  const remRec = await prisma.recurringBilling.count();
  const remSheetRec = await prisma.recurringBilling.count({
    where: { sourceKey: { startsWith: "recurring::" } },
  });
  console.log(
    `残存: InvoiceRecord 全=${remSpot}(うち spot::=${remSheetSpot}) / ` +
      `RecurringBilling 全=${remRec}(うち recurring::=${remSheetRec})`,
  );
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
