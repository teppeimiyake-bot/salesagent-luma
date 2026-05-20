import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * ms管理タブ用：商談プロセスステージ（pipelineStage）でフィルタした商談一覧を返す。
 *
 * GET /api/ms?stage=<pipelineStage値>
 *   - stage 指定あり：その pipelineStage の Deal（deletedAt=null）のみ
 *   - stage 指定なし：group="before" の全ステージにマッチする Deal
 *
 * 行のインライン編集に必要な情報（company.contacts / leadSource / owner）まで含める。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const stage = url.searchParams.get("stage");

  let stageFilter: Record<string, unknown> = {};
  if (stage) {
    stageFilter = { pipelineStage: stage };
  } else {
    // before グループの全ステージ
    const beforeStages = await prisma.pipelineStage.findMany({
      where: { group: "before" },
      select: { value: true },
    });
    stageFilter = { pipelineStage: { in: beforeStages.map((s) => s.value) } };
  }

  const deals = await prisma.deal.findMany({
    where: {
      ...stageFilter,
      deletedAt: null,
      company: { deletedAt: null },
    },
    orderBy: [{ appointmentDate: "desc" }, { updatedAt: "desc" }],
    include: {
      company: {
        include: {
          contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
        },
      },
      owner: { select: { id: true, name: true, avatarColor: true } },
      leadSource: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ deals });
}
