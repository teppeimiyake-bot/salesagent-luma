/**
 * Luma商材マスタ投入 ＋ deal_products 紐付け（受注/締結済み以外のみ）
 *
 * 使い方:
 *   PATH先頭にNode 22:  export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   ドライラン:         npx tsx --env-file=.env scripts/seed-products-and-link-deals.ts
 *   本投入:             npx tsx --env-file=.env scripts/seed-products-and-link-deals.ts --apply
 *
 * 設計:
 * - Product = カテゴリ（映像/SNS/CATV/アライアンス）の4件（unique=name）
 * - ProductPlan = 全9プラン（@@unique([productId, name])）
 *   - 映像: ライト¥400,000 / オーダーメイド¥550,000 / プレミアム¥700,000
 *   - SNS:  ベーシック¥940,000 / スタンダード¥1,300,000 / プレミアム¥1,780,000 / ハイエンド¥2,200,000
 *   - CATV: 1キャンパス（単価）¥50,000  ← 5万円×N の単価モデル。商談ごとにquantity調整は将来UI対応
 *   - アライアンス: アライアンス¥0
 * - DealProduct.productId は カテゴリ（Product）の id を指す（既存スキーマ通り）
 *
 * 紐付けルール（受注/締結済み 以外 のみ更新）:
 *   映像        → productId=映像Pカテゴリ,    planName='オーダーメイド', amount=550000
 *   SNS         → productId=SNSPカテゴリ,     planName='ベーシック',     amount=940000
 *   CATV        → productId=CATVカテゴリ,     planName='1キャンパス',    amount=50000
 *   アライアンス → productId=アライアンスカテゴリ, planName='アライアンス', amount=0
 *
 * 保護対象（一切触らない）:
 *   yomiStatus に「受注」または「締結済み」を含む行（=141件想定）
 *
 * 安全:
 * - DATABASE_URL guard（salesagent_luma 必須）
 * - DRY-RUN がデフォルト
 * - 全更新を1つの $transaction で実行（途中失敗で全ロールバック）
 * - 実行前/実行後に保護対象の件数とハッシュを比較
 */

import { prisma } from "../src/lib/db";

// ============================================================
// マスタ定義
// ============================================================
type PlanSeed = { name: string; basePrice: number; sortOrder: number };
type CategorySeed = {
  name: string; // = Product.name（カテゴリ）
  description: string;
  plans: PlanSeed[];
};

const CATEGORIES: CategorySeed[] = [
  {
    name: "映像",
    description: "B2B映像制作（採用動画・会社紹介動画 ほか）",
    plans: [
      { name: "ライト",         basePrice: 400_000, sortOrder: 1 },
      { name: "オーダーメイド", basePrice: 550_000, sortOrder: 2 },
      { name: "プレミアム",     basePrice: 700_000, sortOrder: 3 },
    ],
  },
  {
    name: "SNS",
    description: "SNS運用代行（YouTube / Instagram / TikTok）",
    plans: [
      { name: "ベーシック",   basePrice:   940_000, sortOrder: 1 },
      { name: "スタンダード", basePrice: 1_300_000, sortOrder: 2 },
      { name: "プレミアム",   basePrice: 1_780_000, sortOrder: 3 },
      { name: "ハイエンド",   basePrice: 2_200_000, sortOrder: 4 },
    ],
  },
  {
    name: "CATV",
    description: "CATV関連サービス（5万円 × キャンパス数の単価モデル）",
    plans: [
      // 単価1キャンパス=50,000円。商談ごとに plan_name を「Nキャンパス」に書き換え＆ amount=50000*N で運用。
      { name: "1キャンパス",   basePrice: 50_000, sortOrder: 1 },
    ],
  },
  {
    name: "アライアンス",
    description: "アライアンス（金額なし）",
    plans: [
      { name: "アライアンス", basePrice: 0, sortOrder: 1 },
    ],
  },
];

// 紐付けルール（カテゴリ名 → デフォルト割り当て）
type LinkRule = { planName: string; amount: number };
const LINK_RULES: Record<string, LinkRule> = {
  "映像":        { planName: "オーダーメイド", amount: 550_000 },
  "SNS":         { planName: "ベーシック",     amount: 940_000 },
  "CATV":        { planName: "1キャンパス",    amount:  50_000 },
  "アライアンス": { planName: "アライアンス",   amount:       0 },
};

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) {
    console.error("ABORT: DATABASE_URL must point to salesagent_luma");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  console.log(apply ? "[APPLY MODE]" : "[DRY-RUN MODE]");

  // ============================================================
  // STEP 1: 事前カウント（保護対象が想定通りか）
  // ============================================================
  console.log("\n========== STEP 1: 事前カウント ==========");
  const protectedCount = await prisma.dealProduct.count({
    where: {
      OR: [
        { yomiStatus: { contains: "受注" } },
        { yomiStatus: { contains: "締結済み" } },
      ],
    },
  });
  console.log(`保護対象（受注/締結済み）: ${protectedCount} 件`);
  if (protectedCount !== 141) {
    console.error(`ABORT: 保護対象が想定141件と異なる（実際=${protectedCount}）`);
    process.exit(1);
  }

  // 保護対象スナップショット（全フィールド一致を後で検証）
  const protectedBefore = await prisma.dealProduct.findMany({
    where: {
      OR: [
        { yomiStatus: { contains: "受注" } },
        { yomiStatus: { contains: "締結済み" } },
      ],
    },
    select: {
      id: true,
      productId: true,
      productName: true,
      planName: true,
      amount: true,
      yomiStatus: true,
    },
    orderBy: { id: "asc" },
  });
  const protectedHashBefore = JSON.stringify(protectedBefore);
  console.log(`保護対象スナップショット取得: ${protectedBefore.length} 行 / hash長=${protectedHashBefore.length}`);

  // 更新対象カウント
  const updateCountByCategory = new Map<string, number>();
  for (const cat of Object.keys(LINK_RULES)) {
    const c = await prisma.dealProduct.count({
      where: {
        productName: cat,
        AND: [
          { NOT: { yomiStatus: { contains: "受注" } } },
          { NOT: { yomiStatus: { contains: "締結済み" } } },
        ],
      },
    });
    updateCountByCategory.set(cat, c);
    console.log(`更新予定 [${cat}]: ${c} 件`);
  }
  const totalUpdatePlanned = [...updateCountByCategory.values()].reduce((s, n) => s + n, 0);
  console.log(`更新予定合計: ${totalUpdatePlanned} 件（想定 2,414）`);

  // ============================================================
  // STEP 2: トランザクションで一括投入＆更新
  // ============================================================
  console.log("\n========== STEP 2: トランザクション実行 ==========");

  if (!apply) {
    console.log("[DRY-RUN] ここから先は実行しません。--apply で本投入。");
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    // -------- 2-A) Product / ProductPlan upsert --------
    const productIdByName = new Map<string, string>();

    for (const cat of CATEGORIES) {
      const product = await tx.product.upsert({
        where: { name: cat.name },
        update: {
          description: cat.description,
          active: true,
        },
        create: {
          name: cat.name,
          description: cat.description,
          active: true,
        },
      });
      productIdByName.set(cat.name, product.id);
      console.log(`  product upserted: ${cat.name} (id=${product.id})`);

      for (const plan of cat.plans) {
        const p = await tx.productPlan.upsert({
          where: {
            productId_name: { productId: product.id, name: plan.name },
          },
          update: {
            basePrice: plan.basePrice,
            sortOrder: plan.sortOrder,
            active: true,
          },
          create: {
            productId: product.id,
            name: plan.name,
            basePrice: plan.basePrice,
            sortOrder: plan.sortOrder,
            active: true,
          },
        });
        console.log(`    plan upserted: ${cat.name}/${plan.name} ¥${plan.basePrice.toLocaleString()} (id=${p.id})`);
      }
    }

    // -------- 2-B) deal_products 更新（受注/締結済み 以外 のみ） --------
    const updateResults: Record<string, number> = {};
    for (const [cat, rule] of Object.entries(LINK_RULES)) {
      const productId = productIdByName.get(cat);
      if (!productId) {
        throw new Error(`product not found: ${cat}`);
      }
      const r = await tx.dealProduct.updateMany({
        where: {
          productName: cat,
          AND: [
            { NOT: { yomiStatus: { contains: "受注" } } },
            { NOT: { yomiStatus: { contains: "締結済み" } } },
          ],
        },
        data: {
          productId,
          planName: rule.planName,
          amount: rule.amount,
        },
      });
      updateResults[cat] = r.count;
      console.log(`  deal_products updated [${cat}]: ${r.count} 件`);
    }

    // -------- 2-C) トランザクション内で保護対象を再取得して比較 --------
    const protectedAfter = await tx.dealProduct.findMany({
      where: {
        OR: [
          { yomiStatus: { contains: "受注" } },
          { yomiStatus: { contains: "締結済み" } },
        ],
      },
      select: {
        id: true,
        productId: true,
        productName: true,
        planName: true,
        amount: true,
        yomiStatus: true,
      },
      orderBy: { id: "asc" },
    });
    const protectedHashAfter = JSON.stringify(protectedAfter);

    if (protectedHashAfter !== protectedHashBefore) {
      // ここに来たら絶対に COMMIT させない（throw で全 ROLLBACK）
      const diffs: Array<{ id: string; before: any; after: any }> = [];
      for (let i = 0; i < protectedBefore.length; i++) {
        const b = protectedBefore[i]!;
        const a = protectedAfter[i]!;
        if (JSON.stringify(b) !== JSON.stringify(a)) {
          diffs.push({ id: b.id, before: b, after: a });
        }
      }
      console.error(`!!! 保護対象が変化した !!! 差分 ${diffs.length} 件:`);
      diffs.slice(0, 10).forEach((d) => console.error(JSON.stringify(d)));
      throw new Error("PROTECTED ROWS MUTATED — rolling back");
    }

    return {
      productIdByName: Object.fromEntries(productIdByName),
      updateResults,
      protectedCheck: protectedAfter.length,
    };
  }, { timeout: 60_000 });

  console.log("\n========== STEP 3: トランザクション完了（COMMIT 済み） ==========");
  console.log("Products:");
  Object.entries(result.productIdByName).forEach(([name, id]) => console.log(`  ${name}: ${id}`));
  console.log("Updated deal_products:");
  Object.entries(result.updateResults).forEach(([cat, n]) => console.log(`  ${cat}: ${n}`));
  console.log(`保護対象 確認: ${result.protectedCheck} 件 → 完全に無傷`);

  // ============================================================
  // STEP 4: 事後検証（別接続で再確認）
  // ============================================================
  console.log("\n========== STEP 4: 事後検証 ==========");

  // 4-1) 保護対象が変化していないか
  const protectedAfterCommit = await prisma.dealProduct.findMany({
    where: {
      OR: [
        { yomiStatus: { contains: "受注" } },
        { yomiStatus: { contains: "締結済み" } },
      ],
    },
    select: {
      id: true,
      productId: true,
      productName: true,
      planName: true,
      amount: true,
      yomiStatus: true,
    },
    orderBy: { id: "asc" },
  });
  const protectedHashAfterCommit = JSON.stringify(protectedAfterCommit);
  if (protectedHashAfterCommit !== protectedHashBefore) {
    console.error(`!!! 事後検証失敗：保護対象が変化している !!!`);
    process.exit(1);
  }
  console.log(`✓ 保護対象 ${protectedAfterCommit.length} 件は完全に無傷`);

  // 4-2) 更新対象が想定通りに紐付いたか
  for (const [cat, rule] of Object.entries(LINK_RULES)) {
    const linkedCount = await prisma.dealProduct.count({
      where: {
        productName: cat,
        productId: result.productIdByName[cat],
        planName: rule.planName,
        amount: rule.amount,
      },
    });
    const expectedCount = updateCountByCategory.get(cat) ?? 0;
    const status = linkedCount === expectedCount ? "OK" : "FAIL";
    console.log(`  [${cat}] 紐付け済み=${linkedCount} / 予定=${expectedCount} → ${status}`);
  }

  // 4-3) productId=NULL の残存数
  const stillNullProductId = await prisma.dealProduct.count({ where: { productId: null } });
  console.log(`  productId=NULL の残存: ${stillNullProductId} 件（想定 = 保護対象141 ＋ 未知カテゴリ0）`);

  console.log("\n========== DONE ==========");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
