/**
 * Luma版 受注ヨミ→確度% バックフィル
 *
 * 既存 deal_products すべてに対し、yomiStatus から確度% を計算して上書きする。
 *
 * 接頭辞展開ルール:
 *   - 【映像】Aヨミ / 【SNS】Aヨミ / 【CATV】Aヨミ → 接頭辞を剥がして「Aヨミ」と判定
 *   - 接頭辞なしの「Aヨミ」（アライアンス案件） → そのまま「Aヨミ」と判定
 *   - 「締結済み」 → 「受注」と等価扱い（100%）
 *   - その他（null など） → 0%
 *
 * 使い方:
 *   npx tsx prisma/backfill-yomi-probability.ts           # ドライラン
 *   npx tsx prisma/backfill-yomi-probability.ts --apply   # 本実行
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { YOMI_TO_PROBABILITY } from "../src/lib/deal-aggregations";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_luma")) {
  throw new Error(`[safety] DATABASE_URL does not point to salesagent_luma`);
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const PREFIXES = ["【映像】", "【SNS】", "【CATV】"];

/**
 * yomiStatus（接頭辞付き含む）→ 確度% に変換
 * 該当しない場合は null（=変更しない）
 */
function probabilityFromYomi(yomi: string | null | undefined): number | null {
  if (!yomi) return null;
  // 接頭辞剥がし
  let normalized = yomi;
  for (const pre of PREFIXES) {
    if (normalized.startsWith(pre)) {
      normalized = normalized.slice(pre.length);
      break;
    }
  }
  // 「締結済み」は受注と等価
  if (normalized === "締結済み") return 100;
  if (normalized in YOMI_TO_PROBABILITY) return YOMI_TO_PROBABILITY[normalized];
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  // 全 dealProduct を取得
  const all = await prisma.dealProduct.findMany({
    select: { id: true, yomiStatus: true, probability: true },
  });
  console.log(`Total rows: ${all.length}`);

  // バケット化
  const byTarget: Record<number, string[]> = {};
  const skipped: { id: string; yomi: string | null }[] = [];
  for (const r of all) {
    const target = probabilityFromYomi(r.yomiStatus);
    if (target == null) {
      skipped.push({ id: r.id, yomi: r.yomiStatus });
      continue;
    }
    if (target === r.probability) continue; // 既に正しい
    if (!byTarget[target]) byTarget[target] = [];
    byTarget[target].push(r.id);
  }

  console.log(`\n[Plan]`);
  let total = 0;
  for (const k of Object.keys(byTarget).sort((a, b) => Number(b) - Number(a))) {
    const n = byTarget[Number(k)].length;
    console.log(`  -> ${k}% : ${n} rows`);
    total += n;
  }
  console.log(`Total to update: ${total}`);
  console.log(`Skipped (no mapping): ${skipped.length}`);
  if (skipped.length > 0 && skipped.length <= 20) {
    for (const s of skipped) {
      console.log(`  - ${s.id} : ${JSON.stringify(s.yomi)}`);
    }
  }

  if (!apply) {
    console.log(`\n[DRY RUN] Re-run with --apply to execute.`);
    return;
  }

  console.log(`\n[Applying...]`);
  let updated = 0;
  for (const k of Object.keys(byTarget)) {
    const target = Number(k);
    const ids = byTarget[target];
    if (ids.length === 0) continue;
    const r = await prisma.dealProduct.updateMany({
      where: { id: { in: ids } },
      data: { probability: target },
    });
    console.log(`  ${target}% : updated ${r.count}`);
    updated += r.count;
  }
  console.log(`\nTotal updated: ${updated}`);

  // 事後分布
  const after = await prisma.dealProduct.groupBy({
    by: ["probability"],
    _count: { _all: true },
    orderBy: { probability: "asc" },
  });
  console.log(`\n[Post-update probability distribution]`);
  for (const r of after) {
    console.log(`  ${r.probability}% : ${r._count._all}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
