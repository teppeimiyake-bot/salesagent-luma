/**
 * Preflight check: 商材マスタ投入＋deal_products紐付け前の現状確認
 *
 * 使い方:
 *   PATH先頭にNode 22:  export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   実行:               npx tsx --env-file=.env scripts/preflight-products-link.ts
 *
 * チェック項目:
 *   (1) products テーブル件数（0件想定）
 *   (2) deal_products productName 別件数（4カテゴリ想定）
 *   (3) 受注/締結済み行の件数（保護対象=141件想定）
 *   (4) 受注/締結済み行のカテゴリ別内訳
 *   (5) 更新対象（受注/締結済み以外）のカテゴリ別件数
 *   (6) deal_products.amount / planName / productId の現状（NULL率）
 */

import { prisma } from "../src/lib/db";

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma");
    process.exit(1);
  }

  console.log("=== (1) products テーブル件数 ===");
  const productCount = await prisma.product.count();
  const planCount = await prisma.productPlan.count();
  console.log(`  products: ${productCount} 件`);
  console.log(`  product_plans: ${planCount} 件`);
  if (productCount > 0) {
    const existing = await prisma.product.findMany({
      select: { id: true, name: true, category: true, active: true },
    });
    existing.forEach((p) => console.log(`    - ${p.name} (id=${p.id}, category=${p.category}, active=${p.active})`));
  }

  console.log("\n=== (2) deal_products productName 別件数 ===");
  const productCounts = await prisma.dealProduct.groupBy({
    by: ["productName"],
    _count: { _all: true },
    orderBy: { _count: { productName: "desc" } },
  });
  productCounts.forEach((r) => {
    console.log(`  ${r.productName}: ${r._count._all}`);
  });
  const totalDP = productCounts.reduce((s, r) => s + r._count._all, 0);
  console.log(`  TOTAL: ${totalDP}`);

  console.log("\n=== (3) 保護対象=受注/締結済み 行の件数 ===");
  const protectedRows = await prisma.dealProduct.findMany({
    where: {
      OR: [
        { yomiStatus: { contains: "受注" } },
        { yomiStatus: { contains: "締結済み" } },
      ],
    },
    select: { id: true, productName: true, yomiStatus: true, amount: true, productId: true, planName: true },
  });
  console.log(`  TOTAL 保護対象: ${protectedRows.length} 件（想定 141）`);

  console.log("\n=== (4) 保護対象 行のカテゴリ × yomiStatus 内訳 ===");
  const protectedDist = new Map<string, number>();
  protectedRows.forEach((r) => {
    const key = `${r.productName} / ${r.yomiStatus}`;
    protectedDist.set(key, (protectedDist.get(key) ?? 0) + 1);
  });
  Array.from(protectedDist.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, c]) => console.log(`  ${key}: ${c}`));

  console.log("\n=== (5) 更新対象（受注/締結済み以外）のカテゴリ別件数 ===");
  const updateTargets = await prisma.dealProduct.groupBy({
    by: ["productName"],
    where: {
      AND: [
        { NOT: { yomiStatus: { contains: "受注" } } },
        { NOT: { yomiStatus: { contains: "締結済み" } } },
      ],
    },
    _count: { _all: true },
  });
  updateTargets
    .sort((a, b) => b._count._all - a._count._all)
    .forEach((r) => console.log(`  ${r.productName}: ${r._count._all}`));
  const totalUpdate = updateTargets.reduce((s, r) => s + r._count._all, 0);
  console.log(`  TOTAL 更新対象: ${totalUpdate}`);

  console.log("\n=== (6) deal_products.amount / planName / productId の現状 ===");
  const totalAll = await prisma.dealProduct.count();
  const amountNull = await prisma.dealProduct.count({ where: { amount: null } });
  const planNameNull = await prisma.dealProduct.count({ where: { planName: null } });
  const productIdNull = await prisma.dealProduct.count({ where: { productId: null } });
  console.log(`  全件: ${totalAll}`);
  console.log(`  amount=NULL: ${amountNull} (${((amountNull / totalAll) * 100).toFixed(1)}%)`);
  console.log(`  planName=NULL: ${planNameNull} (${((planNameNull / totalAll) * 100).toFixed(1)}%)`);
  console.log(`  productId=NULL: ${productIdNull} (${((productIdNull / totalAll) * 100).toFixed(1)}%)`);

  console.log("\n=== (6b) 保護対象の amount / planName / productId 現状（壊さない参考値） ===");
  const protAmountNull = protectedRows.filter((r) => r.amount === null).length;
  const protAmountSet = protectedRows.filter((r) => r.amount !== null).length;
  const protPlanNull = protectedRows.filter((r) => r.planName === null).length;
  const protProductIdNull = protectedRows.filter((r) => r.productId === null).length;
  console.log(`  保護対象 amount=NULL: ${protAmountNull}`);
  console.log(`  保護対象 amount=セット済み: ${protAmountSet}`);
  console.log(`  保護対象 planName=NULL: ${protPlanNull}`);
  console.log(`  保護対象 productId=NULL: ${protProductIdNull}`);
  if (protAmountSet > 0) {
    console.log(`  保護対象でamountセット済みの例 (先頭5件):`);
    protectedRows
      .filter((r) => r.amount !== null)
      .slice(0, 5)
      .forEach((r) => console.log(`    [${r.productName}] amount=${r.amount} plan=${r.planName} status=${r.yomiStatus}`));
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
