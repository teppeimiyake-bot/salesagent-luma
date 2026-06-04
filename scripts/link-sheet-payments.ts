/**
 * 入金管理 Phase 10：シート由来行（source_key='spot::'/'recurring::'）を
 * 企業 / 商談 / 受注プロダクトへ紐付ける。冪等。
 *
 * 紐付けロジック（各シート行）：
 *   1. companyId
 *      - 既に設定済みなら維持（--reapply で再解決）。
 *      - normalizeName が「ちょうど1社」に一致 → その会社。
 *      - 上記不能 → 手動エイリアス表（payment-company-aliases.ts）。
 *      - なお不能 → null（未紐付けレポートに出力）。
 *   2. dealId
 *      - companyId の受注(isWonYomi)を含む商談を採用。
 *        受注商談が複数なら受注プロダクト数が多い／金額最大の商談（安定のため id でタイブレーク）。
 *        受注商談が無ければ、その会社の唯一の商談（deletedAt=null）があればそれ。
 *   3. dealProductId
 *      - 商談内の受注プロダクトのうち、入金区分（spot=非SNS / recurring=SNS）に合うものを抽出。
 *        ちょうど1件 → 確定。複数 → カテゴリだけでは絞れないため null（金額連動はスキップ）。
 *
 * 既存データ破壊なし：customerName / 金額 / ステータスは触らない（FKのみ設定）。
 *
 * 実行（dev）:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx scripts/link-sheet-payments.ts            # 実行
 *   npx tsx scripts/link-sheet-payments.ts --dry      # 件数のみ
 *   npx tsx scripts/link-sheet-payments.ts --reapply  # companyId も再解決
 *
 * 本番（オーケストレーターが後で実施）:
 *   SEED_ALLOW_PROD=1 DATABASE_URL="<prod>" npx tsx scripts/link-sheet-payments.ts
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（本番は SEED_ALLOW_PROD=1 必須）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { normalizeName } from "../src/lib/company-dedup";
import { isWonYomi } from "../src/lib/yomi-status";
import { categoryFromDealProduct } from "../src/lib/product-categories";
import { PAYMENT_COMPANY_ALIASES } from "./payment-company-aliases";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const DRY = process.argv.includes("--dry");
const REAPPLY = process.argv.includes("--reapply");

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

type DealProductLite = {
  id: string;
  productName: string;
  amount: number | null;
  yomiStatus: string | null;
  isSns: boolean;
};
type DealLite = {
  id: string;
  wonProducts: DealProductLite[];
  allProductCount: number;
};
type CompanyLite = {
  id: string;
  name: string;
  deals: DealLite[];
};

// companyId 解決用インデックス（正規化名 → 会社id配列）
async function buildCompanyIndex() {
  const companies = await prisma.company.findMany({
    where: { deletedAt: null, mergedIntoId: null },
    select: {
      id: true,
      name: true,
      deals: {
        where: { deletedAt: null },
        select: {
          id: true,
          products: {
            select: {
              id: true,
              productName: true,
              amount: true,
              yomiStatus: true,
              product: { select: { name: true, category: true } },
            },
          },
        },
      },
    },
  });

  const byId = new Map<string, CompanyLite>();
  const byNorm = new Map<string, string[]>();
  for (const c of companies) {
    const deals: DealLite[] = c.deals.map((d) => ({
      id: d.id,
      allProductCount: d.products.length,
      wonProducts: d.products
        .filter((p) => isWonYomi(p.yomiStatus))
        .map((p) => ({
          id: p.id,
          productName: p.productName,
          amount: p.amount ?? null,
          yomiStatus: p.yomiStatus,
          isSns: categoryFromDealProduct(p) === "SNS",
        })),
    }));
    byId.set(c.id, { id: c.id, name: c.name, deals });
    const k = normalizeName(c.name);
    if (k) {
      const arr = byNorm.get(k) ?? [];
      arr.push(c.id);
      byNorm.set(k, arr);
    }
  }
  return { byId, byNorm };
}

function resolveCompanyId(
  customerName: string,
  byNorm: Map<string, string[]>,
): { companyId: string | null; via: "norm" | "alias" | "none" } {
  // 1. 正規化名で一意
  const norm = normalizeName(customerName);
  const ids = norm ? byNorm.get(norm) : undefined;
  if (ids && ids.length === 1) return { companyId: ids[0], via: "norm" };
  // 2. 手動エイリアス
  const alias = PAYMENT_COMPANY_ALIASES[customerName];
  if (alias) return { companyId: alias, via: "alias" };
  return { companyId: null, via: "none" };
}

/** 会社から「受注を含む商談」を選ぶ（受注プロダクト数→合計金額→id でタイブレーク） */
function pickDeal(company: CompanyLite): DealLite | null {
  const wonDeals = company.deals.filter((d) => d.wonProducts.length > 0);
  const pool0 = wonDeals.length > 0 ? wonDeals : company.deals;
  if (pool0.length === 0) return null;
  const sorted = [...pool0].sort((a, b) => {
    if (b.wonProducts.length !== a.wonProducts.length)
      return b.wonProducts.length - a.wonProducts.length;
    const sa = a.wonProducts.reduce((s, p) => s + (p.amount ?? 0), 0);
    const sb = b.wonProducts.reduce((s, p) => s + (p.amount ?? 0), 0);
    if (sb !== sa) return sb - sa;
    return a.id < b.id ? -1 : 1;
  });
  return sorted[0];
}

/**
 * 商談から、入金区分（spot=非SNS / recurring=SNS）に合う受注プロダクトを「ちょうど1件」なら返す。
 */
function pickDealProduct(deal: DealLite, wantSns: boolean): string | null {
  const matches = deal.wonProducts.filter((p) => p.isSns === wantSns);
  if (matches.length === 1) return matches[0].id;
  return null;
}

async function linkModel(
  kind: "spot" | "recurring",
  byId: Map<string, CompanyLite>,
  byNorm: Map<string, string[]>,
) {
  const wantSns = kind === "recurring";
  const prefix = `${kind}::`;
  const stats = {
    total: 0,
    companyLinked: 0,
    viaNorm: 0,
    viaAlias: 0,
    companyUnmatched: 0,
    dealLinked: 0,
    dealProductLinked: 0,
    unmatchedNames: [] as string[],
    dpAmbiguous: [] as string[],
  };

  const rows =
    kind === "spot"
      ? await prisma.invoiceRecord.findMany({
          where: { sourceKey: { startsWith: prefix } },
          select: { id: true, customerName: true, companyId: true, dealId: true, dealProductId: true },
        })
      : await prisma.recurringBilling.findMany({
          where: { sourceKey: { startsWith: prefix } },
          select: { id: true, customerName: true, companyId: true, dealId: true, dealProductId: true },
        });

  for (const r of rows) {
    stats.total++;

    // 1. companyId
    let companyId = r.companyId;
    if (!companyId || REAPPLY) {
      const res = resolveCompanyId(r.customerName, byNorm);
      if (res.companyId) {
        companyId = res.companyId;
        if (res.via === "norm") stats.viaNorm++;
        else if (res.via === "alias") stats.viaAlias++;
      }
    }
    if (!companyId) {
      stats.companyUnmatched++;
      stats.unmatchedNames.push(r.customerName);
      continue; // 会社不明なら商談/プロダクトも辿れない
    }
    stats.companyLinked++;

    // 2. dealId / 3. dealProductId
    const company = byId.get(companyId) ?? null;
    let dealId: string | null = r.dealId;
    let dealProductId: string | null = r.dealProductId;
    if (company) {
      const deal = pickDeal(company);
      if (deal) {
        dealId = deal.id;
        const dp = pickDealProduct(deal, wantSns);
        if (dp) {
          dealProductId = dp;
        } else {
          dealProductId = null;
          if (deal.wonProducts.some((p) => p.isSns === wantSns)) {
            stats.dpAmbiguous.push(`${company.name}（${r.customerName}）`);
          }
        }
      }
    }
    if (dealId) stats.dealLinked++;
    if (dealProductId) stats.dealProductLinked++;

    if (!DRY) {
      const data = { companyId, dealId, dealProductId };
      if (kind === "spot") {
        await prisma.invoiceRecord.update({ where: { id: r.id }, data });
      } else {
        await prisma.recurringBilling.update({ where: { id: r.id }, data });
      }
    }
  }
  return stats;
}

async function main() {
  console.log(`=== link-sheet-payments ${DRY ? "(DRY)" : ""}${REAPPLY ? " (REAPPLY)" : ""} ===`);
  const { byId, byNorm } = await buildCompanyIndex();

  for (const kind of ["spot", "recurring"] as const) {
    const s = await linkModel(kind, byId, byNorm);
    console.log(
      `\n[${kind}] 行=${s.total} 会社紐付=${s.companyLinked}(norm=${s.viaNorm}/alias=${s.viaAlias}) ` +
        `商談紐付=${s.dealLinked} プロダクト紐付=${s.dealProductLinked} 会社未マッチ=${s.companyUnmatched}`,
    );
    if (s.unmatchedNames.length) {
      console.log(`  [会社未マッチ ${s.unmatchedNames.length}社（社長へ社名確認）]`);
      for (const n of s.unmatchedNames) console.log(`    - ${n}`);
    }
    if (s.dpAmbiguous.length) {
      console.log(`  [プロダクト未確定 ${s.dpAmbiguous.length}件（同区分の受注プロダクトが複数）]`);
      for (const n of s.dpAmbiguous) console.log(`    - ${n}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
