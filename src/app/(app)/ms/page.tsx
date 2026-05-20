import { Header } from "@/components/layout/header";
import { MsBoard } from "@/components/ms/ms-board";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { getSalesUsers } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * ms管理ページ
 * アポインター（インサイドセールス）向け：アポ獲得〜商談確定の初期フェーズだけを切り出した操作画面。
 * 3つの「商談前」ステージ（商談予定 / 日程調整不可 / 催促2回送信済）をタブで管理する。
 */
export default async function MsPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");

  // 全ステージマスタ（タブは before のみ抽出、行のステージ変更先は全 group を使う）
  const [allStages, leadSources, users] = await Promise.all([
    prisma.pipelineStage.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { value: "asc" }],
    }),
    prisma.leadSource.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, active: true, sortOrder: true },
    }),
    getSalesUsers(),
  ]);

  return (
    <>
      <Header
        title="ms管理"
        subtitle="アポ獲得〜商談確定までのリード追いかけ"
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <MsBoard
          stages={allStages.map((s) => ({
            id: s.id,
            value: s.value,
            label: s.label,
            group: s.group,
            badgeBg: s.badgeBg,
            badgeText: s.badgeText,
            active: s.active,
            sortOrder: s.sortOrder,
          }))}
          leadSources={leadSources}
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            avatarColor: u.avatarColor,
          }))}
          canEdit={canEdit}
        />
      </div>
    </>
  );
}
