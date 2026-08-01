import { Header } from "@/components/layout/header";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { KpiCharts } from "@/components/kpi/charts";
import { KpiHierarchyView } from "@/components/kpi/hierarchy-view";
import { GoalsAdmin } from "@/components/kpi/goals-admin";
import { OwnerTabs } from "@/components/deals/owner-tabs";
import { YearTabs } from "@/components/kpi/year-tabs";
import { NewDealDialog } from "@/components/deals/new-deal-dialog";
import {
  getDashboardData,
  getKpiTimeseries,
  getGoalsHierarchy,
  getMonthlyWonDealsByPeriod,
  getSalesUsers,
} from "@/lib/queries";
import { getFullyLostDealIds } from "@/lib/deal-status-server";
import { isExcludedFromNextAction } from "@/lib/deal-status";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getFiscalYear, fyDisplayLabel } from "@/lib/config";
import { listMyTenants, getRequestTenant, runAsUserTenant } from "@/lib/tenant-context";
import { KpiTenantTabs } from "@/components/kpi/kpi-tenant-tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { representativeYomi, dealYomiRank, type DealProductLite } from "@/lib/deal-aggregations";

export const dynamic = "force-dynamic";

export default async function KpiPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; year?: string; tenant?: string }>;
}) {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const isAdmin = me?.permission === "admin";
  // 受注企業カード上のプロダクト編集（追加/変更/金額修正）は user/admin のみ
  const canEditProducts = me?.permission === "admin" || me?.permission === "user";

  const sp = await searchParams;

  // ── 表示対象の会社（Luma / リージー）─────────────────────────
  // KPI は会社ごとに完全に分けて見る。サイドバーのタブ（＝商談の登録先）とは独立させ、
  // URL の ?tenant= で切り替える。経営視点で2社の数字を続けて確認するための作り。
  // 会計年度が会社ごとに違う（Luma=6月始まり / リージー=1月始まり）ため、合算はしない。
  const myTenants = await listMyTenants();
  const activeCtx = await getRequestTenant();
  const selectedTenant =
    myTenants.find((t) => t.code === sp.tenant) ??
    myTenants.find((t) => t.id === activeCtx?.tenantId) ??
    myTenants[0];

  if (!selectedTenant) {
    return (
      <>
        <Header title="KPI" subtitle="表示できる会社がありません" />
        <div className="px-8 py-6 text-sm text-zinc-600">
          所属している会社がありません。管理者に権限の確認を依頼してください。
        </div>
      </>
    );
  }

  // URLに owner が無ければ全員、"all"=全員、"me"=自分、その他=個別ユーザーID
  const ownerParam = sp.owner ?? "all";
  const userId =
    ownerParam === "me"
      ? session?.userId
      : ownerParam === "all"
        ? undefined
        : ownerParam;
  const isOrgView = !userId;

  const startMonth = selectedTenant.fiscalYearStartMonth;
  // year パラメータは会計年度（FY2026 → 2026）。未指定時は選択中の会社の現在年度。
  const year = sp.year ? Number(sp.year) : getFiscalYear(startMonth);

  // 選択した会社のコンテキストでデータを引く。
  // これにより Prisma Extension が全クエリを その会社に絞り、
  // getGoalsHierarchy 等の中の会計年度計算もその会社の開始月で行われる。
  const loaded = await runAsUserTenant(selectedTenant.id, async () => {
    // 受注企業カードのプロダクト追加/変更に使う商材マスタ（カテゴリ＋プラン）
    const productMasters = await prisma.product.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      include: {
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, name: true, basePrice: true },
        },
      },
    });
    const [dashboard, series, hierarchy, monthlyWonDeals, users, fullyLostDealIds] =
      await Promise.all([
        getDashboardData({ userId }),
        getKpiTimeseries(userId),
        getGoalsHierarchy(year, userId),
        getMonthlyWonDealsByPeriod(year, userId),
        getSalesUsers(),
        getFullyLostDealIds(),
      ]);
    return { productMasters, dashboard, series, hierarchy, monthlyWonDeals, users, fullyLostDealIds };
  });

  if (!loaded) {
    return (
      <>
        <Header title="KPI" subtitle="表示できません" />
        <div className="px-8 py-6 text-sm text-zinc-600">
          この会社のKPIを閲覧する権限がありません。
        </div>
      </>
    );
  }

  const { productMasters, series, hierarchy, monthlyWonDeals, users, fullyLostDealIds } = loaded;
  const { kpi, deals } = loaded.dashboard;
  const fullyLostSet = new Set(fullyLostDealIds);

  // ヨミがAヨミ以上（受注に近い）かつ Next Action未設定の Deal をアラート対象に
  // ヨミランク：受注7 / A+ヨミ6 / Aヨミ5 / Bヨミ4 / Cヨミ3 / ネタ2 / NG1
  // NG/日程調整不可/完全失注は除外（社長判断 2026-05）
  const HIGH_YOMI_RANK = 5; // Aヨミ以上
  const alerts = deals
    .map((d) => ({
      ...d,
      _yomi: representativeYomi(d.products as DealProductLite[]),
      _yomiRank: dealYomiRank(d.products as DealProductLite[]),
      _productNames: d.products.map((p) => p.productName).slice(0, 3),
      _restCount: Math.max(0, d.products.length - 3),
    }))
    .filter(
      (d) =>
        d._yomiRank >= HIGH_YOMI_RANK &&
        !d.nextAction &&
        !isExcludedFromNextAction(d, fullyLostSet),
    );

  return (
    <>
      <Header
        title="KPI"
        subtitle={
          // 2社を扱う場合はどちらの数字を見ているかを必ず出す
          `${myTenants.length > 1 ? `${selectedTenant.shortName}｜` : ""}${
            isOrgView ? "組織全体のパフォーマンス" : "個人パフォーマンス"
          }｜${fyDisplayLabel(startMonth, year)}`
        }
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white space-y-2">
        <div className="flex items-start justify-between gap-3">
          <OwnerTabs users={users} currentUserId={session?.userId ?? ""} selected={ownerParam} />
          {/* 新規商談作成（admin/user のみ）。作成後は詳細画面へ遷移。
              受注（ヨミ=受注）と受注計上日を入れれば、KPIの月次集計に即反映される。 */}
          {canEditProducts && (
            <div className="shrink-0">
              <NewDealDialog />
            </div>
          )}
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {/* 会社タブ（Luma / リージー）。所属が1社なら表示されない */}
          <KpiTenantTabs tenants={myTenants} selectedCode={selectedTenant.code} />
          <YearTabs currentFy={getFiscalYear(startMonth)} selectedYear={year} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-5 bg-zinc-50">
        {/* 年間KGI / 四半期KPI / 月次KPI を一画面で俯瞰 */}
        <KpiHierarchyView
          data={hierarchy}
          year={year}
          fiscalStartMonth={startMonth}
          isOrgView={isOrgView}
          monthlyWonDeals={monthlyWonDeals}
          productMasters={productMasters.map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            plans: p.plans,
          }))}
          canEditProducts={canEditProducts}
        />

        <KpiCards kpi={kpi} />
        <KpiCharts data={series} />

        {/* admin 限定：KPI目標管理（年/四半期/月のタブ切替） */}
        {isAdmin && <GoalsAdmin year={year} fiscalStartMonth={startMonth} users={users} />}

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
                ヨミの高い商談は全てNext Actionが定義されています。
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {alerts.map((d) => (
                  <li key={d.id} className="py-2 text-sm flex justify-between">
                    <span>
                      {d.company.name} / {d._productNames.join(", ")}
                      {d._restCount > 0 && ` 他${d._restCount}件`}
                    </span>
                    <Badge variant="danger">{d._yomi ?? "ヨミ未設定"} / Next未設定</Badge>
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
