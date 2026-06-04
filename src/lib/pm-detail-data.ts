import { prisma } from "@/lib/db";
import type { PmDetailData } from "@/components/pm/pm-detail";

/**
 * ProductionProject（受注案件）1件分の PmDetailData を組み立てる共通サーバヘルパー。
 *
 * /pm/[id] 詳細ページと、商談詳細ページ（/deals/[id]?tab=pm）の「PM管理」タブの
 * 両方から再利用する。password は canSeeSecret でガードする。
 */
export async function buildPmDetailData(
  projectId: string,
  opts: { canEdit: boolean; canSeeSecret: boolean },
): Promise<PmDetailData | null> {
  const { canEdit, canSeeSecret } = opts;

  const project = await prisma.productionProject.findUnique({
    where: { id: projectId },
    include: {
      deal: { select: { id: true, title: true, company: { select: { id: true, name: true } } } },
      company: { select: { id: true, name: true } },
      dealProduct: {
        select: { id: true, productName: true, planName: true, yomiStatus: true, amount: true },
      },
      snsAccounts: { orderBy: { platform: "asc" } },
    },
  });
  if (!project) return null;

  const [meetings, proposals] = await Promise.all([
    prisma.meeting.findMany({
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
    }),
    prisma.document.findMany({
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
    }),
  ]);

  const isSns = project.category === "SNS";
  const companyName = project.company?.name ?? project.deal?.company?.name ?? null;

  return {
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
}

/**
 * 1つの Deal に紐づく ProductionProject を全件取得し、PmDetailData の配列を返す。
 * 商談詳細ページの「PM管理」タブで、受注プロダクトごとに表示するために使う。
 * 並び：カテゴリ → 作成日。
 */
export async function buildPmDetailDataForDeal(
  dealId: string,
  opts: { canEdit: boolean; canSeeSecret: boolean },
): Promise<PmDetailData[]> {
  const projects = await prisma.productionProject.findMany({
    where: { dealId },
    orderBy: [{ category: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const built = await Promise.all(
    projects.map((p) => buildPmDetailData(p.id, opts)),
  );
  return built.filter((d): d is PmDetailData => d !== null);
}
