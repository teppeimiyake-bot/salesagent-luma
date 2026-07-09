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
    isPublicInviteToken(pathname);
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
