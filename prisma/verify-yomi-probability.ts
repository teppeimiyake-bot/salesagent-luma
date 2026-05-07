/**
 * STEP 4 整合性検証用ヘルパースクリプト
 *
 * バックフィル後の整合性を集計レベルで確認する。
 *   1) probability 分布（0%でない件数）
 *   2) yomiStatus と probability の不整合（YOMI_TO_PROBABILITY と乖離している件数）
 *   3) probability バケット別件数（フィルタ動作確認用）
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { YOMI_TO_PROBABILITY } from "../src/lib/deal-aggregations";
import { stripYomiPrefix } from "../src/lib/yomi-status";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_luma")) {
  throw new Error(`[safety] DATABASE_URL does not point to salesagent_luma`);
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

function expectedProb(yomi: string | null | undefined): number | null {
  if (!yomi) return null;
  const stripped = stripYomiPrefix(yomi);
  if (!stripped) return null;
  if (stripped === "締結済み") return 100;
  if (stripped in YOMI_TO_PROBABILITY) return YOMI_TO_PROBABILITY[stripped];
  return null;
}

async function main() {
  const all = await prisma.dealProduct.findMany({
    select: { id: true, yomiStatus: true, probability: true, amount: true },
  });
  console.log(`Total dealProduct: ${all.length}`);

  // 1) probability 分布
  const dist: Record<number, number> = {};
  for (const r of all) dist[r.probability] = (dist[r.probability] ?? 0) + 1;
  console.log(`\n[probability distribution]`);
  for (const k of Object.keys(dist).sort((a, b) => Number(a) - Number(b))) {
    console.log(`  ${k}% : ${dist[Number(k)]}`);
  }
  const nonZero = all.filter((r) => r.probability > 0).length;
  console.log(`  -> probability > 0%: ${nonZero} rows (${((nonZero / all.length) * 100).toFixed(1)}%)`);

  // 2) yomiStatus と probability の整合性
  const inconsistent: { id: string; yomi: string | null; prob: number; expected: number }[] = [];
  for (const r of all) {
    const exp = expectedProb(r.yomiStatus);
    if (exp != null && exp !== r.probability) {
      inconsistent.push({ id: r.id, yomi: r.yomiStatus, prob: r.probability, expected: exp });
    }
  }
  console.log(`\n[inconsistency check]`);
  console.log(`  rows where yomiStatus -> expected prob != actual prob: ${inconsistent.length}`);
  if (inconsistent.length > 0 && inconsistent.length <= 10) {
    for (const r of inconsistent) {
      console.log(`  - ${r.id} : ${JSON.stringify(r.yomi)} actual=${r.prob}% expected=${r.expected}%`);
    }
  }

  // 3) バケット別件数
  const buckets: Array<{ label: string; min: number; max: number; count: number }> = [
    { label: "0-19", min: 0, max: 19, count: 0 },
    { label: "20-39", min: 20, max: 39, count: 0 },
    { label: "40-59", min: 40, max: 59, count: 0 },
    { label: "60-79", min: 60, max: 79, count: 0 },
    { label: "80-100", min: 80, max: 100, count: 0 },
  ];
  for (const r of all) {
    for (const b of buckets) {
      if (r.probability >= b.min && r.probability <= b.max) {
        b.count++;
        break;
      }
    }
  }
  console.log(`\n[probability bucket distribution]`);
  for (const b of buckets) {
    console.log(`  ${b.label}% : ${b.count}`);
  }

  // 4) Deal 単位での加重金額（KPI集計と同じ）
  const deals = await prisma.deal.findMany({
    where: { deletedAt: null, company: { deletedAt: null } },
    include: { products: true },
  });
  let totalProposed = 0;
  let totalPipeline = 0;
  for (const d of deals) {
    for (const p of d.products) {
      totalProposed += p.amount ?? 0;
      totalPipeline += (p.amount ?? 0) * (p.probability / 100);
    }
  }
  console.log(`\n[Deal x Product aggregate]`);
  console.log(`  Total deals (active): ${deals.length}`);
  console.log(`  Total proposed amount: ${Math.round(totalProposed).toLocaleString()} 円`);
  console.log(`  Total pipeline (weighted): ${Math.round(totalPipeline).toLocaleString()} 円`);
  console.log(
    `  Pipeline / Proposed = ${
      totalProposed > 0 ? ((totalPipeline / totalProposed) * 100).toFixed(1) : "-"
    }%`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
