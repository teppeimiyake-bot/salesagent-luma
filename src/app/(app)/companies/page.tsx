import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { totalProposedAmount, topProductLabels } from "@/lib/deal-aggregations";
import { CompaniesList, type CompanyRow } from "@/components/companies/companies-list";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");
  const companiesRaw = await prisma.company.findMany({
    where: { deletedAt: null },
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
      <Header title="企業" subtitle={`${rows.length} 社`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-4 md:p-5">
            <CompaniesList companies={rows} canEdit={canEdit} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
