/**
 * 既存DBの g-wic と Allegro株式会社 の Deal に contractDate=2026-04-01 をセット。
 * Notion元データに「契約日」が入っていた2社の運用バックフィル。
 *
 * 使い方:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx prisma/set-contract-dates.ts
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
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const TARGETS: { companyName: string; contractDate: string }[] = [
  { companyName: "g-wic", contractDate: "2026-04-01" },
  { companyName: "Allegro株式会社", contractDate: "2026-04-01" },
];

async function main() {
  for (const t of TARGETS) {
    const company = await prisma.company.findFirst({
      where: { name: t.companyName, deletedAt: null },
    });
    if (!company) {
      console.log(`[skip] company not found: ${t.companyName}`);
      continue;
    }
    const deals = await prisma.deal.findMany({
      where: { companyId: company.id, deletedAt: null },
      select: { id: true, title: true, contractDate: true },
    });
    if (deals.length === 0) {
      console.log(`[skip] no deals for: ${t.companyName}`);
      continue;
    }
    const contractDate = new Date(`${t.contractDate}T00:00:00+09:00`);
    for (const d of deals) {
      const before = d.contractDate
        ? d.contractDate.toISOString().slice(0, 10)
        : "(empty)";
      await prisma.deal.update({
        where: { id: d.id },
        data: { contractDate },
      });
      console.log(
        `[ok] ${t.companyName} / ${d.title}: contractDate ${before} -> ${t.contractDate}`,
      );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
