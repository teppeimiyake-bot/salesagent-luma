/**
 * planContents / proposalDocUrl が入っている商談を5件サンプル取得
 * Phase 1 のUI表示確認用
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const all = await prisma.deal.findMany({
    where: { deletedAt: null },
    include: { company: { select: { name: true } } },
  });

  type Hit = {
    id: string;
    title: string;
    companyName: string;
    proposalDocUrl: string | null;
    planContents: string[];
  };

  const hits: Hit[] = [];
  for (const d of all) {
    const b = (d.bant as Record<string, unknown> | null) ?? null;
    if (!b) continue;
    const url =
      typeof b.proposalDocUrl === "string" && b.proposalDocUrl.length > 0
        ? b.proposalDocUrl
        : null;
    const plans = Array.isArray(b.planContents)
      ? (b.planContents as unknown[]).filter(
          (x): x is string => typeof x === "string" && x.length > 0,
        )
      : [];
    if (url || plans.length > 0) {
      hits.push({
        id: d.id,
        title: d.title,
        companyName: d.company.name,
        proposalDocUrl: url,
        planContents: plans,
      });
    }
  }

  const withBoth = hits.filter((h) => h.proposalDocUrl && h.planContents.length > 0);
  const withUrlOnly = hits.filter((h) => h.proposalDocUrl && h.planContents.length === 0);
  const withPlanOnly = hits.filter((h) => !h.proposalDocUrl && h.planContents.length > 0);

  console.log(`総ヒット件数: ${hits.length}`);
  console.log(`  URL+企画内容 両方あり: ${withBoth.length}`);
  console.log(`  URLのみ:               ${withUrlOnly.length}`);
  console.log(`  企画内容のみ:          ${withPlanOnly.length}`);

  console.log("\n=== サンプル: URL+企画内容 両方ありの上位5件 ===");
  for (const h of withBoth.slice(0, 5)) {
    console.log(`\n  Deal: ${h.title}`);
    console.log(`    Company:  ${h.companyName}`);
    console.log(`    URL:  http://localhost:3003/deals/${h.id}`);
    console.log(`    proposalDocUrl: ${h.proposalDocUrl}`);
    console.log(`    planContents:   [${h.planContents.join(", ")}]`);
  }

  if (withPlanOnly.length > 0) {
    console.log("\n=== サンプル: 企画内容のみ（URL無し）2件 ===");
    for (const h of withPlanOnly.slice(0, 2)) {
      console.log(`\n  Deal: ${h.title}`);
      console.log(`    Company:  ${h.companyName}`);
      console.log(`    URL:  http://localhost:3003/deals/${h.id}`);
      console.log(`    planContents:   [${h.planContents.join(", ")}]`);
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
    await pool.end();
  });
