import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersAdmin } from "@/components/admin/users-admin";
import { InvitesAdmin } from "@/components/admin/invites-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { Users, Mail } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({ where: { id: session.userId } })
    : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      permission: true,
      avatarColor: true,
    },
  });

  return (
    <>
      <Header
        title="ユーザー権限"
        subtitle={`${users.length} 名 ／ 管理者のみ`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <div className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              <span>
                <strong>管理者</strong>: プロダクト/ユーザー作成 ／{" "}
                <strong>利用者</strong>: 通常操作 ／ <strong>閲覧のみ</strong>: 編集不可
              </span>
            </div>
            <Tabs defaultValue="users" className="w-full">
              <TabsList className="grid w-full grid-cols-2 max-w-md h-11">
                <TabsTrigger value="users">
                  <Users className="h-4 w-4 mr-1.5" />
                  ユーザー一覧 ({users.length})
                </TabsTrigger>
                <TabsTrigger value="invites">
                  <Mail className="h-4 w-4 mr-1.5" />
                  招待管理
                </TabsTrigger>
              </TabsList>
              <TabsContent value="users" className="mt-4">
                <UsersAdmin initial={users} currentUserId={session!.userId} />
              </TabsContent>
              <TabsContent value="invites" className="mt-4">
                <InvitesAdmin />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
