import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { CompanyHero } from "@/components/companies/company-hero";
import { CompanyTabs } from "@/components/companies/company-tabs";
import { NextActionsSummary } from "@/components/companies/next-actions-summary";
import { DeleteButton } from "@/components/shared/delete-button";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { ArrowLeft } from "lucide-react";
import { pipelineAmount as calcPipelineAmount } from "@/lib/deal-aggregations";

export const dynamic = "force-dynamic";

export default async function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { isDecisionMaker: "desc" }, { createdAt: "asc" }],
      },
      deals: {
        where: { deletedAt: null },
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          products: {
            include: {
              owner: { select: { id: true, name: true, avatarColor: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!company || company.deletedAt) notFound();

  const active = company.deals.filter((d) => d.status !== "WON" && d.status !== "LOST");
  const allActiveProducts = active.flatMap((d) => d.products);
  const pipelineAmount = calcPipelineAmount(allActiveProducts);
  // 累計受注：受注計上日ベース（contractDate が入っており、yomiStatus="受注" のDealProductのみ）
  const wonAmount = company.deals
    .filter((d) => d.contractDate != null)
    .flatMap((d) => d.products)
    .filter((p) => p.yomiStatus === "受注")
    .reduce((s, p) => s + (p.amount ?? 0), 0);

  return (
    <>
      <Header
        title={company.name}
        subtitle={company.industry ?? undefined}
        right={
          canEdit ? (
            <DeleteButton
              endpoint={`/api/companies/${company.id}`}
              targetLabel={company.name}
              variant="button"
              redirectTo="/companies"
              stopPropagation={false}
              extraNote={
                company.deals.length > 0
                  ? `この企業に紐づく商談 ${company.deals.length} 件もまとめてゴミ箱に移動します。`
                  : undefined
              }
            />
          ) : null
        }
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white flex items-center gap-3">
        <Link
          href="/companies"
          className="text-sm text-zinc-500 hover:text-emerald-600 inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 企業一覧
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50 space-y-5">
        <CompanyHero
          company={company}
          stats={{
            pipelineAmount,
            wonAmount,
            activeDeals: active.length,
            contacts: company.contacts.length,
          }}
        />
        <NextActionsSummary deals={company.deals} />
        <CompanyTabs company={company} />
      </div>
    </>
  );
}
