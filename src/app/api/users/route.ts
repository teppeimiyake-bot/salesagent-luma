import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, hashPassword } from "@/lib/auth";

export async function GET() {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, permission: true, avatarColor: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ users });
}

const AVATAR_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
  "#10b981", "#06b6d4", "#3b82f6", "#ef4444",
];

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["sales", "manager"]).default("sales"),
  permission: z.enum(["admin", "user", "viewer"]).default("user"),
  password: z.string().min(8).optional(),
});

export async function POST(req: Request) {
  // メンバー追加は admin のみ
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { permission: true } });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { email, name, role, permission } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }
  // パスワード未指定なら初期パスワード demo1234（管理者が後で変更可）
  const password = parsed.data.password ?? "demo1234";
  const passwordHash = await hashPassword(password);
  const avatarColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];

  const user = await prisma.user.create({
    data: { email, name, role, permission, passwordHash, avatarColor },
    select: { id: true, name: true, email: true, role: true, permission: true, avatarColor: true },
  });
  return NextResponse.json({ user, initialPassword: parsed.data.password ? undefined : password });
}
