import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { PaymentsBoard } from "@/components/payments/payments-board";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * 入金管理ページ（機能5）
 * スポット / 定期 の2サブタブ。請求書送付状況・着金状況を管理する。
 * Phase 9：admin 権限のみアクセス可（非adminはダッシュボードへ）。
 */
export default async function PaymentsPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  // admin 限定。非adminはダッシュボードへリダイレクト。
  if (!hasPermission(me?.permission, "admin")) {
    redirect("/dashboard");
  }
  const canEdit = true; // admin は常に編集可

  return (
    <>
      <Header title="入金管理" subtitle="請求書の送付状況・着金状況を管理" />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <PaymentsBoard canEdit={canEdit} />
      </div>
    </>
  );
}
