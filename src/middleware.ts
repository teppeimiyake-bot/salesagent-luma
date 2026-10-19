import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "dev-secret-change-me-please-32chars-minimum",
);
const COOKIE_NAME = "salesagent_session";

// /api/auth/* は NextAuth の OAuth コールバック等を含むため public 扱い
//   - NextAuth: /api/auth/signin, /api/auth/callback/*, /api/auth/session, /api/auth/csrf, /api/auth/providers, /api/auth/error
//   - 既存自前: /api/auth/login, /api/auth/logout, /api/auth/register
//   - ただし /api/auth/avatar と /api/auth/password はログイン後のユーザ操作 → 個別ガード
const PUBLIC_PATHS = ["/login", "/register"];

function isPublicAuthPath(pathname: string) {
  if (!pathname.startsWith("/api/auth/")) return false;
  // 認証必須にしたいパスは個別に弾く
  if (pathname.startsWith("/api/auth/avatar")) return false;
  if (pathname.startsWith("/api/auth/password")) return false;
  return true;
}

// 個別パス判定（startsWithだとベース/api/invitesも通ってしまうので分離）
function isPublicInviteToken(pathname: string) {
  // /api/invites/<token> （末尾セグメントが残るケースのみ公開、ベース /api/invites は admin 認証）
  return /^\/api\/invites\/[^/]+\/?$/.test(pathname);
}

// /api/agents/* は外部エージェント(Cloud Run)用。cookie セッションを持たないため
// middleware の cookie ゲートはバイパスし、トークン認証は各ルート内で行う
// （middleware は Edge runtime なので Prisma/crypto を持ち込まない）。
function isAgentIngestPath(pathname: string) {
  return /^\/api\/agents(\/|$)/.test(pathname);
}

// /api/health/* は運用監視用。cookie セッションを持たない経路から叩くため
// middleware のゲートはバイパスし、認証は各ルート内で Bearer トークンで行う
// (/api/health/ai は AI_DEBUG_TOKEN を timingSafeEqual で検証する。
//  トークン未設定なら常に 401 なので、バイパスしても全開放にはならない)。
function isHealthPath(pathname: string) {
  return /^\/api\/health(\/|$)/.test(pathname);
}

// /api/cron/* は Vercel Cron 用。cookie セッションを持たないため middleware の
// cookie ゲートはバイパスし、CRON_SECRET 認証は各ルート内で行う。
function isCronPath(pathname: string) {
  return /^\/api\/cron(\/|$)/.test(pathname);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 静的ファイル・Next内部はスルー
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/public") ||
    pathname.startsWith("/uploads")
  ) {
    return NextResponse.next();
  }

  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    isPublicAuthPath(pathname) ||
    isPublicInviteToken(pathname) ||
    isAgentIngestPath(pathname) ||
    isHealthPath(pathname) ||
    isCronPath(pathname);
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const isAuthed = token ? await isValidToken(token) : false;

  // 認証済みユーザーがログイン画面に来たらダッシュボードへ
  if (isAuthed && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (isPublic) return NextResponse.next();

  if (!isAuthed) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

async function isValidToken(token: string) {
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export const config = {
  // /api/meetings と /api/documents（どちらもちょうどこのパス）は大容量 multipart のため除外する。
  // middleware/proxy はボディをメモリに複製し、既定の上限（10MB）で切るため、52分級の mp4 や
  // 10MB を超える資料で formData 解析が壊れる。認証は route handler 側（GET/POST とも getSession）で行い、
  // テナントは route 内の Prisma Extension が Cookie とセッションから決める（middleware では見ていない）。
  // /api/documents/[id] などの下位のパスは対象のまま。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/meetings$|api/documents$).*)"],
};
