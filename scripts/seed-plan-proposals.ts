/**
 * 企画提案マスタ（PlanProposal）初期投入：13種
 *
 * Notion「企画内容」multi_select の選択肢順・色をそのまま採用。
 * 名称は角括弧【】付きの完全一致文字列をそのまま使う（既存 bant.planContents との照合のため重要）。
 * 金額フィールドは持たせない（プラン金額は ProductPlan 側で管理）。
 *
 * 使い方:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx --env-file=.env scripts/seed-plan-proposals.ts
 *
 * 既存データは upsert で保護（同名があれば color / displayOrder / active を更新するだけ）。
 */
import { prisma } from "../src/lib/db";
import { LUMA_TENANT_ID } from "../prisma/tenant-ids";

// Notion登録順そのまま（displayOrder = 1..13）
const PLAN_PROPOSALS: { name: string; color: string }[] = [
  { name: "【SNS】縦型ショート動画", color: "blue" }, // 1
  { name: "【会社紹介】工場紹介動画", color: "default" }, // 2
  { name: "【会社紹介】CM", color: "brown" }, // 3
  { name: "【会社紹介】ブランディングムービー", color: "orange" }, // 4
  { name: "【採用】ドラマ風動画", color: "purple" }, // 5
  { name: "【採用】座談会動画", color: "green" }, // 6
  { name: "【採用】ブランディングムービー", color: "yellow" }, // 7
  { name: "【採用】1日密着動画", color: "pink" }, // 8
  { name: "【採用】インタビュー動画", color: "red" }, // 9
  { name: "【サービス紹介】CM", color: "gray" }, // 10
  { name: "【CATV】映像企画", color: "blue" }, // 11
  { name: "IR動画", color: "pink" }, // 12
  { name: "【採用】アニメーション", color: "purple" }, // 13
];

// ローカル(salesagent_luma) または Luma本番(Neon: ...neon.tech/neondb) のみ許可
function isAllowedDb(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes("salesagent_luma") || url.includes("neon.tech/neondb");
}

async function main() {
  if (!isAllowedDb(process.env.DATABASE_URL)) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma (local) or Luma prod Neon (neondb)");
    process.exit(1);
  }
  console.log("[seed-plan-proposals] start");
  console.log(`[seed-plan-proposals] DB: ${process.env.DATABASE_URL}`);

  let i = 0;
  for (const p of PLAN_PROPOSALS) {
    i += 1;
    const displayOrder = i;
    await prisma.planProposal.upsert({
      where: { tenantId_name: { tenantId: LUMA_TENANT_ID, name: p.name } },
      update: { color: p.color, displayOrder, active: true },
      create: { name: p.name, color: p.color, displayOrder, active: true },
    });
    console.log(`  [${String(displayOrder).padStart(2)}] ${p.name}  (color=${p.color})`);
  }

  const total = await prisma.planProposal.count();
  console.log("");
  console.log(`[seed-plan-proposals] done — マスタ件数=${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
