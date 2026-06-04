/**
 * 契約書ドラフト自動生成（機能②）のコアロジック。
 *
 * DealProduct のカテゴリ（映像 / SNS）で雛形を出し分け、差込項目を埋めて PDF を生成し、
 * Document(category=contract, scope=deal, status=draft, dealProductId) として格納する。
 *
 * 重複生成防止：同一 dealProductId の category=contract Document が既にあればスキップ。
 * トリガー（A+ヨミ遷移）と手動ボタンの両方から呼ばれる。
 */
import React from "react";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { putFile } from "@/lib/storage";
import { renderPdfBuffer } from "@/lib/pdf/render";
import { VideoContractPdf } from "@/lib/pdf/contract-video-pdf";
import { SnsContractPdf } from "@/lib/pdf/contract-sns-pdf";
import { categoryFromDealProduct } from "@/lib/product-categories";
import { toSeireki } from "@/lib/pdf/format";

const DEFAULT_INITIAL_FEE = 100_000; // SNS初期費用（税抜・既定10万）
const DEFAULT_SNS_MONTHS = 6; // SNS割賦月数（テンプレ既定）

export type ContractGenResult =
  | { ok: true; documentId: string; skipped: false; category: "映像" | "SNS" }
  | { ok: true; documentId: string; skipped: true; category: "映像" | "SNS" }
  | { ok: false; reason: string };

/**
 * 指定 DealProduct から契約書ドラフトを生成して Document を作成する。
 * @param dealProductId 対象 DealProduct
 * @param userId 生成者（uploadedById に記録）
 * @param force true で重複チェックをスキップ（手動で再生成したい場合）
 */
export async function generateContractDraft(
  dealProductId: string,
  userId?: string | null,
  force = false,
): Promise<ContractGenResult> {
  const dp = await prisma.dealProduct.findUnique({
    where: { id: dealProductId },
    include: {
      deal: { include: { company: true } },
      product: { select: { name: true, category: true } },
      productionProject: true,
      recurringBillings: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!dp) return { ok: false, reason: "DealProduct が見つかりません" };

  const category = categoryFromDealProduct(dp);
  if (category !== "映像" && category !== "SNS") {
    return { ok: false, reason: `契約書テンプレ未対応のカテゴリです（${category ?? "不明"}）` };
  }

  // 重複生成防止：この DealProduct の契約書 Document が既にあればスキップ
  if (!force) {
    const existing = await prisma.document.findFirst({
      where: { category: "contract", dealProductId },
      select: { id: true },
    });
    if (existing) {
      return { ok: true, documentId: existing.id, skipped: true, category };
    }
  }

  const clientName = dp.deal.company.name;
  const amount = dp.amount ?? 0;
  const pp = dp.productionProject;
  const rb = dp.recurringBillings[0];

  let element: React.ReactElement;
  let docName: string;

  if (category === "映像") {
    const completionDate = toSeireki(pp?.deliveryDate ?? dp.deal.expectedCloseDate ?? null);
    element = React.createElement(VideoContractPdf, {
      data: {
        clientName,
        deliverable: dp.planName || "PR映像",
        completionDate,
        contractAmount: amount,
        signDate: "",
      },
    });
    docName = `${clientName} 業務委託契約書（映像）`;
  } else {
    // SNS
    const initialFee = rb?.initialFee ?? DEFAULT_INITIAL_FEE;
    const months = DEFAULT_SNS_MONTHS;
    // 月額：RecurringBilling.monthlyFee 優先。無ければ (総額 - 初期費用) / 月数 から逆算。
    let monthlyFee = rb?.monthlyFee ?? 0;
    let totalFee = amount;
    if (monthlyFee > 0) {
      totalFee = initialFee + monthlyFee * months;
    } else if (amount > initialFee) {
      monthlyFee = Math.round((amount - initialFee) / months);
      totalFee = amount;
    }
    const periodStart = toSeireki(pp?.serviceStartMonth ?? rb?.startDate ?? null);
    const periodEnd = toSeireki(pp?.serviceEndMonth ?? rb?.endDate ?? null);
    element = React.createElement(SnsContractPdf, {
      data: {
        clientName,
        periodStart,
        periodEnd,
        totalFee,
        initialFee,
        monthlyFee,
        months,
        signDate: "",
      },
    });
    docName = `${clientName} 業務委託契約書（SNS運用）`;
  }

  const buffer = await renderPdfBuffer(element);
  const filename = `contract_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.pdf`;
  const { url: fileUrl } = await putFile({
    dir: "documents",
    filename,
    buffer,
    contentType: "application/pdf",
  });

  const doc = await prisma.document.create({
    data: {
      name: docName,
      category: "contract",
      sourceType: "file",
      scope: "deal",
      status: "draft",
      dealId: dp.dealId,
      dealProductId,
      description: "A+ヨミ遷移時に自動生成されたドラフト（要確認・手修正可）",
      version: "draft",
      fileUrl,
      fileSize: buffer.length,
      mimeType: "application/pdf",
      uploadedById: userId ?? null,
      tags: [category, "自動生成"],
    },
  });

  return { ok: true, documentId: doc.id, skipped: false, category };
}

/**
 * yomiStatus が「A+ヨミ」系へ遷移したかを判定する。
 * 接頭辞（【映像】等）込み・表記ゆれ（A＋/A+/プラス）を吸収。
 */
export function isAPlusYomi(yomi: string | null | undefined): boolean {
  if (!yomi) return false;
  // 接頭辞除去せずに部分一致でOK（"【映像】A+ヨミ" 等）
  return /A[＋+]ヨミ|Aプラスヨミ/.test(yomi);
}
