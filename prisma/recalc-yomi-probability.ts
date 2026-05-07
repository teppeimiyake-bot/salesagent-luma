import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_reagey")) {
  throw new Error(`[safety] DATABASE_URL does not point to salesagent_reagey`);
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const NEW_MAP: Record<string, number> = {
  "受注": 100,
  "A+ヨミ": 90,
  "Aヨミ": 70,
  "Bヨミ": 50,
  "Cヨミ": 30,
  "ネタ": 10,
  "NG": 0,
};

async function main() {
  let updated = 0;
  for (const [yomi, prob] of Object.entries(NEW_MAP)) {
    const r = await prisma.dealProduct.updateMany({
      where: { yomiStatus: yomi },
      data: { probability: prob },
    });
    console.log(`${yomi}: ${r.count} rows -> ${prob}%`);
    updated += r.count;
  }
  const summary = await prisma.dealProduct.groupBy({
    by: ["yomiStatus", "probability"],
    _count: { _all: true },
    orderBy: { probability: "desc" },
  });
  console.log("\nFinal distribution:");
  for (const s of summary) {
    console.log(`  ${s.yomiStatus ?? "(none)"} / ${s.probability}% : ${s._count._all}`);
  }
  console.log(`\nTotal updated: ${updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
