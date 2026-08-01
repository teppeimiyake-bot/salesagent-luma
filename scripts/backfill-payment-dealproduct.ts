/**
 * 入金管理 Phase 9：プロダクト単位化のバックフィル。冪等。
 *
 * 目的：
 *   受注（isWonYomi）の DealProduct 単位で InvoiceRecord（スポット）/
 *   RecurringBilling（定期）のエントリを1件ずつ用意し、
 *   dealProductId / dealId / companyId を設定する。
 *     - SNS カテゴリ        → 定期（RecurringBilling）
 *     - 非SNS（映像/CATV/アライアンス/不明）→ スポット（InvoiceRecord）
 *
 * 既存CSV由来エントリ（sourceKey が "spot::" / "recurring::" で始まる行）の
 * 入金ステータス（送付/着金/契約締結/支払時期/日付/金額/note）を、
 * 会社（＋スポット/定期の区分）一致で該当プロダクトのエントリへ引き継ぐ。
 *   - 会社内に対象プロダクトが1件 → そのCSV行の値をそのまま採用。
 *   - 会社内に複数 → CSV行（同一会社の複数行も含む）を amount 降順「主要」順に
 *     プロダクトへ1対1で割当。割当先が尽きた残プロダクトはブランク開始（ログ出力）。
 *   - CSV行が無い会社のプロダクト → ブランク開始。
 *
 * 冪等キー：プロダクト単位エントリは sourceKey = "dpid::<dealProductId>"。
 *   再実行すると dealProductId/dealId/companyId は常に再設定。
 *   ステータスの引き継ぎは「まだ引き継いでいない（ステータスがデフォルトのまま）」
 *   エントリにのみ適用し、人手で編集済みの値は壊さない（--reapply で強制再適用）。
 *
 * 既存CSV由来エントリ（sourceKey="spot::"/"recurring::"）は dealProductId を持たない
 * 「ソース行」として残す（削除しない）。UIは dealProductId を持つ行のみ表示する想定。
 *   → 表示重複を避けるため、引き継ぎ完了後に CSVソース行を論理的に無効化したい場合は
 *     --archive-source を付けると customerName 先頭に "(旧)" を付け note にマークする
 *     （デフォルトはマークのみ・残す）。本番方針はオーケストレーター判断。
 *
 * 実行（dev）:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx scripts/backfill-payment-dealproduct.ts            # 実行
 *   npx tsx scripts/backfill-payment-dealproduct.ts --dry      # ドライラン（件数のみ）
 *
 * 本番（オーケストレーターが後で実施）:
 *   SEED_ALLOW_PROD=1 DATABASE_URL="<prod>" npx tsx scripts/backfill-payment-dealproduct.ts
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（本番は SEED_ALLOW_PROD=1 必須）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isWonYomi } from "../src/lib/yomi-status";
import { categoryFromDealProduct } from "../src/lib/product-categories";
import { grossFromNet } from "../src/lib/payments";
import { LUMA_TENANT_ID } from "../prisma/tenant-ids";

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

type WonProduct = {
  id: string;
  dealId: string;
  companyId: string | null;
  productName: string;
  amount: number | null;
  isSns: boolean;
};

// ---------- 受注DealProduct 抽出 ----------
async function loadWonProducts(): Promise<WonProduct[]> {
  const dps = await prisma.dealProduct.findMany({
    select: {
      id: true,
      amount: true,
      productName: true,
      yomiStatus: true,
      deal: { select: { id: true, companyId: true, deletedAt: true } },
      product: { select: { name: true, category: true } },
    },
  });
  const out: WonProduct[] = [];
  for (const dp of dps) {
    if (!dp.deal || dp.deal.deletedAt) continue;
    if (!isWonYomi(dp.yomiStatus)) continue;
    const cat = categoryFromDealProduct(dp);
    out.push({
      id: dp.id,
      dealId: dp.deal.id,
      companyId: dp.deal.companyId,
      productName: dp.productName,
      amount: dp.amount ?? null,
      isSns: cat === "SNS",
    });
  }
  return out;
}

// ---------- スポット（InvoiceRecord）----------
type InvoiceDefaults = {
  paymentTiming: "PREPAID" | "ON_DELIVERY" | "INSTALLMENT";
  contractStatus: "SIGNED" | "UNSIGNED";
  invoiceStatus: "SENT" | "NOT_SENT" | "PARTIAL_SENT";
  paymentStatus: "CONFIRMED" | "UNCONFIRMED" | "PARTIAL_CONFIRMED";
  deliveryDate: Date | null;
  expectedPaymentDate: Date | null;
  amountNet: number | null;
  amountGross: number | null;
  note: string | null;
};

function isDefaultInvoiceStatus(r: {
  paymentTiming: string;
  contractStatus: string;
  invoiceStatus: string;
  paymentStatus: string;
  amountNet: number | null;
  deliveryDate: Date | null;
  expectedPaymentDate: Date | null;
}): boolean {
  // 「まだ何も引き継いでいない初期状態」の判定（デフォルト enum かつ金額/日付未設定）
  return (
    r.paymentTiming === "PREPAID" &&
    r.contractStatus === "SIGNED" &&
    r.invoiceStatus === "NOT_SENT" &&
    r.paymentStatus === "UNCONFIRMED" &&
    r.amountNet == null &&
    r.deliveryDate == null &&
    r.expectedPaymentDate == null
  );
}

async function backfillSpot(wonSpot: WonProduct[]) {
  const stats = {
    products: wonSpot.length,
    entriesUpserted: 0,
    carriedOver: 0,
    blank: 0,
    csvSourceRows: 0,
    csvUnmatched: 0,
  };

  // 既存 CSV由来スポット行（引き継ぎ元）。会社ごとにグルーピング。
  const csvRows = await prisma.invoiceRecord.findMany({
    where: { sourceKey: { startsWith: "spot::" }, dealProductId: null },
    select: {
      id: true,
      companyId: true,
      customerName: true,
      paymentTiming: true,
      contractStatus: true,
      invoiceStatus: true,
      paymentStatus: true,
      deliveryDate: true,
      expectedPaymentDate: true,
      amountNet: true,
      amountGross: true,
      note: true,
    },
  });
  stats.csvSourceRows = csvRows.length;

  const csvByCompany = new Map<string, InvoiceDefaults[]>();
  let csvNoCompany = 0;
  for (const r of csvRows) {
    if (!r.companyId) {
      csvNoCompany++;
      continue;
    }
    const arr = csvByCompany.get(r.companyId) ?? [];
    arr.push({
      paymentTiming: r.paymentTiming,
      contractStatus: r.contractStatus,
      invoiceStatus: r.invoiceStatus,
      paymentStatus: r.paymentStatus,
      deliveryDate: r.deliveryDate,
      expectedPaymentDate: r.expectedPaymentDate,
      amountNet: r.amountNet,
      amountGross: r.amountGross,
      note: r.note,
    });
    csvByCompany.set(r.companyId, arr);
  }
  stats.csvUnmatched = csvNoCompany;

  // 会社→受注プロダクト群（amount降順=主要順）
  const prodByCompany = new Map<string, WonProduct[]>();
  for (const p of wonSpot) {
    const key = p.companyId ?? "__none__";
    const arr = prodByCompany.get(key) ?? [];
    arr.push(p);
    prodByCompany.set(key, arr);
  }
  for (const arr of prodByCompany.values()) {
    arr.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  }

  // 会社ごとに CSV値（amountNet降順=主要順）をプロダクトへ1対1割当
  const assign = new Map<string, InvoiceDefaults | null>(); // dealProductId -> carry値 or null(ブランク)
  for (const [companyKey, prods] of prodByCompany) {
    const csv = (companyKey === "__none__" ? [] : csvByCompany.get(companyKey) ?? []).slice();
    csv.sort((a, b) => (b.amountNet ?? -1) - (a.amountNet ?? -1));
    for (let i = 0; i < prods.length; i++) {
      assign.set(prods[i].id, i < csv.length ? csv[i] : null);
    }
  }

  for (const p of wonSpot) {
    const carry = assign.get(p.id) ?? null;
    const sourceKey = `dpid::${p.id}`;
    const existing = await prisma.invoiceRecord.findUnique({
      where: { tenantId_sourceKey: { tenantId: LUMA_TENANT_ID, sourceKey } },
      select: {
        id: true,
        paymentTiming: true,
        contractStatus: true,
        invoiceStatus: true,
        paymentStatus: true,
        amountNet: true,
        deliveryDate: true,
        expectedPaymentDate: true,
      },
    });

    // 契約金額(税抜)既定 = 提案金額(DealProduct.amount)。着金(税込)=×1.1。
    const proposalNet = p.amount ?? null;

    // 引き継ぎ値（あれば）を優先、無ければ提案金額ベースのブランク初期。
    const data: Record<string, unknown> = {
      customerName: p.productName, // 表示は商談リンクで会社名が出る。原文は商材名。
      companyId: p.companyId,
      dealId: p.dealId,
      dealProductId: p.id,
    };

    const shouldApplyStatus =
      REAPPLY || !existing || (existing && isDefaultInvoiceStatus(existing));

    if (shouldApplyStatus) {
      if (carry) {
        data.paymentTiming = carry.paymentTiming;
        data.contractStatus = carry.contractStatus;
        data.invoiceStatus = carry.invoiceStatus;
        data.paymentStatus = carry.paymentStatus;
        data.deliveryDate = carry.deliveryDate;
        data.expectedPaymentDate = carry.expectedPaymentDate;
        // 金額：CSV値があればそれ、無ければ提案金額。
        data.amountNet = carry.amountNet ?? proposalNet;
        data.amountGross = carry.amountGross ?? grossFromNet(carry.amountNet ?? proposalNet);
        data.note = carry.note;
        stats.carriedOver++;
      } else {
        // ブランク開始（提案金額だけセット）
        data.amountNet = proposalNet;
        data.amountGross = grossFromNet(proposalNet);
        stats.blank++;
      }
    }

    if (!DRY) {
      await prisma.invoiceRecord.upsert({
        where: { tenantId_sourceKey: { tenantId: LUMA_TENANT_ID, sourceKey } },
        create: {
          sourceKey,
          customerName: data.customerName as string,
          companyId: data.companyId as string | null,
          dealId: data.dealId as string,
          dealProductId: data.dealProductId as string,
          ...(shouldApplyStatus
            ? {
                paymentTiming: (data.paymentTiming as InvoiceDefaults["paymentTiming"]) ?? "PREPAID",
                contractStatus:
                  (data.contractStatus as InvoiceDefaults["contractStatus"]) ?? "SIGNED",
                invoiceStatus:
                  (data.invoiceStatus as InvoiceDefaults["invoiceStatus"]) ?? "NOT_SENT",
                paymentStatus:
                  (data.paymentStatus as InvoiceDefaults["paymentStatus"]) ?? "UNCONFIRMED",
                deliveryDate: (data.deliveryDate as Date | null) ?? null,
                expectedPaymentDate: (data.expectedPaymentDate as Date | null) ?? null,
                amountNet: (data.amountNet as number | null) ?? null,
                amountGross: (data.amountGross as number | null) ?? null,
                note: (data.note as string | null) ?? null,
              }
            : {}),
        },
        update: data,
      });
    }
    stats.entriesUpserted++;
  }
  return stats;
}

// ---------- 定期（RecurringBilling）----------
async function backfillRecurring(wonSns: WonProduct[]) {
  const stats = {
    products: wonSns.length,
    entriesUpserted: 0,
    carriedOver: 0,
    blank: 0,
    csvSourceRows: 0,
    csvUnmatched: 0,
  };

  const csvRows = await prisma.recurringBilling.findMany({
    where: { sourceKey: { startsWith: "recurring::" }, dealProductId: null },
    select: {
      id: true,
      companyId: true,
      initialFee: true,
      monthlyFee: true,
      startDate: true,
      endDate: true,
      note: true,
      periods: { select: { yearMonth: true, sent: true, paid: true } },
    },
  });
  stats.csvSourceRows = csvRows.length;

  type RecCarry = (typeof csvRows)[number];
  const csvByCompany = new Map<string, RecCarry[]>();
  let csvNoCompany = 0;
  for (const r of csvRows) {
    if (!r.companyId) {
      csvNoCompany++;
      continue;
    }
    const arr = csvByCompany.get(r.companyId) ?? [];
    arr.push(r);
    csvByCompany.set(r.companyId, arr);
  }
  stats.csvUnmatched = csvNoCompany;

  const prodByCompany = new Map<string, WonProduct[]>();
  for (const p of wonSns) {
    const key = p.companyId ?? "__none__";
    const arr = prodByCompany.get(key) ?? [];
    arr.push(p);
    prodByCompany.set(key, arr);
  }
  for (const arr of prodByCompany.values()) {
    arr.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  }

  const assign = new Map<string, RecCarry | null>();
  for (const [companyKey, prods] of prodByCompany) {
    const csv = (companyKey === "__none__" ? [] : csvByCompany.get(companyKey) ?? []).slice();
    csv.sort((a, b) => (b.monthlyFee ?? -1) - (a.monthlyFee ?? -1));
    for (let i = 0; i < prods.length; i++) {
      assign.set(prods[i].id, i < csv.length ? csv[i] : null);
    }
  }

  for (const p of wonSns) {
    const carry = assign.get(p.id) ?? null;
    const sourceKey = `dpid::${p.id}`;
    const existing = await prisma.recurringBilling.findUnique({
      where: { tenantId_sourceKey: { tenantId: LUMA_TENANT_ID, sourceKey } },
      select: {
        id: true,
        initialFee: true,
        monthlyFee: true,
        startDate: true,
        endDate: true,
        periods: { select: { id: true } },
      },
    });

    const isDefault =
      existing && existing.initialFee == null && existing.monthlyFee == null &&
      existing.startDate == null && existing.endDate == null && existing.periods.length === 0;
    const shouldApplyStatus = REAPPLY || !existing || isDefault;

    const data: Record<string, unknown> = {
      customerName: p.productName,
      companyId: p.companyId,
      dealId: p.dealId,
      dealProductId: p.id,
    };
    if (shouldApplyStatus && carry) {
      data.initialFee = carry.initialFee;
      data.monthlyFee = carry.monthlyFee;
      data.startDate = carry.startDate;
      data.endDate = carry.endDate;
      data.note = carry.note;
      stats.carriedOver++;
    } else if (shouldApplyStatus) {
      stats.blank++;
    }

    if (!DRY) {
      const billing = await prisma.recurringBilling.upsert({
        where: { tenantId_sourceKey: { tenantId: LUMA_TENANT_ID, sourceKey } },
        create: {
          sourceKey,
          customerName: data.customerName as string,
          companyId: data.companyId as string | null,
          dealId: data.dealId as string,
          dealProductId: data.dealProductId as string,
          ...(shouldApplyStatus && carry
            ? {
                initialFee: carry.initialFee,
                monthlyFee: carry.monthlyFee,
                startDate: carry.startDate,
                endDate: carry.endDate,
                note: carry.note,
              }
            : {}),
        },
        update: data,
      });
      // 月次セルの引き継ぎ（新規 or デフォルトの時だけ）
      if (shouldApplyStatus && carry && carry.periods.length > 0) {
        for (const pr of carry.periods) {
          await prisma.recurringBillingPeriod.upsert({
            where: { billingId_yearMonth: { billingId: billing.id, yearMonth: pr.yearMonth } },
            create: { billingId: billing.id, yearMonth: pr.yearMonth, sent: pr.sent, paid: pr.paid },
            update: { sent: pr.sent, paid: pr.paid },
          });
        }
      }
    }
    stats.entriesUpserted++;
  }
  return stats;
}

async function main() {
  console.log(`=== backfill-payment-dealproduct ${DRY ? "(DRY RUN)" : ""}${REAPPLY ? " (REAPPLY)" : ""} ===`);
  const won = await loadWonProducts();
  const wonSpot = won.filter((p) => !p.isSns);
  const wonSns = won.filter((p) => p.isSns);
  console.log(`受注DealProduct: ${won.length}（スポット=${wonSpot.length} / 定期(SNS)=${wonSns.length}）`);

  const spot = await backfillSpot(wonSpot);
  console.log(
    `[spot] products=${spot.products} upserted=${spot.entriesUpserted} carried=${spot.carriedOver} blank=${spot.blank} csvSrc=${spot.csvSourceRows} csvNoCompany=${spot.csvUnmatched}`,
  );
  const rec = await backfillRecurring(wonSns);
  console.log(
    `[recurring] products=${rec.products} upserted=${rec.entriesUpserted} carried=${rec.carriedOver} blank=${rec.blank} csvSrc=${rec.csvSourceRows} csvNoCompany=${rec.csvUnmatched}`,
  );
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
