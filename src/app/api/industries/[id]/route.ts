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
  const data = { ...parsed.data };
  if (data.name) data.name = data.name.trim();
  // name 変更時は重複チェック
  if (data.name) {
    const dup = await prisma.industry.findFirst({
      where: { name: data.name, NOT: { id } },
    });
    if (dup) {
      return NextResponse.json({ error: "同名の業種が既に存在します" }, { status: 409 });
    }
  }
  const updated = await prisma.industry.update({ where: { id }, data });
  return NextResponse.json({ industry: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  const target = await prisma.industry.findUnique({ where: { id } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Company.industry はテキスト保持（FK無し）のため、マスタを消しても既存企業の業種表示値は壊れない。
  // 既にどこかの企業で使われている業種は履歴温存のため「無効化」に倒す。
  // 未使用なら物理削除してよい（誤追加の取り消し用）。
  const usageCount = await prisma.company.count({
    where: {
      deletedAt: null,
      OR: [
        { industry: target.name },
        { industry: { startsWith: `${target.name},` } },
        { industry: { endsWith: `,${target.name}` } },
        { industry: { contains: `,${target.name},` } },
        { industry: { startsWith: `${target.name}, ` } },
        { industry: { contains: `, ${target.name}` } },
      ],
    },
  });
  if (usageCount > 0) {
    const updated = await prisma.industry.update({
      where: { id },
      data: { active: false },
    });
    return NextResponse.json({
      industry: updated,
      mode: "deactivated",
      usageCount,
      message: `この業種は ${usageCount} 件の企業で使用されているため、無効化しました（既存の表示値は維持）`,
    });
  }
  await prisma.industry.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "deleted" });
}
