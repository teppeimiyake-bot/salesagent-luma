/** 千代田精機・モリ環境衛生センターの受注商材を再同期する。既定は dry-run。 */
import { randomUUID } from "node:crypto";
import { isWonYomi } from "../src/lib/yomi-status";
import { syncWonProductToPayments } from "../src/lib/payment-sync";
import { prismaUnscoped as prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");
const TARGETS = ["千代田精機", "モリ環境衛生センター"];
const CONFIRMED_WON = { company: "モリ環境衛生センター", product: "SNS" } as const;

async function main() {
  const companies = await prisma.company.findMany({
    where: { OR: TARGETS.map((name) => ({ name: { contains: name } })) },
    select: {
      id: true,
      name: true,
      invoiceRecords: { select: { id: true, sourceKey: true, dealProductId: true } },
      recurringBillings: { select: { id: true, sourceKey: true, dealProductId: true } },
      deals: {
        select: {
          id: true,
          deletedAt: true,
          products: { select: { id: true, productName: true, yomiStatus: true } },
        },
      },
    },
  });
  const products = companies.flatMap((company) =>
    company.deals.filter((deal) => deal.deletedAt == null).flatMap((deal) =>
      deal.products
        .map((product) => ({ companyId: company.id, company: company.name, dealId: deal.id, ...product })),
    ),
  );
  const confirmedWonProduct = products.find(
    (product) =>
      product.company.includes(CONFIRMED_WON.company) &&
      product.productName.includes(CONFIRMED_WON.product),
  );
  const won = products.filter((product) => isWonYomi(product.yomiStatus));

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "apply" : "dry-run",
        companies,
        confirmedWonCorrection: confirmedWonProduct
          ? { ...confirmedWonProduct, afterYomiStatus: "【SNS】受注" }
          : "SNS product not found",
        won,
      },
      null,
      2,
    ),
  );
  if (!APPLY) return;

  if (!confirmedWonProduct) {
    throw new Error("モリ環境衛生センターのSNS商材が見つからないため補正を中止しました");
  }
  if (!isWonYomi(confirmedWonProduct.yomiStatus)) {
    // 移行途中のDBでは @updatedAt 対象列が未作成で、Prisma updateが
    // 自動更新列へ触れると P2022 になる。必要な2列だけをパラメータ化SQLで更新する。
    const updated = await prisma.$executeRaw`
      UPDATE deal_products
      SET yomi_status = ${"【SNS】受注"}, probability = ${100}
      WHERE id = ${confirmedWonProduct.id}
    `;
    if (updated !== 1) throw new Error(`SNS商材の受注更新件数が不正です: ${updated}`);
  }

  // 接続先がマルチテナント移行前スキーマのため、この限定補正は
  // tenant_id を要求する現行Prismaモデルを経由せず、実在列だけで冪等INSERTする。
  await prisma.$executeRaw`
    INSERT INTO recurring_billings
      (id, customer_name, company_id, deal_id, deal_product_id, source_key, created_at, updated_at)
    SELECT
      ${randomUUID()}, ${confirmedWonProduct.company}, ${confirmedWonProduct.companyId},
      ${confirmedWonProduct.dealId}, ${confirmedWonProduct.id},
      ${`recurring::auto::${confirmedWonProduct.id}`}, NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM recurring_billings
      WHERE deal_product_id = ${confirmedWonProduct.id}
         OR source_key = ${`recurring::auto::${confirmedWonProduct.id}`}
    )
  `;

  const targets = new Map(
    [...won, { ...confirmedWonProduct, yomiStatus: "【SNS】受注" }].map((product) => [product.id, product]),
  );
  for (const product of targets.values()) {
    const result = await syncWonProductToPayments(prisma, product.id);
    console.log(JSON.stringify({ company: product.company, product: product.productName, result }));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
