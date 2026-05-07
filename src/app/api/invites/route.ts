import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

async function requireAdmin() {
  const session = await getSession();
  if (!session) return null;
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, permission: true },
  });
  if (!hasPermission(me?.permission, "admin")) return null;
  return me;
}

export async function GET() {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ invites });
}

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  role: z.enum(["sales", "manager"]).default("sales"),
  permission: z.enum(["admin", "user", "viewer"]).default("user"),
  // 期限（時間）。デフォルト168時間=7日
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
});

export async function POST(req: Request) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { email, name, role, permission } = parsed.data;
  const hours = parsed.data.expiresInHours ?? 168;

  // 既存ユーザーチェック
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  // 既に有効な招待がある場合は再生成（古いものは used 扱いに）
  await prisma.invite.updateMany({
    where: { email, used: false, expiresAt: { gt: new Date() } },
    data: { used: true, usedAt: new Date() },
  });

  const token = randomBytes(24).toString("base64url");
  const invite = await prisma.invite.create({
    data: {
      email,
      name,
      role,
      permission,
      token,
      invitedById: me.id,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    },
  });
  return NextResponse.json({ invite });
}

export async function DELETE(req: Request) {
  const me = await requireAdmin();
  if (!me) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.invite.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
