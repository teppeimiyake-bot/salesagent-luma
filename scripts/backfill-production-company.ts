/**
 * PM Phase3.5: ProductionProject.companyId バックフィル。冪等。
 *
 * 既存 ProductionProject の companyId が未設定のものについて、
 * deal->company（または dealProduct->deal->company）から会社IDを補完する。
 *
 * 実行:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"; npx tsx scripts/backfill-production-company.ts
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma")) {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const projects = await prisma.productionProject.findMany({
    where: { companyId: null },
    select: { id: true, deal: { select: { companyId: true } } },
  });

  let updated = 0;
  let nullDeal = 0;
  for (const p of projects) {
    const cid = p.deal?.companyId ?? null;
    if (!cid) {
      nullDeal++;
      continue;
    }
    await prisma.productionProject.update({
      where: { id: p.id },
      data: { companyId: cid },
    });
    updated++;
  }

  const total = await prisma.productionProject.count();
  const withCompany = await prisma.productionProject.count({ where: { companyId: { not: null } } });
  console.log(
    `[backfill-production-company] 対象(companyId未設定)=${projects.length} 補完=${updated} deal側company無し=${nullDeal}`,
  );
  console.log(`[backfill-production-company] 全体=${total} companyId有り=${withCompany}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
