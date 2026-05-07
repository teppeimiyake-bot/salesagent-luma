import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const updateSchema = z.object({
  value: z.string().min(1).max(80).optional(),
  label: z.string().min(1).max(80).optional(),
  group: z.enum(["before", "after", "contract"]).optional(),
  badgeBg: z.string().min(1).max(40).optional(),
  badgeText: z.string().min(1).max(40).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
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
  // value 変更時は重複チェック + 既存 Deal の pipelineStage 文字列も更新
  if (parsed.data.value) {
    const dup = await prisma.pipelineStage.findFirst({
      where: { value: parsed.data.value, NOT: { id } },
    });
    if (dup) {
      return NextResponse.json(
        { error: "同じ値のステージが既に存在します" },
        { status: 409 },
      );
    }
    const current = await prisma.pipelineStage.findUnique({ where: { id } });
    if (current && current.value !== parsed.data.value) {
      await prisma.deal.updateMany({
        where: { pipelineStage: current.value },
        data: { pipelineStage: parsed.data.value },
      });
    }
  }
  const stage = await prisma.pipelineStage.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({ stage });
}

/**
 * DELETE
 *  - 紐づくDealがある場合 → active=false に倒す（履歴温存）
 *  - 紐づくDealがない場合 → 物理削除
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  const stage = await prisma.pipelineStage.findUnique({ where: { id } });
  if (!stage) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const usageCount = await prisma.deal.count({
    where: { pipelineStage: stage.value, deletedAt: null },
  });
  if (usageCount > 0) {
    const updated = await prisma.pipelineStage.update({
      where: { id },
      data: { active: false },
    });
    return NextResponse.json({
      stage: updated,
      mode: "deactivated",
      usageCount,
      message: `このステージは ${usageCount} 件の商談で使用中のため、無効化しました（履歴は維持）`,
    });
  }
  await prisma.pipelineStage.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "deleted" });
}
