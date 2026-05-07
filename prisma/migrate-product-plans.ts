/**
 * 旧 Product.planNames + Product.basePrice → 新 ProductPlan テーブル へのデータ移管
 *
 * 想定実行順:
 *   1. schema.prisma に ProductPlan を追加（planNames/basePrice は残したまま）
 *   2. db push で ProductPlan テーブル作成
 *   3. 本スクリプト実行 → ProductPlan に移管
 *   4. schema.prisma から planNames/basePrice を削除
 *   5. db push --accept-data-loss で旧フィールドをDBから削除
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const products = await prisma.product.findMany({
    include: { plans: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[migrate-product-plans] Products: ${products.length}`);
  let createdPlans = 0;
  let skippedPlans = 0;

  for (const p of products) {
    // 旧スキーマ参照（既に削除済みフィールド）。マイグレ実行時のみ存在。
    // 再実行時は型エラーを避けるため any キャスト。
    const legacy = p as unknown as { planNames?: string[]; basePrice?: number | null };
    const planNames = (legacy.planNames ?? []) as string[];
    const basePrice = legacy.basePrice ?? null;

    if (planNames.length === 0) {
      // プラン無し: basePrice だけがあれば「標準プラン」を作成
      if (basePrice != null) {
        const exists = p.plans.find((pl) => pl.name === "標準プラン");
        if (exists) {
          skippedPlans++;
        } else {
          await prisma.productPlan.create({
            data: {
              productId: p.id,
              name: "標準プラン",
              basePrice,
              sortOrder: 0,
            },
          });
          createdPlans++;
          console.log(`  [+] ${p.name} / 標準プラン (¥${basePrice.toLocaleString()})`);
        }
      }
      continue;
    }

    // プランあり: 各プランを ProductPlan として作成
    // basePrice は1番目のプランに引き継ぎ（複数あった場合）
    for (let i = 0; i < planNames.length; i++) {
      const planName = planNames[i];
      const exists = p.plans.find((pl) => pl.name === planName);
      if (exists) {
        skippedPlans++;
        continue;
      }
      const price = i === 0 ? basePrice : null;
      await prisma.productPlan.create({
        data: {
          productId: p.id,
          name: planName,
          basePrice: price,
          sortOrder: i,
        },
      });
      createdPlans++;
      console.log(
        `  [+] ${p.name} / ${planName}` +
          (price != null ? ` (¥${price.toLocaleString()})` : ""),
      );
    }
  }

  console.log(
    `\n[migrate-product-plans] Done. created=${createdPlans} skipped=${skippedPlans}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
