import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-secret-change-me-please-32chars-minimum",
);
const COOKIE_NAME = "salesagent_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7日

export interface SessionPayload {
  userId: string;
  email: string;
  iat?: number;
  exp?: number;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(payload: { userId: string; email: string }) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(SECRET);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;

// ============================================================
// 権限管理（admin / user / viewer）
// ============================================================
export type Permission = "admin" | "user" | "viewer";

const PERMISSION_RANK: Record<Permission, number> = {
  viewer: 1,
  user: 2,
  admin: 3,
};

export function hasPermission(actual: string | null | undefined, required: Permission): boolean {
  const a = (actual ?? "viewer") as Permission;
  return (PERMISSION_RANK[a] ?? 0) >= PERMISSION_RANK[required];
}

/**
 * 現在のセッションユーザーの、操作中の会社での権限（UserTenant.permission）を取得する（画面・API Route の共通ヘルパー）。
 * 全社共通の User.permission ではない（会社ごとに 管理者・利用者・閲覧のみ が違う）。
 *   - runAsUserTenant 等で、同じユーザーの会社のコンテキストが張られていればそれを使う（バッチ用の system は使わない）
 *   - なければリクエスト（Cookie とセッション）から操作中の会社を決める
 *   - 全社統合ビューは閲覧のみ（書き込みは止める）
 *   - 会社が決まらない（所属が無い）とき: 移行期は全社共通の User.permission、TENANT_STRICT=1 では null
 * セッション無し or ユーザー未取得時は null。
 */
export async function getCurrentPermission(): Promise<Permission | null> {
  const session = await getSession();
  if (!session) return null;
  const { currentTenant, getRequestTenant } = await import("@/lib/tenant-context");
  const bound = currentTenant();
  const ctx = bound && bound.userId === session.userId ? bound : await getRequestTenant();
  if (ctx && ctx.userId === session.userId) {
    if (ctx.crossTenant) return "viewer";
    return (ctx.permission ?? "viewer") as Permission;
  }
  if (process.env.TENANT_STRICT === "1") return null;
  const { prisma } = await import("@/lib/db");
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (!me) return null;
  return (me.permission ?? "viewer") as Permission;
}

