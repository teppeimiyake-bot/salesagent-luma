import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * surviving の空フィールドを merged の値で補完する対象カラム。
 * surviving に既に値があれば触らない（surviving 優先）。
 */
const FILLABLE_FIELDS = [
  "industry",
  "websiteUrl",
  "websiteSummary",
  "websiteFetchedAt",
  "note",
  "address",
  "ceoName",
  "establishedYear",
  "employeeCount",
  "capital",
  "phoneNumber",
  "logoColor",
  "logoUrl",
] as const;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * GET /api/admin/company-merges
 * 実行済みマージ履歴（undo されていないもの）一覧（admin only）
 */
export async function GET() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const merges = await prisma.companyMerge.findMany({
    where: { undoneAt: null },
    orderBy: { performedAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ merges });
}

const mergeSchema = z.object({
  survivingCompanyId: z.string().min(1),
  mergedCompanyIds: z.array(z.string().min(1)).min(1),
});

/**
 * POST /api/admin/company-merges
 * 企業マージ実行（admin only）。1トランザクションで:
 *  (a) merged の contacts/deals の companyId を surviving へ UPDATE
 *  (b) surviving の空フィールドを merged の値で補完
 *  (c) CompanyMerge に snapshot 記録
 *  (d) merged を deletedAt=now() + mergedIntoId=surviving でアーカイブ
 */
export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const session = await getSession();

  const body = await req.json().catch(() => null);
  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { survivingCompanyId, mergedCompanyIds } = parsed.data;

  // surviving 自身を merged に含めない
  const mergedIds = [...new Set(mergedCompanyIds)].filter((id) => id !== survivingCompanyId);
  if (mergedIds.length === 0) {
    return NextResponse.json({ error: "統合元企業が指定されていません" }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const surviving = await tx.company.findUnique({ where: { id: survivingCompanyId } });
      if (!surviving || surviving.deletedAt) {
        throw new Error("統合先企業が存在しないか、既にアーカイブ済みです");
      }

      const createdMergeIds: string[] = [];

      // surviving の補完用に作業コピー（複数 merged をまたいで最初に見つかった値で埋める）
      const survivingPatch: Record<string, unknown> = {};

      for (const mergedId of mergedIds) {
        const merged = await tx.company.findUnique({ where: { id: mergedId } });
        if (!merged || merged.deletedAt) {
          throw new Error(`統合元企業(${mergedId})が存在しないか、既にアーカイブ済みです`);
        }

        // 付け替え対象の id を控える（復元用）
        const movingContacts = await tx.contact.findMany({
          where: { companyId: mergedId },
          select: { id: true },
        });
        const movingDeals = await tx.deal.findMany({
          where: { companyId: mergedId },
          select: { id: true },
        });
        const contactIds = movingContacts.map((c) => c.id);
        const dealIds = movingDeals.map((d) => d.id);

        // (a) 付け替え
        if (contactIds.length > 0) {
          await tx.contact.updateMany({
            where: { companyId: mergedId },
            data: { companyId: survivingCompanyId },
          });
        }
        if (dealIds.length > 0) {
          await tx.deal.updateMany({
            where: { companyId: mergedId },
            data: { companyId: survivingCompanyId },
          });
        }

        // (b) surviving の空フィールド補完（surviving 現値 + 既に当 patch で埋めた値を尊重）
        const filledByThisMerge: Record<string, unknown> = {};
        for (const f of FILLABLE_FIELDS) {
          const survVal = (surviving as Record<string, unknown>)[f];
          const alreadyPatched = survivingPatch[f];
          if (isEmpty(survVal) && isEmpty(alreadyPatched)) {
            const mergedVal = (merged as Record<string, unknown>)[f];
            if (!isEmpty(mergedVal)) {
              survivingPatch[f] = mergedVal;
              filledByThisMerge[f] = mergedVal;
            }
          }
        }

        // (c) snapshot 記録（消えた企業の全カラム＋付け替えた id ＋このマージで surviving に補完したフィールド）
        const merge = await tx.companyMerge.create({
          data: {
            survivingCompanyId,
            mergedCompanyId: mergedId,
            performedByUserId: session?.userId ?? null,
            snapshot: {
              mergedCompany: JSON.parse(JSON.stringify(merged)),
              movedContactIds: contactIds,
              movedDealIds: dealIds,
              survivingFieldsFilled: JSON.parse(JSON.stringify(filledByThisMerge)),
            },
          },
        });
        createdMergeIds.push(merge.id);

        // (d) merged をアーカイブ
        await tx.company.update({
          where: { id: mergedId },
          data: { deletedAt: new Date(), mergedIntoId: survivingCompanyId },
        });
      }

      // surviving の補完を反映（埋めるものがある場合のみ）
      if (Object.keys(survivingPatch).length > 0) {
        await tx.company.update({ where: { id: survivingCompanyId }, data: survivingPatch });
      }

      return { mergeIds: createdMergeIds, mergedCount: mergedIds.length, fieldsFilled: survivingPatch };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/admin/company-merges] error:", msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
