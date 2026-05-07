import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PipelineStagesAdmin } from "@/components/admin/pipeline-stages-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPipelineStagesPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({ where: { id: session.userId } })
    : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const stages = await prisma.pipelineStage.findMany({
    orderBy: [{ sortOrder: "asc" }, { value: "asc" }],
  });

  return (
    <>
      <Header
        title="商談プロセスステージ"
        subtitle={`${stages.length} 件 ／ 管理者のみ`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                商談前 ／ 商談後 ／ 契約 の3グループでステージを管理。商談新規作成と商談詳細の選択肢になります。
              </span>
            </div>
            <PipelineStagesAdmin initial={stages} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
