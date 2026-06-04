import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const updateSchema = z.object({
  code: z.string().max(20).optional().nullable(),
  name: z.string().min(1).max(100).optional(),
  isAgency: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

// ワーカー編集は admin のみ
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
  const updated = await prisma.msWorker.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({ worker: updated });
}

// 削除は admin のみ。週次実績がある場合は active=false に倒すだけ（履歴温存）
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  const usageCount = await prisma.msWeeklyEntry.count({ where: { workerId: id } });
  if (usageCount > 0) {
    const updated = await prisma.msWorker.update({
      where: { id },
      data: { active: false },
    });
    return NextResponse.json({
      worker: updated,
      mode: "deactivated",
      usageCount,
      message: `このワーカーは ${usageCount} 件の週次実績で使用されているため、無効化しました（履歴は維持）`,
    });
  }
  await prisma.msWorker.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "deleted" });
}
