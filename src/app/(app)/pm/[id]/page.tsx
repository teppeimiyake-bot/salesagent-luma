import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 旧 PM 案件詳細ページ /pm/[id]
 *
 * Phase 7（PM再構成）以降、受注後の管理は商談詳細ページの「PM管理」タブに一元化した。
 * 重複UIを避けるため、このルートは該当商談の /deals/[dealId]?tab=pm へリダイレクトする。
 */
export default async function PmDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await prisma.productionProject.findUnique({
    where: { id },
    select: { dealId: true },
  });
  if (!project) notFound();
  redirect(`/deals/${project.dealId}?tab=pm`);
}
