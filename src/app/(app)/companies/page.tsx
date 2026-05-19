import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { Users, ChevronRight, MapPin, Phone } from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { CompanyLogo } from "@/components/ui/company-logo";
import { DeleteButton } from "@/components/shared/delete-button";
import { getSession, hasPermission } from "@/lib/auth";
import { totalProposedAmount, topProductLabels } from "@/lib/deal-aggregations";

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
  // _count.deals はソフト削除を反映しないので、active な deals 配列長で上書き
  const companies = companiesRaw.map((c) => ({
    ...c,
    _count: { ...c._count, deals: c.deals.length },
  }));

  return (
    <>
      <Header title="企業" subtitle={`${companies.length} 社`} />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-0">
            {/* テーブルヘッダ */}
            <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-200 bg-zinc-50/50">
              <div className="col-span-4">企業</div>
              <div className="col-span-2">所在地</div>
              <div className="col-span-1 text-right">商談</div>
              <div className="col-span-1 text-right">連絡先</div>
              <div className="col-span-3 text-right">提案金額合計</div>
              <div className="col-span-1"></div>
            </div>

            <div className="divide-y divide-zinc-100">
              {companies.map((c) => {
                const active = c.deals.filter((d) => d.status !== "WON" && d.status !== "LOST");
                // 全アクティブDealのDealProductをまとめて提案金額合計を計算
                const allProducts = active.flatMap((d) => d.products);
                const proposedAmount = totalProposedAmount(allProducts);
                const { primary, rest } = topProductLabels(allProducts, 2);
                return (
                  <Link
                    key={c.id}
                    href={`/companies/${c.id}`}
                    className="grid grid-cols-12 gap-4 px-5 py-4 hover:bg-emerald-50/40 transition-colors group items-center"
                  >
                    {/* 企業名＋業種＋プロダクト */}
                    <div className="col-span-12 md:col-span-4 min-w-0">
                      <div className="flex items-center gap-3">
                        <CompanyLogo name={c.name} logoUrl={c.logoUrl} logoColor={c.logoColor} size="md" />
                        <div className="min-w-0">
                          <p className="font-bold text-lg truncate group-hover:text-emerald-700">
                            {c.name}
                          </p>
                          {c.industry && (
                            <p className="text-sm text-zinc-500 truncate">{c.industry}</p>
                          )}
                        </div>
                      </div>
                      {primary.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1 ml-13 pl-13">
                          {primary.map((p, i) => (
                            <Badge key={i} variant="outline" className="text-[11px]">
                              {p.productName}
                            </Badge>
                          ))}
                          {rest > 0 && (
                            <Badge variant="secondary" className="text-[11px]">
                              +{rest}
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 所在地 */}
                    <div className="hidden md:block col-span-2 text-xs text-zinc-600 min-w-0">
                      {c.address ? (
                        <div className="space-y-1">
                          <p className="inline-flex items-center gap-1 truncate">
                            <MapPin className="h-3 w-3 shrink-0 text-zinc-400" />
                            {c.address.split(/[市区町村]/)[0]}
                          </p>
                          {c.phoneNumber && (
                            <p className="inline-flex items-center gap-1 text-zinc-500">
                              <Phone className="h-3 w-3 shrink-0" />
                              {c.phoneNumber}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </div>

                    {/* 商談数 */}
                    <div className="hidden md:block col-span-1 text-right">
                      <div className="inline-flex items-baseline gap-1">
                        <span className="text-xl font-bold tabular-nums">{c._count.deals}</span>
                        <span className="text-[10px] text-zinc-400">件</span>
                      </div>
                      {active.length > 0 && (
                        <p className="text-[10px] text-emerald-600">{active.length} 進行</p>
                      )}
                    </div>

                    {/* 連絡先数 */}
                    <div className="hidden md:block col-span-1 text-right">
                      <div className="inline-flex items-baseline gap-1">
                        <Users className="h-3 w-3 text-zinc-400" />
                        <span className="text-xl font-bold tabular-nums">{c._count.contacts}</span>
                      </div>
                    </div>

                    {/* 提案金額合計 */}
                    <div className="hidden md:block col-span-3 text-right">
                      {proposedAmount > 0 ? (
                        <>
                          <p className="text-xl font-bold tabular-nums text-emerald-700">
                            {formatJPY(proposedAmount)}
                          </p>
                          <p className="text-[10px] text-zinc-400">進行中の提案金額合計</p>
                        </>
                      ) : (
                        <span className="text-sm text-zinc-400">—</span>
                      )}
                    </div>

                    <div className="hidden md:flex md:col-span-1 justify-end items-center gap-1">
                      {canEdit && (
                        <DeleteButton
                          endpoint={`/api/companies/${c.id}`}
                          targetLabel={c.name}
                          extraNote={
                            c._count.deals > 0
                              ? `この企業に紐づく商談 ${c._count.deals} 件もまとめてゴミ箱に移動します。`
                              : undefined
                          }
                        />
                      )}
                      <ChevronRight className="h-5 w-5 text-zinc-300 group-hover:text-emerald-500 transition-colors" />
                    </div>
                  </Link>
                );
              })}
              {companies.length === 0 && (
                <div className="px-5 py-12 text-center text-base text-zinc-500">
                  企業が登録されていません。
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
