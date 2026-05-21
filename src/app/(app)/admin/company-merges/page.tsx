import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CompanyMergesAdmin } from "@/components/admin/company-merges-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminCompanyMergesPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  return (
    <>
      <Header title="企業統合" subtitle="重複企業の統合（マージ） ／ 管理者のみ" />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                同じ会社が二重登録されている候補を検出します。自動統合はしません。1件ずつ内容を確認し、統合先を選んで承認してください。統合元はアーカイブされ、後から復元できます。
              </span>
            </div>
            <CompanyMergesAdmin />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
