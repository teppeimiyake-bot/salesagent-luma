import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) {
    throw new Error("Wrong DB!");
  }
  const groups = await prisma.dealProduct.groupBy({
    by: ["yomiStatus"],
    _count: { _all: true },
    orderBy: { _count: { yomiStatus: "desc" } },
  });
  console.log("=== yomiStatus distribution ===");
  groups.forEach((g) => {
    console.log(`  ${JSON.stringify(g.yomiStatus)} : ${g._count._all}`);
  });

  const productGroups = await prisma.dealProduct.groupBy({
    by: ["productName", "yomiStatus"],
    _count: { _all: true },
    orderBy: [{ productName: "asc" }, { yomiStatus: "asc" }],
  });
  console.log("\n=== product x yomiStatus matrix ===");
  productGroups.forEach((g) => {
    console.log(`  ${g.productName} | ${JSON.stringify(g.yomiStatus)} : ${g._count._all}`);
  });
}

main().finally(() => prisma.$disconnect());
