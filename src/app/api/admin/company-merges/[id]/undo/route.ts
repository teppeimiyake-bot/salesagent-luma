import { NextResponse } from "next/server";
import { prisma, prismaUnscoped } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Snapshot = {
  mergedCompany: Record<string, unknown> & { id: string };
  movedContactIds: string[];
  movedDealIds: string[];
  survivingFieldsFilled: Record<string, unknown>;
};

/**
 * POST /api/admin/company-merges/[id]/undo
 * マージを復元（admin only）。snapshot を使って:
 *  - 付け替えた contacts/deals を元企業へ戻す
 *  - 当マージで surviving に補完したフィールドを元の空に戻す
 *  - merged 企業の deletedAt / mergedIntoId をクリア（復活）
 *  - CompanyMerge.undoneAt をセット
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await ctx.params;

  try {
    // 統合の取り消しも同様に両社分を戻す必要があるため境界を通さない
    const result = await prismaUnscoped.$transaction(async (tx) => {
      const merge = await tx.companyMerge.findUnique({ where: { id } });
      if (!merge) throw new Error("マージ履歴が見つかりません");
      if (merge.undoneAt) throw new Error("このマージは既に復元済みです");

      const snap = merge.snapshot as unknown as Snapshot;
      const mergedId = merge.mergedCompanyId;
      const survivingId = merge.survivingCompanyId;

      // merged 企業が（アーカイブ状態のまま）存在することを確認
      const mergedCompany = await tx.company.findUnique({ where: { id: mergedId } });
      if (!mergedCompany) throw new Error("統合元企業のレコードが見つかりません（復元不可）");

      // 付け替えた contacts/deals を元企業へ戻す（現在 surviving に属しているもののみ）
      if (snap.movedContactIds?.length) {
        await tx.contact.updateMany({
          where: { id: { in: snap.movedContactIds }, companyId: survivingId },
          data: { companyId: mergedId },
        });
      }
      if (snap.movedDealIds?.length) {
        await tx.deal.updateMany({
          where: { id: { in: snap.movedDealIds }, companyId: survivingId },
          data: { companyId: mergedId },
        });
      }

      // surviving に補完したフィールドを元（空）に戻す。
      // 安全策：現在の surviving 値がこのマージで入れた値と一致する場合のみ null に戻す
      // （その後ユーザーが手動で別の値を入れていたら触らない）
      const filled = snap.survivingFieldsFilled ?? {};
      if (Object.keys(filled).length > 0) {
        const surviving = await tx.company.findUnique({ where: { id: survivingId } });
        if (surviving) {
          const revert: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(filled)) {
            const cur = (surviving as Record<string, unknown>)[k];
            // 日付は文字列化して比較
            const curS = cur instanceof Date ? cur.toISOString() : cur;
            const vS = typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? v : v;
            if (curS === vS || JSON.stringify(curS) === JSON.stringify(vS)) {
              revert[k] = null;
            }
          }
          if (Object.keys(revert).length > 0) {
            await tx.company.update({ where: { id: survivingId }, data: revert });
          }
        }
      }

      // merged 企業を復活
      await tx.company.update({
        where: { id: mergedId },
        data: { deletedAt: null, mergedIntoId: null },
      });

      // マージ履歴を undone に
      await tx.companyMerge.update({ where: { id }, data: { undoneAt: new Date() } });

      return { restoredCompanyId: mergedId, survivingId };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/admin/company-merges/[id]/undo] error:", msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
