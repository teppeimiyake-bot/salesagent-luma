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

// 月次目標がマスタ（唯一の入力源）。period は YYYY-MM 形式のみ受理する。
// 四半期目標・年間KGI は月次の合算で自動算出するため、レコードを作らせない。
const MONTH_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const upsertSchema = z.object({
  period: z.string().regex(MONTH_PERIOD_RE, {
    message: "period は月次（YYYY-MM）のみ指定できます",
  }),
  // targetAmount=0 は「目標未設定」とみなしレコードを削除する
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }
  const { period, targetAmount, ownerUserId } = parsed.data;
  const existing = await prisma.goal.findFirst({
    where: { period, ownerUserId: ownerUserId ?? null },
  });
  // 0 → レコード削除（未設定に戻す）
  if (targetAmount === 0) {
    if (existing) await prisma.goal.delete({ where: { id: existing.id } });
    return NextResponse.json({ goal: null });
  }
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
