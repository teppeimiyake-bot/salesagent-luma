import { Header } from "@/components/layout/header";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { KpiCharts } from "@/components/kpi/charts";
import { KpiHierarchyView } from "@/components/kpi/hierarchy-view";
import { GoalsAdmin } from "@/components/kpi/goals-admin";
import { OwnerTabs } from "@/components/deals/owner-tabs";
import {
  getDashboardData,
  getKpiTimeseries,
  getGoalsHierarchy,
  getSalesUsers,
} from "@/lib/queries";
import { getFullyLostDealIds } from "@/lib/deal-status-server";
import { isExcludedFromNextAction } from "@/lib/deal-status";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getFiscalYear, fyDisplayLabel } from "@/lib/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { weightedProbability, type DealProductLite } from "@/lib/deal-aggregations";

export const dynamic = "force-dynamic";

export default async function KpiPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; year?: string }>;
}) {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const isAdmin = me?.permission === "admin";

  const sp = await searchParams;
  // URLに owner が無ければ全員、"all"=全員、"me"=自分、その他=個別ユーザーID
  const ownerParam = sp.owner ?? "all";
  const userId =
    ownerParam === "me"
      ? session?.userId
      : ownerParam === "all"
        ? undefined
        : ownerParam;
  const isOrgView = !userId;
  // year パラメータは会計年度（FY2026 → 2026）。未指定時は現在の会計年度。
  const year = sp.year ? Number(sp.year) : getFiscalYear();

  const [{ kpi, deals }, series, hierarchy, users, fullyLostDealIds] = await Promise.all([
    getDashboardData({ userId }),
    getKpiTimeseries(userId),
    getGoalsHierarchy(year, userId),
    getSalesUsers(),
    getFullyLostDealIds(),
  ]);
  const fullyLostSet = new Set(fullyLostDealIds);

  // 確度60%以上 かつ Next Action未設定の Deal をアラート対象に
  // NG/日程調整不可/完全失注は除外（社長判断 2026-05）
  const alerts = deals
    .map((d) => ({
      ...d,
      _probability: weightedProbability(d.products as DealProductLite[]),
      _productNames: d.products.map((p) => p.productName).slice(0, 3),
      _restCount: Math.max(0, d.products.length - 3),
    }))
    .filter(
      (d) =>
        d._probability >= 60 &&
        !d.nextAction &&
        !isExcludedFromNextAction(d, fullyLostSet),
    );

  return (
    <>
      <Header
        title="KPI"
        subtitle={
          isOrgView
            ? `組織全体のパフォーマンス｜${fyDisplayLabel(year)}`
            : `個人パフォーマンス｜${fyDisplayLabel(year)}`
        }
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white">
        <OwnerTabs users={users} currentUserId={session?.userId ?? ""} selected={ownerParam} />
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-zinc-50">
        {/* 年間KGI / 四半期KPI / 月次KPI を一画面で俯瞰 */}
        <KpiHierarchyView data={hierarchy} year={year} isOrgView={isOrgView} />

        <KpiCards kpi={kpi} />
        <KpiCharts data={series} />

        {/* admin 限定：KPI目標管理（年/四半期/月のタブ切替） */}
        {isAdmin && <GoalsAdmin year={year} users={users} />}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              アラート
              <Badge variant="warning" className="ml-2">
                {alerts.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {alerts.length === 0 ? (
              <p className="text-sm text-zinc-500">
                受注確度の高い商談は全てNext Actionが定義されています。
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {alerts.map((d) => (
                  <li key={d.id} className="py-2 text-sm flex justify-between">
                    <span>
                      {d.company.name} / {d._productNames.join(", ")}
                      {d._restCount > 0 && ` 他${d._restCount}件`}
                    </span>
                    <Badge variant="danger">確度{d._probability}% / Next未設定</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
