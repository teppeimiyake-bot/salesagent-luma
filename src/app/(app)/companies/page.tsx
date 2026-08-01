import Link from "next/link";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { totalProposedAmount, topProductLabels } from "@/lib/deal-aggregations";
import { CompaniesList, type CompanyRow } from "@/components/companies/companies-list";
import { getRequestTenant, listMyTenants } from "@/lib/tenant-context";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");

  // ── 表示範囲 ────────────────────────────────────────────
  // 企業マスタは Luma・リージー共有なので、何もしないと相手の会社の顧客まで
  // 一覧に出てしまう。既定では「いま見ている会社に関係する企業」だけを出す:
  //   自社が登録した企業 ∪ 自社の商談がある企業
  // ?scope=all で全社の企業を見られる（相互送客の相手を探すときに使う）。
  const sp = await searchParams;
  const showAll = sp.scope === "all";
  const [ctx, myTenants] = await Promise.all([getRequestTenant(), listMyTenants()]);
  const myTenantCount = myTenants.length;
  const tenantId = ctx?.crossTenant ? null : (ctx?.tenantId ?? null);
  const scopeFilter =
    showAll || !tenantId
      ? {}
      : {
          OR: [
            { createdByTenantId: tenantId },
            // 商談は Extension が絞るが、ネストした where には効かないので明示する
            { deals: { some: { tenantId, deletedAt: null } } },
          ],
        };

  const companiesRaw = await prisma.company.findMany({
    where: { deletedAt: null, ...scopeFilter },
    include: {
      _count: { select: { deals: true, contacts: true } },
      deals: {
        where: { deletedAt: null },
        select: {
          id: true,
          status: true,
          products: { select: { id: true, productName: true, probability: true, amount: true, yomiStatus: true } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  // 一覧行データを集計（業種フィルタはクライアント側 CompaniesList で処理）
  const rows: CompanyRow[] = companiesRaw.map((c) => {
    const active = c.deals.filter(
      (d) => d.status !== "WON" && d.status !== "LOST",
    );
    const allProducts = active.flatMap((d) => d.products);
    const { primary, rest } = topProductLabels(allProducts, 2);
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      logoUrl: c.logoUrl,
      logoColor: c.logoColor,
      address: c.address,
      phoneNumber: c.phoneNumber,
      // _count.deals はソフト削除を反映しないので active な deals 配列長で上書き
      dealCount: c.deals.length,
      activeCount: active.length,
      contactCount: c._count.contacts,
      proposedAmount: totalProposedAmount(allProducts),
      primaryProducts: primary.map((p) => ({ productName: p.productName })),
      restProducts: rest,
    };
  });

  return (
    <>
      <Header
        title="企業"
        subtitle={`${rows.length} 社${showAll ? "（全社）" : ""}`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50 space-y-3">
        {/* 表示範囲の切り替え。所属が1社だけの人には関係ないので出さない */}
        {tenantId && myTenantCount > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/companies"
              className={cn(
                "rounded-md px-3 py-1.5 font-semibold transition-colors",
                showAll ? "text-zinc-600 hover:bg-white" : "bg-zinc-800 text-white",
              )}
            >
              {/* 表示名は会社設定（tenants.short_name）に従う */}
              {`${myTenants.find((t) => t.id === tenantId)?.shortName ?? "自社"}の取引先`}
            </Link>
            <Link
              href="/companies?scope=all"
              className={cn(
                "rounded-md px-3 py-1.5 font-semibold transition-colors",
                showAll ? "bg-zinc-800 text-white" : "text-zinc-600 hover:bg-white",
              )}
            >
              全社の企業
            </Link>
            <span className="text-xs text-zinc-500">
              企業マスタは2社共通です。既定では自社に関係する企業だけを表示しています。
            </span>
          </div>
        )}
        <Card>
          <CardContent className="p-4 md:p-5">
            <CompaniesList companies={rows} canEdit={canEdit} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
