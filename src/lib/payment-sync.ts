/**
 * 受注 → 入金管理 の自動連携（依頼1の仕組み化）。
 *
 * 背景・設計判断：
 *   入金管理の正本はスプレッドシート由来の行（sourceKey='spot::%' / 'recurring::%'）。
 *   過去 Phase 9 で「受注 DealProduct 全件」から一括生成（sourceKey='dpid::%'）したが、
 *   シートに無い空行を大量に生んで不整合になり、Phase 10 で 'dpid::' を全削除した。
 *
 *   今回は「全件一括」ではなく「受注ステータスへ遷移したイベント時に1件ずつ」生成する。
 *   生成行の sourceKey は 'spot::auto::<dealProductId>' とし、spot 一覧 GET の
 *   `startsWith: "spot::"` フィルタにそのまま乗せる（UIフィルタ変更不要）。
 *   過去の 'dpid::' とは名前空間が異なるため cleanup スクリプトとも干渉しない。
 *
 * 冪等性（重複作成しないルール）：
 *   1) この DealProduct から既に自動生成済み（sourceKey='spot::auto::<dpId>'）→ 何もしない。
 *   2) 同じ会社(companyId)について、シート由来 or 他の入金レコードが既にある → 何もしない。
 *      （= 既に入金管理に存在する受注企業は重複作成しない、という依頼の要件）
 *   3) 上記いずれにも当たらない初出の受注会社 → 1件作成する。
 *
 * 区分（スポット/定期）：
 *   入金管理タブの「スポット」(InvoiceRecord) に作成する。
 *   SNS（定期/月額）は RecurringBilling 側だが、月次セル設計が重く、受注直後の
 *   自動起票には不向きなため、まずスポット行で起票し、定期へは運用で振替える方針。
 *   （依頼は「入金管理タブにレコードが作成・反映される」こと。スポットで満たす。）
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { isWonYomi } from "@/lib/yomi-status";
import { grossFromNet } from "@/lib/payments";

/** トランザクションでも通常クライアントでも受けられる最小型 */
type Db = PrismaClient | Prisma.TransactionClient;

export type PaymentSyncResult =
  | { created: true; invoiceRecordId: string; reason: "first_won_company" }
  | { created: false; reason: "not_won" | "no_company" | "already_auto" | "company_covered" };

/**
 * 指定 DealProduct が受注になったとき、入金管理（スポット）レコードを未作成なら1件作成する。
 * - 受注（isWonYomi）でなければ何もしない。
 * - 会社が無ければ何もしない（顧客名だけでは重複判定できないため）。
 * - 既にこの DealProduct から自動生成済み / 同じ会社の入金レコードが存在すれば作らない。
 *
 * @param db prisma クライアント（or トランザクションクライアント）
 * @param dealProductId 受注になった DealProduct の id
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
      deal: {
        select: {
          id: true,
          deletedAt: true,
          companyId: true,
          company: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!dp || !dp.deal || dp.deal.deletedAt) return { created: false, reason: "not_won" };
  if (!isWonYomi(dp.yomiStatus)) return { created: false, reason: "not_won" };

  const company = dp.deal.company;
  if (!company) return { created: false, reason: "no_company" };

  const sourceKey = `spot::auto::${dp.id}`;

  // ルール1：この DealProduct から既に自動生成済みなら何もしない
  const existingAuto = await db.invoiceRecord.findUnique({
    where: { sourceKey },
    select: { id: true },
  });
  if (existingAuto) return { created: false, reason: "already_auto" };

  // ルール2：同じ会社について、既に入金レコードが存在するなら重複作成しない
  //   （シート由来 spot:: / 他の自動生成 / 手入力、いずれも含む）
  const companyCovered = await db.invoiceRecord.findFirst({
    where: { companyId: company.id },
    select: { id: true },
  });
  if (companyCovered) return { created: false, reason: "company_covered" };

  // ルール3：初出の受注会社 → スポット入金レコードを1件作成
  const net = dp.amount ?? null;
  const created = await db.invoiceRecord.create({
    data: {
      sourceKey,
      customerName: company.name,
      companyId: company.id,
      dealId: dp.deal.id,
      dealProductId: dp.id,
      // 受注＝契約済み。前払いポリシー（Lumaは前払い必須）に合わせ既定値を設定。
      paymentTiming: "PREPAID",
      contractStatus: "SIGNED",
      invoiceStatus: "NOT_SENT",
      paymentStatus: "UNCONFIRMED",
      amountNet: net,
      amountGross: grossFromNet(net),
      note: "受注ステータスへの遷移で自動作成",
    },
    select: { id: true },
  });

  return { created: true, invoiceRecordId: created.id, reason: "first_won_company" };
}
