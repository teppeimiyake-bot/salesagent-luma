import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LeadSourcesAdmin } from "@/components/admin/lead-sources-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminLeadSourcesPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const sources = await prisma.leadSource.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <Header title="リード獲得経由" subtitle={`${sources.length} 件 ／ 管理者のみ`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              <span>リード獲得経由（MS／交流会／HP経由 など）。商談新規作成と商談詳細での選択肢になります。</span>
            </div>
            <LeadSourcesAdmin initial={sources} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
