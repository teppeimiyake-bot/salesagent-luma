import { Header } from "@/components/layout/header";
import { YearTabs } from "@/components/kpi/year-tabs";
import { QuarterTabs } from "@/components/ms-outreach/quarter-tabs";
import { MsOutreachBoard } from "@/components/ms-outreach/ms-outreach-board";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { getFiscalStartMonth } from "@/lib/tenant-context";
import {
  getFiscalYear,
  getFiscalQuarter,
  getFiscalQuarterMonths,
  fyDisplayLabel,
  fyPeriodLabel,
} from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * MS送付状況（/ms-outreach）
 * Lumaのアウトリーチ送付実績を「ワーカー × 月内週(1w〜5w)」の週次グリッドで管理。
 * 既存の「ms管理」(/ms) とは別物。会計年度（YearTabs）×四半期（QuarterTabs）で軽量表示。
 *
 * 権限: 閲覧=全ロール / 週次入力=user以上 / ワーカー・KPI目標編集=admin
 */
export default async function MsOutreachPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; q?: string }>;
}) {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user"); // 週次入力
  const isAdmin = hasPermission(me?.permission, "admin"); // ワーカー追加・KPI目標編集

  const sp = await searchParams;
  // 会計年度の開始月は会社ごとに異なる（Luma=6月 / リージー=1月）
  const startMonth = await getFiscalStartMonth();
  const currentFy = getFiscalYear(startMonth);
  const fy = sp.year ? Number(sp.year) : currentFy;
  const currentQuarter = getFiscalQuarter(startMonth);
  // 当年度を見ている時は現四半期を初期表示、過去/未来年度なら 1Q
  const defaultQuarter = fy === currentFy ? currentQuarter : 1;
  const quarter =
    sp.q && [1, 2, 3, 4].includes(Number(sp.q)) ? Number(sp.q) : defaultQuarter;

  // 選択四半期に属する3暦月（lib/config の会計年度ヘルパー）
  const monthCols = getFiscalQuarterMonths(startMonth, fy, quarter - 1);

  const [workers, entries, goal] = await Promise.all([
    prisma.msWorker.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }, { name: "asc" }],
    }),
    prisma.msWeeklyEntry.findMany({
      where: { OR: monthCols.map((m) => ({ year: m.year, month: m.month })) },
      orderBy: [{ year: "asc" }, { month: "asc" }, { weekOfMonth: "asc" }],
    }),
    prisma.msKpiGoal.findFirst({ where: { period: fyPeriodLabel(fy) } }),
  ]);

  return (
    <>
      <Header
        title="MS送付状況"
        subtitle={`アウトリーチ送付・アポ獲得KPI｜${fyDisplayLabel(startMonth, fy)} ${quarter}Q`}
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white space-y-2">
        <YearTabs currentFy={currentFy} selectedYear={fy} />
        <QuarterTabs
          selectedQuarter={quarter}
          currentQuarter={fy === currentFy ? currentQuarter : undefined}
        />
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <MsOutreachBoard
          workers={workers.map((w) => ({
            id: w.id,
            code: w.code,
            name: w.name,
            isAgency: w.isAgency,
            active: w.active,
          }))}
          entries={entries.map((e) => ({
            id: e.id,
            workerId: e.workerId,
            year: e.year,
            month: e.month,
            weekOfMonth: e.weekOfMonth,
            sent: e.sent,
            appointments: e.appointments,
            listOrders: e.listOrders,
            inquiryOrders: e.inquiryOrders,
            notes: e.notes,
          }))}
          monthCols={monthCols}
          fy={fy}
          quarter={quarter}
          goal={goal ? { targetReplyRate: goal.targetReplyRate, targetSent: goal.targetSent } : null}
          canEdit={canEdit}
          isAdmin={isAdmin}
        />
      </div>
    </>
  );
}
