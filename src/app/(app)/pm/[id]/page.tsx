import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Header } from "@/components/layout/header";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { PmDetail, type PmDetailData } from "@/components/pm/pm-detail";

export const dynamic = "force-dynamic";

/**
 * PM 案件詳細ページ /pm/[id]
 * 一覧の顧客名クリックから新規タブで開く。
 * 紐づくDealの議事録(Meeting)・提案企画書(Document proposal)・
 * 絵コンテ/香盤表(映像)/管理シート(SNS)・SNSアカウント表を表示・編集する。
 */
export default async function PmDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");
  const canSeeSecret = hasPermission(me?.permission, "user");

  const project = await prisma.productionProject.findUnique({
    where: { id },
    include: {
      deal: { select: { id: true, title: true, company: { select: { id: true, name: true } } } },
      company: { select: { id: true, name: true } },
      dealProduct: {
        select: { id: true, productName: true, planName: true, yomiStatus: true, amount: true },
      },
      snsAccounts: { orderBy: { platform: "asc" } },
    },
  });
  if (!project) notFound();

  const meetings = await prisma.meeting.findMany({
    where: { dealId: project.dealId },
    orderBy: { meetingDate: "desc" },
    select: {
      id: true,
      title: true,
      meetingDate: true,
      minutes: true,
      summary: true,
      recordingUrl: true,
    },
  });

  const proposals = await prisma.document.findMany({
    where: { dealId: project.dealId, scope: "deal", category: "proposal" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      sourceType: true,
      fileUrl: true,
      version: true,
      description: true,
      createdAt: true,
    },
  });

  const isSns = project.category === "SNS";
  const companyName = project.company?.name ?? project.deal?.company?.name ?? null;

  // クライアントに渡す（password は権限でガード）
  const data: PmDetailData = {
    project: {
      id: project.id,
      dealId: project.dealId,
      category: project.category,
      projectName: project.projectName,
      status: project.status,
      pmName: project.pmName,
      directorName: project.directorName,
      cameraName: project.cameraName,
      editorName: project.editorName,
      note: project.note,
      storyboardUrl: project.storyboardUrl,
      shootingScheduleUrl: project.shootingScheduleUrl,
      totalPosts: project.totalPosts,
      serviceStartMonth: project.serviceStartMonth ? project.serviceStartMonth.toISOString() : null,
      serviceEndMonth: project.serviceEndMonth ? project.serviceEndMonth.toISOString() : null,
      mgmtSheetUrl: project.mgmtSheetUrl,
      companyName,
      planName: project.dealProduct?.planName ?? null,
      productName: project.dealProduct?.productName ?? null,
      snsAccounts: project.snsAccounts.map((a) => ({
        id: a.id,
        platform: a.platform,
        accountId: a.accountId,
        password: canSeeSecret ? a.password : null,
        profileUrl: a.profileUrl,
        miyakePcLogin: a.miyakePcLogin,
      })),
    },
    meetings: meetings.map((m) => ({
      id: m.id,
      title: m.title,
      meetingDate: m.meetingDate.toISOString(),
      minutes: m.minutes,
      summary: m.summary,
      recordingUrl: m.recordingUrl,
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      name: p.name,
      sourceType: p.sourceType,
      fileUrl: p.fileUrl,
      version: p.version,
      description: p.description,
      createdAt: p.createdAt.toISOString(),
    })),
    isSns,
    canEdit,
    canSeeSecret,
  };

  return (
    <>
      <Header
        title={companyName ?? project.projectName}
        subtitle={`案件詳細 / ${isSns ? "SNS運用" : project.category ?? "案件"}`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <div className="mb-4">
          <Link
            href="/pm"
            className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800"
          >
            <ArrowLeft className="h-4 w-4" />
            PM一覧へ戻る
          </Link>
        </div>
        <PmDetail data={data} />
      </div>
    </>
  );
}
