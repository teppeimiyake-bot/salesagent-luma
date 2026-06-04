/**
 * 入金管理（機能5）dealId バックフィル。冪等。
 *
 * InvoiceRecord（スポット）/ RecurringBilling（定期）の dealId が未設定の行について、
 * companyId から当該企業の「受注商談」を解決して dealId を埋める。
 *   - 受注商談 = isWonYomi の DealProduct を1つ以上持つ Deal（deletedAt=null）。
 *   - 候補が複数なら contractDate（降順, null末尾）→ updatedAt（降順）で最新を採用。
 *   - companyId が無い / 該当する受注商談が無い行は null のまま（リンク無し＝プレーン表示）。
 *
 * 冪等性：既に dealId が入っている行はスキップ（上書きしない）。
 *   再解決したい場合は --reassign を付けると、既存 dealId も含めて再計算する。
 *
 * 実行（dev）:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"; npx tsx scripts/backfill-payment-deal.ts
 *   （件数のみ確認・ドライランしたい場合）... scripts/backfill-payment-deal.ts --dry
 *
 * 本番（オーケストレーターが後で実施）:
 *   SEED_ALLOW_PROD=1 DATABASE_URL="<prod>" npx tsx scripts/backfill-payment-deal.ts
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（他DB誤爆防止）。
 *   本番DBに対しては SEED_ALLOW_PROD=1 が必須。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isWonYomi } from "../src/lib/yomi-status";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const DRY = process.argv.includes("--dry");
const REASSIGN = process.argv.includes("--reassign");

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/**
 * companyId → 受注商談Deal.id を解決。
 * 受注商談が無ければ null。複数あれば contractDate→updatedAt で最新。
 */
async function resolveWonDealId(companyId: string): Promise<string | null> {
  const deals = await prisma.deal.findMany({
    where: { companyId, deletedAt: null },
    select: {
      id: true,
      contractDate: true,
      updatedAt: true,
      products: { select: { yomiStatus: true } },
    },
    // 最新が先頭に来るよう並べる（null contractDate は末尾になるよう後段で調整）
    orderBy: [{ updatedAt: "desc" }],
  });

  const won = deals.filter((d) => d.products.some((p) => isWonYomi(p.yomiStatus)));
  if (won.length === 0) return null;

  won.sort((a, b) => {
    const at = a.contractDate ? a.contractDate.getTime() : -Infinity;
    const bt = b.contractDate ? b.contractDate.getTime() : -Infinity;
    if (bt !== at) return bt - at; // contractDate 降順（null末尾）
    return b.updatedAt.getTime() - a.updatedAt.getTime(); // updatedAt 降順
  });
  return won[0].id;
}

type Counters = {
  total: number;
  noCompany: number;
  skippedExisting: number;
  noWonDeal: number;
  set: number;
};

async function backfillInvoiceRecords(): Promise<Counters> {
  const c: Counters = { total: 0, noCompany: 0, skippedExisting: 0, noWonDeal: 0, set: 0 };
  const rows = await prisma.invoiceRecord.findMany({
    select: { id: true, companyId: true, dealId: true, customerName: true },
  });
  c.total = rows.length;
  // companyId → dealId の解決をメモ化（同一企業の重複行で再クエリしない）
  const cache = new Map<string, string | null>();
  for (const r of rows) {
    if (r.dealId && !REASSIGN) {
      c.skippedExisting++;
      continue;
    }
    if (!r.companyId) {
      c.noCompany++;
      continue;
    }
    let dealId = cache.get(r.companyId);
    if (dealId === undefined) {
      dealId = await resolveWonDealId(r.companyId);
      cache.set(r.companyId, dealId);
    }
    if (!dealId) {
      c.noWonDeal++;
      continue;
    }
    if (r.dealId === dealId) {
      c.skippedExisting++;
      continue;
    }
    if (!DRY) {
      await prisma.invoiceRecord.update({ where: { id: r.id }, data: { dealId } });
    }
    c.set++;
  }
  return c;
}

async function backfillRecurring(): Promise<Counters> {
  const c: Counters = { total: 0, noCompany: 0, skippedExisting: 0, noWonDeal: 0, set: 0 };
  const rows = await prisma.recurringBilling.findMany({
    select: { id: true, companyId: true, dealId: true, customerName: true },
  });
  c.total = rows.length;
  const cache = new Map<string, string | null>();
  for (const r of rows) {
    if (r.dealId && !REASSIGN) {
      c.skippedExisting++;
      continue;
    }
    if (!r.companyId) {
      c.noCompany++;
      continue;
    }
    let dealId = cache.get(r.companyId);
    if (dealId === undefined) {
      dealId = await resolveWonDealId(r.companyId);
      cache.set(r.companyId, dealId);
    }
    if (!dealId) {
      c.noWonDeal++;
      continue;
    }
    if (r.dealId === dealId) {
      c.skippedExisting++;
      continue;
    }
    if (!DRY) {
      await prisma.recurringBilling.update({ where: { id: r.id }, data: { dealId } });
    }
    c.set++;
  }
  return c;
}

function report(label: string, c: Counters) {
  console.log(
    `[${label}] total=${c.total} set=${c.set} skipped(existing/same)=${c.skippedExisting} noCompany=${c.noCompany} noWonDeal=${c.noWonDeal}`,
  );
}

async function main() {
  console.log(
    `=== backfill-payment-deal ${DRY ? "(DRY RUN)" : ""}${REASSIGN ? " (REASSIGN)" : ""} ===`,
  );
  const inv = await backfillInvoiceRecords();
  report("InvoiceRecord(spot)", inv);
  const rec = await backfillRecurring();
  report("RecurringBilling(recurring)", rec);
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
