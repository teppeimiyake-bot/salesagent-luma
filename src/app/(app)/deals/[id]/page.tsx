import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { Badge } from "@/components/ui/badge";
import { prisma } from "@/lib/db";
import { UploadRecording } from "@/components/deals/upload-recording";
import { MeetingRecorder } from "@/components/deals/meeting-recorder";
import { AiPanel } from "@/components/deals/ai-panel";
import { TasksList } from "@/components/deals/tasks-list";
import { DealStatusBar } from "@/components/deals/deal-status";
import { DealProductsPanel } from "@/components/deals/deal-products-panel";
import { RoleplayPanel } from "@/components/deals/roleplay-panel";
import { PreparationPanel } from "@/components/deals/preparation-panel";
import { DealDocuments } from "@/components/deals/deal-documents";
import { DealQuotes } from "@/components/deals/deal-quotes";
import { MeetingHistory } from "@/components/deals/meeting-history";
import { BantSummary } from "@/components/deals/bant-summary";
import { DealPlanInfo } from "@/components/deals/deal-plan-info";
import { DealOverviewPanel } from "@/components/deals/deal-overview-panel";
import { AiChat } from "@/components/dashboard/ai-chat";
import { NewTaskDialog } from "@/components/todos/new-task-dialog";
import { CompanyLogo } from "@/components/ui/company-logo";
import { DeleteButton } from "@/components/shared/delete-button";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { getSalesUsers } from "@/lib/queries";
import { getSession } from "@/lib/auth";
import { ArrowLeft } from "lucide-react";
import type { DealStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = me?.permission === "admin" || me?.permission === "user";
  const isAdmin = me?.permission === "admin";

  const [deal, users, productMasters] = await Promise.all([
    prisma.deal.findUnique({
      where: { id },
      include: {
        company: true,
        owner: { select: { id: true, name: true, avatarColor: true, email: true } },
        leadSource: { select: { id: true, name: true } },
        products: {
          include: {
            owner: { select: { id: true, name: true, avatarColor: true } },
            product: { select: { id: true, name: true } },
          },
          orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
        },
        meetings: { orderBy: { meetingDate: "desc" } },
        tasks: { orderBy: [{ status: "asc" }, { createdAt: "desc" }] },
      },
    }),
    getSalesUsers(),
    prisma.product.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      include: {
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true, name: true, basePrice: true },
        },
      },
    }),
  ]);
  if (!deal || deal.deletedAt || deal.company.deletedAt) notFound();
  // 最新ミーティング（AI Panel に渡す既存のシグネチャ用）
  const latestMeeting = deal.meetings[0] ?? null;

  return (
    <>
      <Header
        title={
          <span className="inline-flex items-center gap-3">
            <CompanyLogo
              name={deal.company.name}
              logoUrl={deal.company.logoUrl}
              logoColor={deal.company.logoColor}
              size="sm"
            />
            <Link href={`/companies/${deal.company.id}`} className="hover:text-emerald-600">
              {deal.company.name}
            </Link>
          </span>
        }
        subtitle={deal.title}
        right={
          canEdit ? (
            <div className="flex items-center gap-2">
              <NewTaskDialog defaultDealId={deal.id} />
              <DeleteButton
                endpoint={`/api/deals/${deal.id}`}
                targetLabel={deal.company.name}
                variant="button"
                redirectTo="/deals"
                stopPropagation={false}
              />
            </div>
          ) : null
        }
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white flex items-center gap-2 flex-wrap">
        <Link href="/deals" className="text-sm text-zinc-500 hover:text-emerald-600 inline-flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" /> 商談一覧
        </Link>
        <span className="text-zinc-300">|</span>
        <Badge variant={statusColor(deal.status as DealStatus)}>
          {STATUS_LABEL[deal.status as DealStatus]}
        </Badge>
        {deal.company.industry && <Badge variant="secondary">{deal.company.industry}</Badge>}
        {deal.nextAction && (
          <span className="text-sm text-zinc-600 ml-2 truncate">
            <span className="font-medium">Next:</span> {deal.nextAction}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto bg-zinc-50">
        <div className="p-6 grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-7 space-y-4">
            <DealProductsPanel
              dealId={deal.id}
              initial={deal.products.map((p) => ({
                id: p.id,
                productId: p.productId,
                productName: p.productName,
                planName: p.planName,
                probability: p.probability,
                amount: p.amount,
                yomiStatus: p.yomiStatus,
                ownerUserId: p.ownerUserId,
                notes: p.notes,
                owner: p.owner,
                product: p.product,
              }))}
              users={users}
              products={productMasters.map((p) => ({
                id: p.id,
                name: p.name,
                category: p.category,
                plans: p.plans,
              }))}
              canEdit={canEdit}
              isAdmin={isAdmin}
            />
            <DealStatusBar
              deal={{
                id: deal.id,
                status: deal.status as DealStatus,
                pipelineStage: deal.pipelineStage,
                nextAction: deal.nextAction,
                nextActionAt: deal.nextActionAt,
                appointmentDate: deal.appointmentDate,
                contractDate: deal.contractDate,
                expectedCloseDate: deal.expectedCloseDate,
                leadSourceId: deal.leadSourceId,
                leadSource: deal.leadSource,
                leadSourceMemo: deal.leadSourceMemo,
                owner: deal.owner,
              }}
              users={users}
              canEdit={canEdit}
            />
            <PreparationPanel dealId={deal.id} status={deal.status} />
            {/* Notion由来「企画内容」+「ご提案企画書URL」の閲覧表示（Phase 1） */}
            <DealPlanInfo bant={deal.bant} />
            {/* 案件全体のBANT集約サマリ（商談記録の外で1つに集約） */}
            <BantSummary
              dealId={deal.id}
              initial={deal.bant as Parameters<typeof BantSummary>[0]["initial"]}
              bantUpdatedAt={deal.bantUpdatedAt}
              meetingsCount={deal.meetings.length}
              canEdit={canEdit}
            />
            <RoleplayPanel dealId={deal.id} />
            <MeetingRecorder dealId={deal.id} />
            <UploadRecording dealId={deal.id} />
            {/* 複数回商談を時系列で記録・編集（BANTは案件全体に集約済のため、各回はメモのみ） */}
            <MeetingHistory dealId={deal.id} meetings={deal.meetings} />
            <DealQuotes dealId={deal.id} canEdit={canEdit} />
            <DealDocuments dealId={deal.id} />
            <TasksList tasks={deal.tasks} />
          </div>

          {/* 右パネル：これまでの流れ + 次の一手 + AIチャット */}
          <div className="xl:col-span-5">
            <div className="xl:sticky xl:top-4 space-y-4">
              {/* これまでの流れ + 次の一手 */}
              <DealOverviewPanel
                deal={{
                  nextAction: deal.nextAction,
                  nextActionAt: deal.nextActionAt,
                }}
                meetings={deal.meetings}
              />

              {/* 最新MTGのAI 7段分析パネル（既存） */}
              <AiPanel dealId={deal.id} meeting={latestMeeting} />

              {/* 営業AIチャット（商談スコープ） */}
              <div className="h-[520px]">
                <AiChat scope={`deal:${deal.id}`} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
