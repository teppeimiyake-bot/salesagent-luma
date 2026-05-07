import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";

const schema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8),
  name: z.string().optional(),
  // 招待トークン（指定時はメール固定・権限はトークン由来）
  inviteToken: z.string().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { password, inviteToken } = parsed.data;

  // ============================================================
  // 招待トークン経由（リージー版の運用：admin が発行したURL からのみ登録）
  // ============================================================
  if (inviteToken) {
    const invite = await prisma.invite.findUnique({ where: { token: inviteToken } });
    if (!invite) {
      return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
    }
    if (invite.used) {
      return NextResponse.json({ error: "Invite already used" }, { status: 410 });
    }
    if (invite.expiresAt < new Date()) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }
    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: invite.email,
        passwordHash,
        name: parsed.data.name ?? invite.name ?? invite.email.split("@")[0],
        role: invite.role,
        permission: invite.permission,
      },
    });
    await prisma.invite.update({
      where: { id: invite.id },
      data: { used: true, usedAt: new Date() },
    });
    const sessionToken = await createSessionToken({ userId: user.id, email: user.email });
    await setSessionCookie(sessionToken);
    return NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
    });
  }

  // ============================================================
  // 招待なし（直接登録）：本体プロダクトとの互換性のため残す。
  // リージー本番運用ではここは admin による無効化を推奨。
  // ============================================================
  const email = parsed.data.email;
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name: parsed.data.name ?? email.split("@")[0] },
  });
  const token = await createSessionToken({ userId: user.id, email: user.email });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
