import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { getSession } from "@/lib/auth";

// エージェント認証プロキシ（agent-proxy）へのグラント発行エンドポイント。
// ログイン済みユーザーに対して短命の署名済みグラント JWT を発行し、
// プロキシの /__grant へ 302 リダイレクトする。プロキシはこれを検証して
// 自前のセッション Cookie を発行し、以降のリクエストを非公開 Cloud Run へ転送する。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("from", "/agent");
    return NextResponse.redirect(loginUrl);
  }

  const proxyUrl = process.env.AGENT_PROXY_URL;
  const secret = process.env.AGENT_PROXY_GRANT_SECRET;
  if (!proxyUrl || !secret) {
    return new NextResponse(
      "エージェント接続が未設定です（AGENT_PROXY_URL / AGENT_PROXY_GRANT_SECRET）。",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const grant = await new SignJWT({ email: session.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(new TextEncoder().encode(secret));

  const dest = new URL("/__grant", proxyUrl);
  dest.searchParams.set("token", grant);
  return NextResponse.redirect(dest);
}
