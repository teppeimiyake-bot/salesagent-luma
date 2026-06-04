import { Header } from "@/components/layout/header";
import { PmBoard } from "@/components/pm/pm-board";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * PM（受注管理）ページ（機能4）
 * 受注企業だけを表示し、映像 / SNS / CATV のサブタブで案件進捗を管理する。
 */
export default async function PmPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");

  return (
    <>
      <Header title="PM（受注管理）" subtitle="受注した案件の制作進捗を管理" />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <PmBoard canEdit={canEdit} />
      </div>
    </>
  );
}
