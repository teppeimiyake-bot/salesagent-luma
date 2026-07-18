import { Header } from "@/components/layout/header";
import { AiTodoList } from "@/components/dashboard/ai-todo";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { DealsTable } from "@/components/dashboard/deals-table";
import { AiChat } from "@/components/dashboard/ai-chat";
import { GoalProgress } from "@/components/dashboard/goal-progress";
import { NewTaskDialog } from "@/components/todos/new-task-dialog";
import { getDashboardData, getGoalProgress } from "@/lib/queries";
import { excludeDoneAndNGDealsWhere } from "@/lib/deal-status-server";
import { getSession, hasPermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { currentFiscalQuarterPeriod } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // 現在の会計四半期（Lumaは6月始まり＝5月決算）
  const PERIOD = currentFiscalQuarterPeriod();
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { name: true, permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");
  const userId = session?.userId;
  // ToDo化対象から外したいDealのフィルタ
  // （受注/失注/NG/日程調整不可/完全失注/完全受注 を全部弾く）
  const exclude = await excludeDoneAndNGDealsWhere();
  const [{ openTasks, deals, kpi }, personalGoal, teamGoal, dealsWithNextAction] = await Promise.all([
    getDashboardData({ userId }),
    getGoalProgress(PERIOD, userId),
    getGoalProgress(PERIOD),
    userId
      ? prisma.deal.findMany({
          where: {
            ownerUserId: userId,
            deletedAt: null,
            company: { deletedAt: null },
            AND: [
              { nextAction: { not: null } },
              { nextAction: { not: "" } },
              ...exclude.AND,
            ],
          },
          include: {
            company: { select: { name: true } },
          },
          orderBy: [{ nextActionAt: "asc" }],
          take: 10,
        })
      : Promise.resolve([]),
  ]);

  // Task と Deal.nextAction を統合
  const taskItems = openTasks.map((t) => ({
    id: t.id,
    title: t.title,
    reason: t.reason,
    priority: t.priority,
    impact: t.impact,
    isAiGenerated: t.isAiGenerated,
    isDealNextAction: false,
    dueDate: t.dueDate,
    deal: {
      id: t.deal.id,
      title: t.deal.title,
      company: { name: t.deal.company.name },
    },
  }));
  const dealItems = dealsWithNextAction.map((d) => ({
    id: `deal:${d.id}`,
    title: d.nextAction ?? "",
    reason: null,
    priority: null,
    impact: null,
    isAiGenerated: false,
    isDealNextAction: true,
    dueDate: d.nextActionAt,
    deal: {
      id: d.id,
      title: d.title,
      company: { name: d.company.name },
    },
  }));
  const dueValue = (d: Date | string | null): number =>
    d ? new Date(d).getTime() : Number.POSITIVE_INFINITY;
  const merged = [...taskItems, ...dealItems].sort(
    (a, b) => dueValue(a.dueDate) - dueValue(b.dueDate),
  );

  return (
    <>
      <Header
        title={`今日のあなた`}
        subtitle={me ? `${me.name}さんが今やるべきこと` : "ログインユーザー"}
        right={<NewTaskDialog />}
      />
      <div className="flex-1 overflow-hidden">
        <div className="h-full grid grid-cols-12 gap-0">
          <div className="col-span-12 xl:col-span-8 overflow-y-auto p-6 space-y-5 border-r border-zinc-200">
            <GoalProgress personal={personalGoal} team={teamGoal} />
            <AiTodoList tasks={merged} />
            <KpiCards kpi={kpi} />
            <DealsTable
              deals={deals}
              title="あなたの進行中商談（次回アクション順）"
              canDelete={canEdit}
              editable={canEdit}
            />
          </div>
          <div className="hidden xl:flex xl:col-span-4 flex-col p-4 bg-white">
            <AiChat scope="global" />
          </div>
        </div>
      </div>
    </>
  );
}
