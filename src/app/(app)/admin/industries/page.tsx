import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IndustriesAdmin } from "@/components/admin/industries-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminIndustriesPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const industries = await prisma.industry.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <Header title="業種" subtitle={`${industries.length} 件 ／ 管理者のみ`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2 flex-wrap">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                会社情報・商談ページの「業種」ピッカー（複数選択チップ）の選択肢を管理します。
                既存企業に保存済みの業種文字列は、マスタから消しても表示・選択に残ります。
              </span>
            </div>
            <IndustriesAdmin initial={industries} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
