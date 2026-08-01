import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ACTIVE_TENANT_COOKIE, ALL_TENANTS } from "@/lib/tenant-context";

/**
 * 会社タブの切り替え（Luma / リージー / 全社）
 * ------------------------------------------------------------
 * Cookie に選択中のテナントコードを保存する。以降のリクエストは
 * src/lib/tenant-context.ts がこの Cookie を読んでスコープを決める。
 *
 * Cookie はクライアントから書き換えられるため、値を信用せず必ず所属を検証する。
 * （検証は保存時だけでなく resolveTenantContext() 側でも毎回行う二段構え）
 */
const schema = z.object({ code: z.string().min(1).max(64) });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { code } = parsed.data;

  if (code === ALL_TENANTS) {
    // 全社ビューは cross_tenant_read を持つユーザーのみ
    const allowed = await prisma.userTenant.findFirst({
      where: { userId: session.userId, crossTenantRead: true },
      select: { id: true },
    });
    if (!allowed) {
      return NextResponse.json({ error: "全社ビューの閲覧権限がありません" }, { status: 403 });
    }
  } else {
    const membership = await prisma.userTenant.findFirst({
      where: { userId: session.userId, tenant: { code, active: true } },
      select: { id: true },
    });
    if (!membership) {
      return NextResponse.json({ error: "この会社に所属していません" }, { status: 403 });
    }
  }

  const res = NextResponse.json({ ok: true, code });
  res.cookies.set(ACTIVE_TENANT_COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
