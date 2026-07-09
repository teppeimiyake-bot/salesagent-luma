import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AgentCandidatesAdmin } from "@/components/admin/agent-candidates-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminAgentCandidatesPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({ where: { id: session.userId } })
    : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  return (
    <>
      <Header
        title="エージェント候補"
        subtitle="営業リストエージェントの会社候補レビュー ／ 管理者のみ"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                エージェントが収集した会社候補です。内容を確認して承認/却下し、「承認済みを取り込み」で
                Company/Contact に反映します。取り込み前に CRM へ自動反映はしません。
              </span>
            </div>
            <AgentCandidatesAdmin />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
