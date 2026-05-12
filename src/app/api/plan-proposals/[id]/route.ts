import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().min(1).max(20).optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
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
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.name) {
    const dup = await prisma.planProposal.findFirst({ where: { name: parsed.data.name, NOT: { id } } });
    if (dup) {
      return NextResponse.json({ error: "同名の企画提案が既に存在します" }, { status: 409 });
    }
  }
  const updated = await prisma.planProposal.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ planProposal: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;
  // PlanProposal は FK ではなく DealProduct.planProposals(String[]) に name で保持されるため、
  // 物理削除しても既存商談のタグ表示は壊れない（マスタから消えるとピル色だけ無彩化）。そのまま削除する。
  await prisma.planProposal.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
