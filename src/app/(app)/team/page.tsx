import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { getSalesUsers, getGoalProgress } from "@/lib/queries";
import { formatJPY } from "@/lib/utils";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { NewMemberDialog } from "@/components/team/new-member-dialog";
import { currentFiscalQuarterPeriod } from "@/lib/config";
import Link from "next/link";
import { Crown, Users } from "lucide-react";
import { pipelineAmount as calcPipelineAmount, type DealProductLite } from "@/lib/deal-aggregations";
import { excludeDoneAndNGDealsWhere } from "@/lib/deal-status-server";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

interface MemberRow {
  user: { id: string; name: string; avatarColor: string | null; role: string | null };
  deals: number;
  pipeline: number;
  won: number;
  winRate: number;
  openTasks: number;
  doneTasks: number;
  goal: { targetAmount: number; wonAmount: number; rate: number; period: string };
}

async function buildRows(
  users: { id: string; name: string; avatarColor: string | null; role: string | null }[],
  period: string,
  todoExcludeAND: Prisma.DealWhereInput[],
): Promise<MemberRow[]> {
  return Promise.all(
    users.map(async (u) => {
      const activeDeal = { deletedAt: null, company: { deletedAt: null } } as const;
      // ToDo件数用：受注/失注/NG除外（社長判断 2026-05）
      const todoDealClause = {
        ownerUserId: u.id,
        ...activeDeal,
        AND: [...todoExcludeAND],
      };
      // u が Deal主担当 または DealProduct担当のいずれかに該当するDealをロード
      const [deals, openTasks, doneTasks, goal] = await Promise.all([
        prisma.deal.findMany({
          where: {
            OR: [
              { ownerUserId: u.id },
              { products: { some: { ownerUserId: u.id } } },
            ],
            ...activeDeal,
          },
          select: {
            status: true,
            products: {
              select: { productName: true, amount: true, probability: true, ownerUserId: true },
            },
          },
        }),
        prisma.task.count({ where: { deal: todoDealClause, status: "OPEN" } }),
        prisma.task.count({ where: { deal: todoDealClause, status: "DONE" } }),
        getGoalProgress(period, u.id),
      ]);
      const pipeline = deals
        .filter((d) => d.status !== "WON" && d.status !== "LOST")
        .reduce((s, d) => s + calcPipelineAmount(d.products as DealProductLite[]), 0);
      const won = deals
        .filter((d) => d.status === "WON")
        .reduce((s, d) => s + d.products.reduce((ss, p) => ss + (p.amount ?? 0), 0), 0);
      const winRate = deals.length === 0 ? 0 : deals.filter((d) => d.status === "WON").length / deals.length;
      return { user: u, deals: deals.length, pipeline, won, winRate, openTasks, doneTasks, goal };
    }),
  );
}

export default async function TeamPage() {
  const PERIOD = currentFiscalQuarterPeriod();
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const isAdmin = me?.permission === "admin";

  const users = await getSalesUsers();
  const members = users.filter((u) => u.role === "sales");
  const managers = users.filter((u) => u.role === "manager");
  // ToDo件数用の除外条件（受注/失注/NG/完全失注/完全受注 を弾く）
  const todoExclude = await excludeDoneAndNGDealsWhere();
  const [memberRows, managerRows, teamGoal] = await Promise.all([
    buildRows(members, PERIOD, todoExclude.AND),
    buildRows(managers, PERIOD, todoExclude.AND),
    getGoalProgress(PERIOD),
  ]);

  return (
    <>
      <Header
        title="チーム"
        subtitle={`${PERIOD} 期間進捗`}
        right={isAdmin ? <NewMemberDialog /> : null}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50 space-y-5">
        {/* 組織サマリ */}
        <Card className="border-pink-200 bg-gradient-to-br from-pink-50/60 to-white">
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="rounded-lg bg-pink-500 text-white p-2 shadow-sm">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-zinc-500">組織全体目標</p>
                <p className="text-2xl font-bold tabular-nums">
                  {formatJPY(teamGoal.wonAmount)} <span className="text-sm text-zinc-500 font-normal">/ {formatJPY(teamGoal.targetAmount)}</span>
                </p>
              </div>
              <Badge variant="info" className="ml-auto text-base px-3 py-1">
                達成率 {(teamGoal.rate * 100).toFixed(0)}%
              </Badge>
            </div>
            <Progress value={Math.min(100, teamGoal.rate * 100)} />
          </CardContent>
        </Card>

        <Tabs defaultValue="members" className="w-full">
          <TabsList className="grid w-full grid-cols-2 max-w-md h-11">
            <TabsTrigger value="members" className="text-sm">
              <Users className="h-4 w-4 mr-1.5" />
              メンバー ({memberRows.length})
            </TabsTrigger>
            <TabsTrigger value="managers" className="text-sm">
              <Crown className="h-4 w-4 mr-1.5" />
              マネージャー ({managerRows.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="mt-4">
            <p className="text-sm text-zinc-600 mb-3">
              個人売上目標と案件進捗
            </p>
            <MemberGrid rows={memberRows} />
          </TabsContent>

          <TabsContent value="managers" className="mt-4">
            <p className="text-sm text-zinc-600 mb-3">
              マネージャーは組織達成・チーム育成・パイプライン健全性を追う（個人売上は補助指標）
            </p>
            <MemberGrid rows={managerRows} isManager />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function MemberGrid({ rows, isManager = false }: { rows: MemberRow[]; isManager?: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {rows.map((r) => (
        <Card key={r.user.id} className="hover:shadow-md transition-shadow">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-3 text-base">
              <OwnerBadge owner={r.user} size="lg" showRole />
              <Badge variant={isManager ? "warning" : "outline"} className="ml-auto">
                {r.user.role}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="text-xs text-zinc-500 mb-1 flex justify-between">
                <span>{isManager ? "個人実績（補助指標）" : "目標達成率"}</span>
                <span className="font-bold">{(r.goal.rate * 100).toFixed(0)}%</span>
              </div>
              <Progress value={Math.min(100, r.goal.rate * 100)} />
              <p className="text-xs text-zinc-500 mt-1">
                {formatJPY(r.goal.wonAmount)} / {formatJPY(r.goal.targetAmount)}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-zinc-100">
              <div>
                <p className="text-[10px] text-zinc-500">案件数</p>
                <p className="text-base font-bold">{r.deals}</p>
              </div>
              <div>
                <p className="text-[10px] text-zinc-500">受注率</p>
                <p className="text-base font-bold">{(r.winRate * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="text-[10px] text-zinc-500">パイプ</p>
                <p className="text-base font-bold tabular-nums">{formatJPY(Math.round(r.pipeline))}</p>
              </div>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-zinc-100">
              <span className="text-[11px] text-zinc-500">
                ToDo {r.openTasks} 件未完了 / {r.doneTasks} 完了
              </span>
              <Link href={`/deals?owner=${r.user.id}`} className="text-xs text-emerald-600 hover:underline font-medium">
                案件を見る →
              </Link>
            </div>
          </CardContent>
        </Card>
      ))}
      {rows.length === 0 && (
        <Card className="md:col-span-2">
          <CardContent className="p-10 text-center text-sm text-zinc-500">
            該当する{isManager ? "マネージャー" : "メンバー"}はいません
          </CardContent>
        </Card>
      )}
    </div>
  );
}
