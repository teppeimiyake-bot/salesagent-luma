import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { PM_STAFF_ROLES } from "../route";

const updateSchema = z.object({
  role: z.enum(PM_STAFF_ROLES).optional(),
  name: z.string().min(1).max(60).optional(),
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
  // role/name 変更時は (role,name) の一意制約に抵触しないか確認
  if (parsed.data.name || parsed.data.role) {
    const current = await prisma.pmStaff.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const role = parsed.data.role ?? current.role;
    const name = parsed.data.name ?? current.name;
    const dup = await prisma.pmStaff.findFirst({ where: { role, name, NOT: { id } } });
    if (dup) {
      return NextResponse.json({ error: "同じ役割に同名のスタッフが既に存在します" }, { status: 409 });
    }
  }
  const updated = await prisma.pmStaff.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ staff: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  // ProductionProject 側はテキスト保持（FK無し）のため、削除しても既存案件の表示値は壊れない。
  // 履歴温存の意図で、ハード削除でなく無効化に倒す運用に統一する。
  const updated = await prisma.pmStaff.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ staff: updated, mode: "deactivated" });
}
