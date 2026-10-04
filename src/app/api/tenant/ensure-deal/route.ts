import { NextResponse } from "next/server";
import { prismaUnscoped } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ACTIVE_TENANT_COOKIE } from "@/lib/tenant-context";

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/deals";
  return value;
}

/**
 * 別会社の商談への直リンクを開いたとき、所属を検証して表示会社を自動切替する。
 * エージェント・検索結果・共有URLなど、企業詳細以外の導線でも 404 にしないための経路。
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    const login = new URL("/login", req.url);
    login.searchParams.set("from", "/deals");
    return NextResponse.redirect(login);
  }

  const url = new URL(req.url);
  const dealId = url.searchParams.get("dealId");
  const nextPath = safeNextPath(url.searchParams.get("next"));
  if (!dealId) return NextResponse.redirect(new URL("/deals", req.url));

  const deal = await prismaUnscoped.deal.findFirst({
    where: { id: dealId, deletedAt: null },
    select: { tenantId: true },
  });
  if (!deal) return NextResponse.redirect(new URL("/deals", req.url));

  const membership = await prismaUnscoped.userTenant.findFirst({
    where: {
      userId: session.userId,
      tenantId: deal.tenantId,
      tenant: { active: true },
    },
    select: { tenant: { select: { code: true } } },
  });
  if (!membership) return NextResponse.redirect(new URL("/deals", req.url));

  const res = NextResponse.redirect(new URL(nextPath, req.url));
  res.cookies.set(ACTIVE_TENANT_COOKIE, membership.tenant.code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
