import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlanProposalsAdmin } from "@/components/admin/plan-proposals-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPlanProposalsPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const items = await prisma.planProposal.findMany({
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <Header title="企画提案" subtitle={`${items.length} 件 ／ 管理者のみ`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2 flex-wrap">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                映像案件で提案する企画の型（【採用】ドラマ風動画 など）。商談詳細の「映像」プロダクト行で複数選択できます。
                並び順・色・有効/無効を編集できます。
              </span>
            </div>
            <PlanProposalsAdmin initial={items} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
