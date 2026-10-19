import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/layout/header";
import { prisma, prismaUnscoped } from "@/lib/db";
import { UploadRecording } from "@/components/deals/upload-recording";
import { MeetingRecorder } from "@/components/deals/meeting-recorder";
import { MeetSessionPanel } from "@/components/deals/meet-session-panel";
import { MeetingOwnerSelector } from "@/components/deals/meeting-owner-selector";
import { MeetingRecordingRoute } from "@/components/deals/meeting-recording-route";
import { AiPanel } from "@/components/deals/ai-panel";
import { TasksList } from "@/components/deals/tasks-list";
import { DealStatusBar } from "@/components/deals/deal-status";
import { DealProductsPanel } from "@/components/deals/deal-products-panel";
import { PreparationPanel } from "@/components/deals/preparation-panel";
import { DealDocuments } from "@/components/deals/deal-documents";
import { DealContracts } from "@/components/deals/deal-contracts";
import { QuoteBuilder } from "@/components/deals/quote-builder";
import { ContractGenerator } from "@/components/deals/contract-generator";
import { categoryFromDealProduct } from "@/lib/product-categories";
import { MeetingHistory } from "@/components/deals/meeting-history";
import { BantSummary } from "@/components/deals/bant-summary";
import { reconcileBantFromMeetings } from "@/lib/ai/bant-reconciliation";
import { DealOverviewPanel } from "@/components/deals/deal-overview-panel";
import { AiChat } from "@/components/dashboard/ai-chat";
import { NewTaskDialog } from "@/components/todos/new-task-dialog";
import { CompanyLogo } from "@/components/ui/company-logo";
import { DeleteButton } from "@/components/shared/delete-button";
import { getSalesUsers } from "@/lib/queries";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import {
  isMeetAutoRecordEnabled,
  isMeetFeatureEnabled,
  isPreparationV2Enabled,
  isQuotePdfV2Enabled,
} from "@/lib/feature-flags";
import { isWonYomi } from "@/lib/yomi-status";
import { buildPmDetailDataForDeal } from "@/lib/pm-detail-data";
import { PmDealPanel } from "@/components/pm/pm-deal-panel";
import { DealIndustryEditor } from "@/components/deals/deal-industry-editor";
import { DealHero } from "@/components/deals/deal-hero";
import { DealDetailTabs, type DealDetailTabDef } from "@/components/deals/deal-detail-tabs";
import { dealMeetNeedsAttention, deriveDealPhase } from "@/lib/deal-phase";
import { formatJstMeetingRange } from "@/lib/meeting-datetime";
import { dealMeetStatus } from "@/lib/meetings/meet-ingest";
import { isMeetingOwnerType, isOwnMeet } from "@/lib/meetings/meeting-owner";
import { recordingRouteFor } from "@/lib/meetings/recording-route";
import type { DealStatusValue } from "@/lib/deal-status";
import type { DealStatus } from "@prisma/client";
import { getRequestTenant } from "@/lib/tenant-context";

export const dynamic = "force-dynamic";

/**
 * 商談詳細ページ（タブ化刷新）。
 *
 * 刷新の考え方：
 *   13個の機能カードを1本のスクロールに積む構成をやめ、内容ごとの5タブ
 *   （概要 / 準備・BANT / 商談記録 / 見積・契約 / PM管理）に分ける。
 *   タブバーは要約カード直下の上部ヘッダー帯に置き、スクロール中も固定。
 *   右のコンテキストサマリー（次の一手・AI分析・AIチャット）はタブの外に置き、
 *   どのタブでも常に見える。
 *
 * 守っていること（受け入れ条件より）：
 *   - 機能・権限・API・データモデルは一切変えない。UIの再配置のみ
 *     （例外：Notion由来メモはUIから非表示。コンポーネントは残す）。
 *   - 既存コンポーネントは props も含めてそのまま利用する。
 *   - 商談一覧へ戻る際のフィルタ復元（?from）と PM管理直リンク（?tab=pm）を維持。
 *
 * 画面の固定について：
 *   常時固定するのは最上段の薄いヘッダーとタブバーだけ。
 *   要約カード（DealHero）はスクロール領域の中に置き、読み終えたら流れて消える。
 */
export default async function DealDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ from?: string; tab?: string }>;
}) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  // 商談一覧→詳細で渡される ?from=<encoded query>。戻りリンクで `/deals?<from>` に復元する。
  // 不正値（改行・スペース・URL先頭の `/` 等）が混ざるケースに備え、最低限の正常性チェックを行う。
  const rawFrom = typeof sp.from === "string" ? sp.from : "";
  const safeFrom = rawFrom && !rawFrom.includes("\n") && !rawFrom.startsWith("/") ? rawFrom : "";
  const backHref = safeFrom ? `/deals?${safeFrom}` : "/deals";

  // エージェントや全体検索のリンクは、現在選択中とは別テナントの商談を指すことがある。
  // そのまま tenant-scoped な findUnique を呼ぶと存在する商談でも 404 になるため、
  // 所属確認を行う Route Handler を経由して会社 Cookie を切り替えてから戻す。
  const tenantCtx = await getRequestTenant();
  if (tenantCtx && !tenantCtx.crossTenant && tenantCtx.tenantId) {
    const target = await prismaUnscoped.deal.findUnique({
      where: { id },
      select: { tenantId: true },
    });
    if (target && target.tenantId !== tenantCtx.tenantId) {
      const nextParams = new URLSearchParams();
      if (safeFrom) nextParams.set("from", safeFrom);
      if (sp.tab === "pm") nextParams.set("tab", "pm");
      const nextPath = `/deals/${id}${nextParams.size ? `?${nextParams.toString()}` : ""}`;
      redirect(
        `/api/tenant/ensure-deal?dealId=${encodeURIComponent(id)}&next=${encodeURIComponent(nextPath)}`,
      );
    }
  }

  const session = await getSession();
  const me = session
    ? { permission: await getCurrentPermission() }
    : null;
  const canEdit = me?.permission === "admin" || me?.permission === "user";
  const isAdmin = me?.permission === "admin";

  const [deal, users, productMasters, planProposalMasters] = await Promise.all([
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
    prisma.planProposal.findMany({
      where: { active: true },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, color: true },
    }),
  ]);
  if (!deal || deal.deletedAt || deal.company.deletedAt) notFound();
  // 最新ミーティング（AI Panel に渡す既存のシグネチャ用）
  const latestMeeting = deal.meetings[0] ?? null;
  const bantMeetingRefs = deal.meetings.map((meeting) => ({
    id: meeting.id,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
  }));

  // BANT JSON から業界業種・決算月を安全に narrow（DealPlanInfo と同じパターン）
  // - 業界業種: Notion 由来は ", " 区切り（複数選択）。company.industry を優先し、無ければ bant.industry。
  // - 決算月: bant.fiscalMonth（例 "3月", "12月", "不明"）。値が無ければ表示しない。
  const bantObj =
    deal.bant && typeof deal.bant === "object" && !Array.isArray(deal.bant)
      ? (deal.bant as Record<string, unknown>)
      : null;
  const bantIndustry =
    bantObj && typeof bantObj.industry === "string" && bantObj.industry.length > 0
      ? bantObj.industry
      : null;
  const industryLabel = deal.company.industry || bantIndustry;
  const fiscalMonth =
    bantObj && typeof bantObj.fiscalMonth === "string" && bantObj.fiscalMonth.length > 0
      ? bantObj.fiscalMonth
      : null;

  // PM管理タブ：受注（isWonYomi）DealProduct が1件以上ある商談でのみ表示する。
  const hasWonProduct = deal.products.some((p) => isWonYomi(p.yomiStatus));
  const canSeeSecret = hasPermission(me?.permission, "user");
  const pmProjects = hasWonProduct
    ? await buildPmDetailDataForDeal(deal.id, { canEdit, canSeeSecret })
    : [];
  // 受注プロダクトはあるが ProductionProject がまだ生成されていない場合もタブは出す
  // （バックフィル前の受注など）。中身は空状態メッセージで案内する。
  const hasPm = hasWonProduct;

  // T16：自社発行Meetの自動録画・文字起こしの状態。フラグOFFなら取得もしない。
  const meetAutoEnabled = isMeetAutoRecordEnabled();
  const meetingOwnerType = isMeetingOwnerType(deal.meetingOwnerType)
    ? deal.meetingOwnerType
    : "unknown";
  const ownMeet = isOwnMeet(meetingOwnerType);
  // 自社Meetの記録ルートの文言（ヒーロー・記録ルート欄・手動欄の見出し）はフラグで変わる。
  // OFF（切り戻し時）は自動記録が無いので「ブラウザ録音」と案内し、下の MeetingRecorder と食い違わせない。
  const recordingRoute = recordingRouteFor(meetingOwnerType, { autoRecordEnabled: meetAutoEnabled });
  // T21/T24：会議種別を自社Meet以外へ変えても meet_url・meet_event_id は消さない
  // （アプリはCalendar予定を削除しないため、自社Meetへ戻したときに同じ予定を再利用する。
  // 自社Meet以外だった間に変えた商談日時は、戻した後に同期するまで予定へ反映されない。設計_T21 §2.1）。
  // 残ったURLを先方会議・対面の参加先として出さないよう、画面で使うのは自社Meetの商談だけにする。
  const ownMeetUrl = ownMeet ? deal.meetUrl : null;
  // T16 AC8：自動記録が動く自社Meetの画面では、ブラウザ録音（開始・停止・送信・バックアップ復元）を出さない。
  // フラグOFF（切り戻し時）は自動記録が無いので、従来のブラウザ録音を残す。
  const autoRecordActive = meetAutoEnabled && ownMeet;
  const meetSessionStatus = autoRecordActive ? await dealMeetStatus(deal.id) : null;

  // ---- T15：いまの場面を判定して、要約と「いまここ」表示に使う -------------
  const hasMinutes = Boolean(latestMeeting?.minutes || latestMeeting?.minutesJson);
  const phase = deriveDealPhase({
    meetingStartAt: deal.meetingStartAt,
    meetingEndAt: deal.meetingEndAt,
    meetUrl: ownMeetUrl,
    meetingsCount: deal.meetings.length,
    latestMeetingStatus: latestMeeting?.processingStatus ?? null,
    latestMeetingHasMinutes: hasMinutes,
  });
  // T16：自動取得を打ち切った（Meetセッションが「確認が必要です」の）商談は、上部の要約でも要対応として出す。
  const meetNeedsAttention = dealMeetNeedsAttention(phase, meetSessionStatus?.phase, deal);
  const meetingRangeLabel = formatJstMeetingRange(deal.meetingStartAt, deal.meetingEndAt);
  const openTaskCount = deal.tasks.filter((t) => t.status !== "DONE" && t.status !== "SKIPPED").length;

  return (
    <>
      <Header
        compactOnMobile
        title={
          <span className="inline-flex items-center gap-3">
            <CompanyLogo
              name={deal.company.name}
              logoUrl={deal.company.logoUrl}
              logoColor={deal.company.logoColor}
              size="sm"
            />
            <Link href={`/companies/${deal.company.id}`} className="hover:text-orange-600">
              {deal.company.name}
            </Link>
          </span>
        }
        subtitle={deal.title}
      />

      <div data-deal-scroll-container className="flex-1 overflow-y-auto bg-zinc-50">
        {/* 要約と主操作。ここだけ読めば「いま何を押すか」が決まる。
            固定せずスクロールで流す（固定は上の薄いヘッダーだけに絞る）。 */}
        <DealHero
          dealId={deal.id}
          companyId={deal.company.id}
          companyName={deal.company.name}
          companyLogoUrl={deal.company.logoUrl}
          companyLogoColor={deal.company.logoColor}
          dealTitle={deal.title}
          status={deal.status as DealStatusValue}
          phase={phase}
          owner={deal.owner}
          meetingRangeLabel={meetingRangeLabel}
          meetUrl={ownMeetUrl}
          nextAction={deal.nextAction}
          nextActionAt={deal.nextActionAt ? deal.nextActionAt.toISOString() : null}
          industryLabel={industryLabel}
          fiscalMonth={fiscalMonth}
          hasMinutes={hasMinutes}
          recordingRoute={recordingRoute}
          meetNeedsAttention={meetNeedsAttention}
          backHref={backHref}
          actions={
            canEdit ? (
              <>
                <NewTaskDialog defaultDealId={deal.id} />
                <DeleteButton
                  endpoint={`/api/deals/${deal.id}`}
                  targetLabel={deal.company.name}
                  variant="button"
                  redirectTo="/deals"
                  stopPropagation={false}
                />
              </>
            ) : null
          }
        />

        <DealDetailTabs
          key={deal.id}
          tabs={
            [
              {
                id: "overview",
                label: "概要",
                count: deal.products.length,
                attention: openTaskCount > 0,
                content: (
                  <>
                    <div id="section-products" className="scroll-mt-20">
                      <DealProductsPanel
                        dealId={deal.id}
                        initial={deal.products.map((p) => ({
                          id: p.id,
                          productId: p.productId,
                          productName: p.productName,
                          planName: p.planName,
                          planProposals: p.planProposals,
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
                        planProposalMasters={planProposalMasters}
                        canEdit={canEdit}
                        isAdmin={isAdmin}
                      />
                    </div>

                    <div id="section-deal-status" className="scroll-mt-20">
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
                          meetingStartAt: deal.meetingStartAt,
                          meetingEndAt: deal.meetingEndAt,
                          meetUrl: ownMeetUrl,
                          meetEventId: deal.meetEventId,
                          leadSourceId: deal.leadSourceId,
                          leadSource: deal.leadSource,
                          leadSourceMemo: deal.leadSourceMemo,
                          owner: deal.owner,
                        }}
                        users={users}
                        canEdit={canEdit}
                        showMeetingDateTime={isMeetFeatureEnabled()}
                        allowMeetIssuance={ownMeet}
                      />
                    </div>

                    <div id="section-industry" className="scroll-mt-20">
                      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                        <p className="mb-2 text-[13px] font-medium text-zinc-500">業界業種</p>
                        <DealIndustryEditor
                          companyId={deal.company.id}
                          companyName={deal.company.name}
                          initialIndustry={deal.company.industry}
                          displayLabel={industryLabel}
                          canEdit={canEdit}
                        />
                      </div>
                    </div>

                    <div id="section-tasks" className="scroll-mt-20">
                      <TasksList tasks={deal.tasks} canEdit={canEdit} />
                    </div>
                  </>
                ),
              },
              {
                id: "prepare",
                label: "準備・BANT",
                content: (
                  <>
                    <div id="section-preparation" className="scroll-mt-20">
                      <PreparationPanel
                        dealId={deal.id}
                        status={deal.status}
                        preparationV2Enabled={isPreparationV2Enabled()}
                      />
                    </div>

                    {/* 案件全体のBANT集約サマリ（複数回商談の情報をここに1つへ） */}
                    <div id="section-bant" className="scroll-mt-20">
                      <BantSummary
                        dealId={deal.id}
                        initial={reconcileBantFromMeetings(deal.bant, deal.meetings)}
                        bantUpdatedAt={deal.bantUpdatedAt}
                        meetingsCount={deal.meetings.length}
                        canEdit={canEdit}
                        meetings={bantMeetingRefs}
                      />
                    </div>
                    {/* Notion由来の閲覧専用メモは役割を終えたためUIから外した
                        （復帰する場合は NotionMeetingNotes を再配置する） */}
                  </>
                ),
              },
              {
                id: "record",
                label: "商談記録",
                count: deal.meetings.length,
                attention: phase === "wrapup",
                content: (
                  // 要約カードの「商談の記録を確認する」の着地点として group-record を維持
                  <div id="group-record" className="space-y-5 scroll-mt-20">
                    <MeetingOwnerSelector
                      dealId={deal.id}
                      initialValue={meetingOwnerType}
                      canEdit={canEdit}
                    />

                    <MeetingRecordingRoute route={recordingRoute} />

                    {/* T16：自社発行Meetでは開始・停止・送信を押さない。状態と手動トリガーだけを置く */}
                    {autoRecordActive && meetSessionStatus && (
                      <div id="section-meet-session" className="scroll-mt-20">
                        <MeetSessionPanel
                          dealId={deal.id}
                          enabled={meetAutoEnabled}
                          initial={meetSessionStatus}
                          canEdit={canEdit}
                        />
                      </div>
                    )}

                    {canEdit && <section
                      data-testid="manual-recording-section"
                      className="space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/70 p-4"
                    >
                      <div>
                        <h2 className="text-[15px] font-semibold text-zinc-900">
                          {recordingRoute.manualSectionTitle}
                        </h2>
                        <p className="mt-1 text-[13px] leading-relaxed text-zinc-600">
                          {recordingRoute.manualSectionDescription}
                        </p>
                      </div>

                      {/* 対面のマイク録音・先方会議のタブ音声などの例外経路。
                          自動記録が動く自社Meetでは出さず、下の手動添付だけを救済経路に残す（T16 AC8） */}
                      {!autoRecordActive && (
                        <div id="section-record" className="scroll-mt-20">
                          <MeetingRecorder dealId={deal.id} />
                        </div>
                      )}

                      <div id="section-upload" className="scroll-mt-20">
                        <UploadRecording dealId={deal.id} />
                      </div>
                    </section>}

                    {/* 複数回商談を時系列で記録・編集（BANTは案件全体に集約済のため、各回はメモのみ） */}
                    <div id="section-history" className="scroll-mt-20">
                      <MeetingHistory dealId={deal.id} meetings={deal.meetings} canEdit={canEdit} />
                    </div>
                  </div>
                ),
              },
              {
                id: "quote",
                label: "見積・契約",
                content: (
                  <>
                    {/* 機能①：見積書 自動作成（DealProduct単位・PDF発行） */}
                    <div id="section-quote" className="scroll-mt-20">
                      <QuoteBuilder
                        dealId={deal.id}
                        companyName={deal.company.name}
                        dealProducts={deal.products.map((p) => ({
                          id: p.id,
                          productName: p.productName,
                          planName: p.planName,
                          planProposals: p.planProposals,
                          amount: p.amount,
                        }))}
                        canEdit={canEdit}
                        featureV2={isQuotePdfV2Enabled()}
                      />
                    </div>

                    <div id="section-documents" className="scroll-mt-20">
                      <DealDocuments dealId={deal.id} companyName={deal.company.name} canEdit={canEdit} />
                    </div>

                    {/* 機能②：契約書 自動生成（映像/SNS。A+ヨミ遷移でも自動生成） */}
                    <div id="section-contract-generator" className="scroll-mt-20">
                      <ContractGenerator
                        dealProducts={deal.products.map((p) => ({
                          id: p.id,
                          productName: p.productName,
                          planName: p.planName,
                          category: categoryFromDealProduct({
                            yomiStatus: p.yomiStatus,
                            productName: p.productName,
                            product: p.product,
                          }),
                          amount: p.amount,
                          yomiStatus: p.yomiStatus,
                        }))}
                        canEdit={canEdit}
                      />
                    </div>

                    {/* 商談ごとの個別契約書（全商談で常時表示） */}
                    <div id="section-contracts" className="scroll-mt-20">
                      <DealContracts dealId={deal.id} companyName={deal.company.name} canEdit={canEdit} />
                    </div>
                  </>
                ),
              },
              // PM管理：受注プロダクトがある商談のみ。?tab=pm の直リンク互換を維持
              ...(hasPm
                ? [
                    {
                      id: "pm",
                      label: "PM管理",
                      count: pmProjects.length,
                      content: <PmDealPanel projects={pmProjects} />,
                    } satisfies DealDetailTabDef,
                  ]
                : []),
            ] satisfies DealDetailTabDef[]
          }
          rail={
            <>
              <DealOverviewPanel
                dealId={deal.id}
                deal={{
                  nextAction: deal.nextAction,
                  nextActionAt: deal.nextActionAt,
                }}
                meetings={deal.meetings}
                canEdit={canEdit}
              />

              {/* 最新MTGのAI 7段分析パネル（既存） */}
              <AiPanel dealId={deal.id} meeting={latestMeeting} canEdit={canEdit} />

              {/* 営業AIチャット（商談スコープ） */}
              <div className="h-[520px]">
                <AiChat scope={`deal:${deal.id}`} canSend={canEdit} />
              </div>
            </>
          }
        />
      </div>
    </>
  );
}
