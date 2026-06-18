import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { TasksAllList } from "@/components/todos/tasks-all-list";
import { OwnerTabs } from "@/components/deals/owner-tabs";
import { TodoStatusTabs } from "@/components/todos/todo-status-tabs";
import { NewTaskDialog } from "@/components/todos/new-task-dialog";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getSalesUsers } from "@/lib/queries";
import { excludeDoneAndNGDealsWhere } from "@/lib/deal-status-server";
import { TaskStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

type Item = React.ComponentProps<typeof TasksAllList>["tasks"][number];

export default async function TodosPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; status?: string }>;
}) {
  const session = await getSession();
  const sp = await searchParams;
  // URLに owner が無ければ「自分」、"all"=全員、"me"=自分、その他=個別ユーザーID
  const ownerParam = sp.owner ?? "me";
  const statusParam = (sp.status ?? "open") as "open" | "done" | "all";
  const ownerUserId =
    ownerParam === "me"
      ? session?.userId
      : ownerParam === "all"
        ? undefined
        : ownerParam;

  const statusWhere =
    statusParam === "done"
      ? { status: TaskStatus.DONE }
      : statusParam === "all"
        ? {}
        : { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] } };

  // 共通：親Deal/Companyが active であること
  const activeDealClause = { deletedAt: null, company: { deletedAt: null } } as const;

  // ToDo管理から除外（社長判断 2026-05）：
  //   A. bant.isNG=true
  //   B. pipelineStage=【商談前】日程調整不可
  //   C. 完全失注（全DealProductがNG/失注）
  //   D. Deal.status = WON / LOST
  //   E. 完全受注（全DealProductが受注/締結済み）
  const exclude = await excludeDoneAndNGDealsWhere();
  const taskOwnerDealClause = {
    deal: {
      ...(ownerUserId ? { ownerUserId } : {}),
      ...activeDealClause,
      AND: [...exclude.AND],
    },
  };

  // Deal の where：オープン中（受注/失注以外）で nextAction が空でないもの
  //   （社長判断 2026-06：期日(nextActionAt)未設定でもToDoに表示する。
  //    以前は期日未設定を除外していたが「期日を空欄にクリアすると一覧から消える」挙動の
  //    原因になっていたため除外条件を撤廃。期日未設定は下のソートで末尾に回す。）
  const dealNextActionWhere = {
    ...(ownerUserId ? { ownerUserId } : {}),
    ...activeDealClause,
    AND: [
      { nextAction: { not: null } },
      { nextAction: { not: "" } },
      ...exclude.AND,
    ],
  };

  const [users, tasks, openCount, doneCount, allCount, dealsWithNextAction] = await Promise.all([
    getSalesUsers(),
    prisma.task.findMany({
      where: {
        ...taskOwnerDealClause,
        ...statusWhere,
      },
      include: {
        deal: {
          include: {
            company: true,
            owner: { select: { id: true, name: true, avatarColor: true } },
            products: {
              select: { id: true, productName: true, yomiStatus: true, amount: true },
              orderBy: { amount: "desc" },
            },
          },
        },
      },
      orderBy: [
        { status: "asc" },
        { priority: "desc" },
        { dueDate: "asc" },
      ],
    }),
    prisma.task.count({
      where: {
        ...taskOwnerDealClause,
        status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] },
      },
    }),
    prisma.task.count({
      where: { ...taskOwnerDealClause, status: TaskStatus.DONE },
    }),
    prisma.task.count({ where: taskOwnerDealClause }),
    prisma.deal.findMany({
      where: dealNextActionWhere,
      include: {
        company: true,
        owner: { select: { id: true, name: true, avatarColor: true } },
        products: {
          select: { id: true, productName: true, yomiStatus: true, amount: true },
          orderBy: { amount: "desc" },
        },
      },
      orderBy: [{ nextActionAt: "asc" }],
    }),
  ]);

  function summarizeProducts(products: { productName: string }[]): string | null {
    if (products.length === 0) return null;
    const head = products.slice(0, 3).map((p) => p.productName).join(", ");
    const rest = products.length - 3;
    return rest > 0 ? `${head} 他${rest}件` : head;
  }

  const taskItems: Item[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    reason: t.reason,
    isAiGenerated: t.isAiGenerated,
    dueDate: t.dueDate,
    isDealNextAction: false,
    deal: {
      id: t.deal.id,
      title: t.deal.title,
      productSummary: summarizeProducts(t.deal.products),
      products: t.deal.products.map((p) => ({
        id: p.id,
        productName: p.productName,
        yomiStatus: p.yomiStatus,
        amount: p.amount,
      })),
      company: { name: t.deal.company.name },
      owner: t.deal.owner,
    },
  }));

  const showDealNA = statusParam !== "done";
  const dealItems: Item[] = showDealNA
    ? dealsWithNextAction.map((d) => ({
        id: `deal:${d.id}`,
        title: d.nextAction ?? "",
        status: "OPEN",
        priority: null,
        reason: null,
        isAiGenerated: false,
        dueDate: d.nextActionAt,
        isDealNextAction: true,
        deal: {
          id: d.id,
          title: d.title,
          productSummary: summarizeProducts(d.products),
          products: d.products.map((p) => ({
            id: p.id,
            productName: p.productName,
            yomiStatus: p.yomiStatus,
            amount: p.amount,
          })),
          company: { name: d.company.name },
          owner: d.owner,
        },
      }))
    : [];

  // マージして期日昇順ソート
  // 期日無しは最後に。doneは末尾、openは先頭。
  function dueValue(d: Date | string | null): number {
    if (!d) return Number.POSITIVE_INFINITY;
    return new Date(d).getTime();
  }
  const merged: Item[] = [...taskItems, ...dealItems].sort((a, b) => {
    // status: 未完(OPEN/IN_PROGRESS) を先、 DONE を後
    const aDone = a.status === "DONE" ? 1 : 0;
    const bDone = b.status === "DONE" ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    return dueValue(a.dueDate) - dueValue(b.dueDate);
  });

  // ヘッダーの件数表示用
  const dealCountVisible = dealItems.length;
  const subtitle =
    `${merged.length} 件 表示中` +
    (dealCountVisible > 0 ? `（うち商談アクション ${dealCountVisible} 件）` : "");

  // タブの件数表示にDeal nextActionも含める（"all"と"open"は同数を加算）
  const dealNATotal = dealsWithNextAction.length;

  return (
    <>
      <Header title="ToDo" subtitle={subtitle} right={<NewTaskDialog />} />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white space-y-3">
        <OwnerTabs users={users} currentUserId={session?.userId ?? ""} selected={ownerParam} />
        <TodoStatusTabs
          current={statusParam}
          counts={{
            open: openCount + dealNATotal,
            done: doneCount,
            all: allCount + dealNATotal,
          }}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-0">
            <TasksAllList tasks={merged} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
