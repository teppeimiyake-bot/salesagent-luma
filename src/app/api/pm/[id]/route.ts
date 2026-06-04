import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { PRODUCTION_STATUSES } from "@/lib/production";

const updateSchema = z.object({
  projectName: z.string().min(1).optional(),
  status: z.enum(PRODUCTION_STATUSES).optional(),
  category: z.string().nullable().optional(),
  pmName: z.string().nullable().optional(),
  directorName: z.string().nullable().optional(),
  cameraName: z.string().nullable().optional(),
  editorName: z.string().nullable().optional(),
  shootDate: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  provisionalDeliveryDate: z.string().nullable().optional(),
  delivered: z.boolean().optional(),
  note: z.string().nullable().optional(),
  // 映像：絵コンテ／香盤表URL
  storyboardUrl: z.string().nullable().optional(),
  shootingScheduleUrl: z.string().nullable().optional(),
  // SNS：総投稿本数／提供開始・終了月／管理シートURL
  totalPosts: z.string().nullable().optional(),
  serviceStartMonth: z.string().nullable().optional(),
  serviceEndMonth: z.string().nullable().optional(),
  mgmtSheetUrl: z.string().nullable().optional(),
});

function toDate(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  if (s === null || s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * PATCH /api/pm/[id]
 * 案件進捗のインライン編集。プロジェクト名・ステータス・各担当者・各日付・備考・納品済。
 * delivered=true にした場合は status を DELIVERED に追従させる（逆方向は強制しない）。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // 納品済みチェックを入れたら status も DELIVERED に寄せる（明示 status 指定が優先）
  const status =
    d.status !== undefined ? d.status : d.delivered === true ? ("DELIVERED" as const) : undefined;

  const updated = await prisma.productionProject.update({
    where: { id },
    data: {
      ...(d.projectName !== undefined ? { projectName: d.projectName } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
      ...(d.pmName !== undefined ? { pmName: d.pmName } : {}),
      ...(d.directorName !== undefined ? { directorName: d.directorName } : {}),
      ...(d.cameraName !== undefined ? { cameraName: d.cameraName } : {}),
      ...(d.editorName !== undefined ? { editorName: d.editorName } : {}),
      ...(d.shootDate !== undefined ? { shootDate: toDate(d.shootDate) } : {}),
      ...(d.deliveryDate !== undefined ? { deliveryDate: toDate(d.deliveryDate) } : {}),
      ...(d.provisionalDeliveryDate !== undefined
        ? { provisionalDeliveryDate: toDate(d.provisionalDeliveryDate) }
        : {}),
      ...(d.delivered !== undefined ? { delivered: d.delivered } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.storyboardUrl !== undefined ? { storyboardUrl: d.storyboardUrl } : {}),
      ...(d.shootingScheduleUrl !== undefined
        ? { shootingScheduleUrl: d.shootingScheduleUrl }
        : {}),
      ...(d.totalPosts !== undefined ? { totalPosts: d.totalPosts } : {}),
      ...(d.serviceStartMonth !== undefined
        ? { serviceStartMonth: toDate(d.serviceStartMonth) }
        : {}),
      ...(d.serviceEndMonth !== undefined ? { serviceEndMonth: toDate(d.serviceEndMonth) } : {}),
      ...(d.mgmtSheetUrl !== undefined ? { mgmtSheetUrl: d.mgmtSheetUrl } : {}),
    },
    include: {
      deal: {
        select: { id: true, title: true, company: { select: { id: true, name: true } } },
      },
      company: { select: { id: true, name: true } },
      dealProduct: {
        select: { id: true, productName: true, planName: true, yomiStatus: true, amount: true },
      },
      snsAccounts: {
        select: {
          id: true,
          platform: true,
          accountId: true,
          profileUrl: true,
          miyakePcLogin: true,
        },
        orderBy: { platform: "asc" },
      },
    },
  });

  return NextResponse.json({ project: updated });
}
