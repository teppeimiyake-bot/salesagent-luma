import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const period = url.searchParams.get("period") ?? undefined;
  const goals = await prisma.goal.findMany({
    where: { ...(period ? { period } : {}) },
    include: { owner: { select: { id: true, name: true, avatarColor: true } } },
    orderBy: [{ period: "desc" }, { ownerUserId: "asc" }],
  });
  return NextResponse.json({ goals });
}

const upsertSchema = z.object({
  period: z.string().min(1),
  targetAmount: z.number().int().min(0),
  ownerUserId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  // KPI目標の作成・更新は admin のみ
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { permission: true } });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { period, targetAmount, ownerUserId } = parsed.data;
  const existing = await prisma.goal.findFirst({
    where: { period, ownerUserId: ownerUserId ?? null },
  });
  const goal = existing
    ? await prisma.goal.update({ where: { id: existing.id }, data: { targetAmount } })
    : await prisma.goal.create({ data: { period, targetAmount, ownerUserId: ownerUserId ?? null } });
  return NextResponse.json({ goal });
}

export async function DELETE(req: Request) {
  // 削除も admin のみ
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { permission: true } });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.goal.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
