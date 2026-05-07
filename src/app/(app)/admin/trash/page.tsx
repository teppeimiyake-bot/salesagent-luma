import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrashList } from "@/components/admin/trash-list";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { Trash2, Info } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminTrashPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const [companies, deals] = await Promise.all([
    prisma.company.findMany({
      where: { deletedAt: { not: null } },
      include: {
        _count: { select: { deals: true, contacts: true } },
      },
      orderBy: { deletedAt: "desc" },
    }),
    prisma.deal.findMany({
      where: { deletedAt: { not: null } },
      include: {
        company: {
          select: { id: true, name: true, logoUrl: true, logoColor: true, deletedAt: true },
        },
        owner: { select: { id: true, name: true, avatarColor: true } },
        products: {
          select: {
            id: true,
            productName: true,
            planName: true,
            probability: true,
            amount: true,
            yomiStatus: true,
          },
        },
        _count: { select: { tasks: true, meetings: true } },
      },
      orderBy: { deletedAt: "desc" },
    }),
  ]);

  return (
    <>
      <Header
        title={
          <span className="inline-flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-zinc-500" />
            ゴミ箱
          </span>
        }
        subtitle={`削除済み 企業 ${companies.length} 件 ／ 商談 ${deals.length} 件 ／ 管理者のみ`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card className="mb-4 border-zinc-300 bg-gradient-to-br from-zinc-50 to-white">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <Info className="h-4 w-4 text-zinc-500 mt-0.5 shrink-0" />
              <div className="text-sm text-zinc-700 space-y-1">
                <p className="inline-flex items-center gap-2">
                  <Badge variant="danger">管理者専用</Badge>
                  <span className="font-semibold">削除されたデータの復元・完全削除を行えます。</span>
                </p>
                <ul className="list-disc list-inside text-xs text-zinc-500 ml-1">
                  <li>「復元」：ゴミ箱から戻し、通常の一覧に再表示します。</li>
                  <li>「企業を復元」すると、その企業と一緒に削除された商談も自動復元されます。</li>
                  <li>「完全削除」：物理削除。連絡先・議事録・タスク等の関連データも全削除されます（取り消し不可）。</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
        <TrashList companies={companies} deals={deals} />
      </div>
    </>
  );
}
