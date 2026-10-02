/**
 * 受注した DealProduct を入金管理へ同期する。
 * SNS は定期、それ以外はスポットへ、会社単位ではなく商材単位で登録する。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { prisma } from "@/lib/db";
import { categoryFromDealProduct } from "@/lib/product-categories";
import { isWonYomi } from "@/lib/yomi-status";
import { grossFromNet } from "@/lib/payments";

type Db = typeof prisma | PrismaClient | Prisma.TransactionClient;

export type PaymentSyncResult =
  | { created: true; paymentType: "spot"; invoiceRecordId: string; reason: "won_product" | "moved_from_recurring" }
  | { created: true; paymentType: "recurring"; recurringBillingId: string; reason: "won_product" | "moved_from_spot" }
  | { created: false; reason: "not_won" | "no_company" | "already_synced" };

/**
 * 受注商材に対応する入金管理レコードを冪等に作成する。
 * 誤ったタブにある未入力の自動生成行は正しいタブへ移す。
 */
export async function syncWonProductToPayments(
  db: Db,
  dealProductId: string,
): Promise<PaymentSyncResult> {
  const dp = await db.dealProduct.findUnique({
    where: { id: dealProductId },
    select: {
      id: true,
      productName: true,
      yomiStatus: true,
      amount: true,
      product: { select: { name: true, category: true } },
      deal: {
        select: {
          id: true,
          deletedAt: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!dp?.deal || dp.deal.deletedAt || !isWonYomi(dp.yomiStatus)) {
    return { created: false, reason: "not_won" };
  }
  const company = dp.deal.company;
  if (!company) return { created: false, reason: "no_company" };

  const isSns = categoryFromDealProduct(dp) === "SNS";
  const spotSourceKey = `spot::auto::${dp.id}`;
  const recurringSourceKey = `recurring::auto::${dp.id}`;

  if (isSns) {
    const existing = await db.recurringBilling.findFirst({
      where: { OR: [{ dealProductId: dp.id }, { sourceKey: recurringSourceKey }] },
      select: { id: true },
    });
    if (existing) return { created: false, reason: "already_synced" };

    const wrongSpot = await db.invoiceRecord.findFirst({
      where: { sourceKey: spotSourceKey, dealProductId: dp.id },
      select: {
        id: true,
        invoiceStatus: true,
        paymentStatus: true,
        deliveryDate: true,
        expectedPaymentDate: true,
        note: true,
      },
    });
    const canMoveWrongSpot =
      wrongSpot?.invoiceStatus === "NOT_SENT" &&
      wrongSpot.paymentStatus === "UNCONFIRMED" &&
      wrongSpot.deliveryDate == null &&
      wrongSpot.expectedPaymentDate == null;

    const created = await db.recurringBilling.create({
      data: {
        sourceKey: recurringSourceKey,
        customerName: company.name,
        companyId: company.id,
        dealId: dp.deal.id,
        dealProductId: dp.id,
        note: canMoveWrongSpot ? wrongSpot.note : null,
      },
      select: { id: true },
    });
    if (canMoveWrongSpot) await db.invoiceRecord.delete({ where: { id: wrongSpot.id } });

    return {
      created: true,
      paymentType: "recurring",
      recurringBillingId: created.id,
      reason: canMoveWrongSpot ? "moved_from_spot" : "won_product",
    };
  }

  const existing = await db.invoiceRecord.findFirst({
    where: { OR: [{ dealProductId: dp.id }, { sourceKey: spotSourceKey }] },
    select: { id: true },
  });
  if (existing) return { created: false, reason: "already_synced" };

  const wrongRecurring = await db.recurringBilling.findFirst({
    where: { sourceKey: recurringSourceKey, dealProductId: dp.id },
    select: {
      id: true,
      initialFee: true,
      monthlyFee: true,
      startDate: true,
      endDate: true,
      note: true,
      periods: { select: { id: true }, take: 1 },
    },
  });
  const canMoveWrongRecurring =
    wrongRecurring != null &&
    wrongRecurring.initialFee == null &&
    wrongRecurring.monthlyFee == null &&
    wrongRecurring.startDate == null &&
    wrongRecurring.endDate == null &&
    wrongRecurring.periods.length === 0;

  const net = dp.amount ?? null;
  const created = await db.invoiceRecord.create({
    data: {
      sourceKey: spotSourceKey,
      customerName: company.name,
      companyId: company.id,
      dealId: dp.deal.id,
      dealProductId: dp.id,
      paymentTiming: "PREPAID",
      contractStatus: "SIGNED",
      invoiceStatus: "NOT_SENT",
      paymentStatus: "UNCONFIRMED",
      amountNet: net,
      amountGross: grossFromNet(net),
      note: canMoveWrongRecurring ? wrongRecurring.note : "受注ステータスへの遷移で自動作成",
    },
    select: { id: true },
  });
  if (canMoveWrongRecurring) await db.recurringBilling.delete({ where: { id: wrongRecurring.id } });

  return {
    created: true,
    paymentType: "spot",
    invoiceRecordId: created.id,
    reason: canMoveWrongRecurring ? "moved_from_recurring" : "won_product",
  };
}
