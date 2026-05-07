import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  // name 変更時は重複チェック
  if (parsed.data.name) {
    const dup = await prisma.leadSource.findFirst({
      where: { name: parsed.data.name, NOT: { id } },
    });
    if (dup) {
      return NextResponse.json({ error: "同名のリード獲得経由が既に存在します" }, { status: 409 });
    }
  }
  const updated = await prisma.leadSource.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({ leadSource: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  // 紐付くDealがある場合は active=false に倒すだけ（onDelete:SetNull だが履歴温存のため）
  const usageCount = await prisma.deal.count({ where: { leadSourceId: id } });
  if (usageCount > 0) {
    const updated = await prisma.leadSource.update({
      where: { id },
      data: { active: false },
    });
    return NextResponse.json({
      leadSource: updated,
      mode: "deactivated",
      usageCount,
      message: `この経由は ${usageCount} 件の商談で使用されているため、無効化しました（履歴は維持）`,
    });
  }
  await prisma.leadSource.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "deleted" });
}
