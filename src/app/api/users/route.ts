import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hashPassword } from "@/lib/auth";
import { normalizeEmail } from "@/lib/email";
import { listCurrentTenantUsers, requireUserAdmin, TenantUserScopeError } from "@/lib/tenant-users";

// 操作中の会社に所属するユーザーだけを返す（ほかの会社のユーザーの名前・メールは返さない）
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    // 権限・役職は、この会社での値（担当者の候補から閲覧のみの人を外すのにも使う）
    const users = await listCurrentTenantUsers(
      { id: true, name: true, email: true, role: true, permission: true, avatarColor: true },
      {},
      { tenantRoles: true },
    );
    return NextResponse.json({ users });
  } catch (e) {
    if (e instanceof TenantUserScopeError) {
      return NextResponse.json({ error: "操作中の会社を確認できませんでした。再読み込みしてください。" }, { status: 403 });
    }
    throw e;
  }
}

const AVATAR_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#f59e0b",
  "#10b981", "#06b6d4", "#3b82f6", "#ef4444",
];

const createSchema = z.object({
  // 保存形＝照合形。ログイン時の normalizeEmail と必ず同じ形に揃える。
  email: z.string().transform(normalizeEmail).pipe(z.string().email()),
  name: z.string().min(1),
  role: z.enum(["sales", "manager"]).default("sales"),
  permission: z.enum(["admin", "user", "viewer"]).default("user"),
  password: z.string().min(8).optional(),
});

export async function POST(req: Request) {
  // メンバー追加は、操作中の会社の管理者のみ。追加したユーザーは操作中の会社に所属させる
  // （所属が無いと、会社ごとのユーザー一覧に出ない）
  const scope = await requireUserAdmin();
  if ("error" in scope) return NextResponse.json({ error: scope.error }, { status: scope.status });
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

  // ユーザーと所属は同時に作る（片方だけ出来ると壊れたアカウントになる）。
  // user_tenants を作らないと、そのユーザーはログインできても所属会社が無く TENANT_STRICT=1 の本番では全ページが例外で落ちる。
  const user = await prisma.user.create({
    data: {
      email, name, role, permission, passwordHash, avatarColor,
      userTenants: { create: { tenantId: scope.tenantId, permission, role, isDefault: true } },
    },
    select: { id: true, name: true, email: true, role: true, permission: true, avatarColor: true },
  });
  return NextResponse.json({ user, initialPassword: parsed.data.password ? undefined : password });
}
