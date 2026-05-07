import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_luma")) {
  throw new Error(`[safety] DATABASE_URL does not point to salesagent_luma`);
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const total = await prisma.dealProduct.count();
  console.log(`Total dealProduct rows: ${total}`);

  const byYomi = await prisma.dealProduct.groupBy({
    by: ["yomiStatus"],
    _count: { _all: true },
    orderBy: { _count: { yomiStatus: "desc" } },
  });
  console.log("\n[yomiStatus distribution]");
  for (const r of byYomi) {
    console.log(`  ${JSON.stringify(r.yomiStatus)} : ${r._count._all}`);
  }

  const byProb = await prisma.dealProduct.groupBy({
    by: ["probability"],
    _count: { _all: true },
    orderBy: { probability: "asc" },
  });
  console.log("\n[probability distribution]");
  for (const r of byProb) {
    console.log(`  ${r.probability}% : ${r._count._all}`);
  }

  const cross = await prisma.dealProduct.groupBy({
    by: ["yomiStatus", "probability"],
    _count: { _all: true },
    orderBy: [{ yomiStatus: "asc" }, { probability: "asc" }],
  });
  console.log("\n[yomiStatus x probability cross]");
  for (const r of cross) {
    console.log(
      `  ${JSON.stringify(r.yomiStatus).padEnd(20)} / ${String(r.probability).padStart(3)}% : ${r._count._all}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
