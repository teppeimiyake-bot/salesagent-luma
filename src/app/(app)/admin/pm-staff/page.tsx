import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PmStaffAdmin } from "@/components/admin/pm-staff-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminPmStaffPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const staff = await prisma.pmStaff.findMany({
    orderBy: [{ role: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  return (
    <>
      <Header title="PMスタッフ" subtitle={`${staff.length} 名 ／ 管理者のみ`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2 flex-wrap">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                PM管理タブの「PM担当 / ディレクター / カメラ / 編集」プルダウンの選択肢を管理します。
                現場でも各プルダウンの「＋新規スタッフを追加」から追加できます。
              </span>
            </div>
            <PmStaffAdmin initial={staff} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
