import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { getSession } from "@/lib/auth";

// エージェント（Cloud Run sales-agent）への server-to-server ゲートウェイ。
// ブラウザ → Luma(/api/agent/gw/...) → agent-proxy(x-agent-grant 認証) → Cloud Run。
// iframe やサードパーティ Cookie に依存せず、Luma のログインセッションだけで
// エージェント API（run 開始 / SSE ログ / 履歴）を叩けるようにする。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // SSE ストリームの長時間接続に対応

// 転送を許可するエージェント API のホワイトリスト（method + パス正規表現）。
// STEP4 の submit 系（実フォーム送信）は UI から誤爆しないよう通さない。
const ALLOW: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^api\/config$/ },
  { method: "GET", pattern: /^api\/sources$/ },
  { method: "GET", pattern: /^api\/source-states$/ },
  { method: "POST", pattern: /^api\/runs$/ },
  { method: "GET", pattern: /^api\/runs\/[a-f0-9]+$/ },
  { method: "GET", pattern: /^api\/runs\/[a-f0-9]+\/stream$/ },
  { method: "GET", pattern: /^api\/runs\/[a-f0-9]+\/results$/ },
  { method: "GET", pattern: /^api\/history$/ },
  { method: "GET", pattern: /^api\/history\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[\w.-]+$/ },
];

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const proxyUrl = process.env.AGENT_PROXY_URL;
  const secret = process.env.AGENT_PROXY_GRANT_SECRET;
  if (!proxyUrl || !secret) {
    return NextResponse.json(
      { error: "エージェント接続が未設定です（AGENT_PROXY_URL / AGENT_PROXY_GRANT_SECRET）" },
      { status: 503 },
    );
  }

  const { path } = await params;
  const upstreamPath = path.join("/");
  const method = req.method.toUpperCase();
  const allowed = ALLOW.some(
    (r) => r.method === method && r.pattern.test(upstreamPath),
  );
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden path" }, { status: 403 });
  }

  // リクエスト毎の短命グラント（agent-proxy が x-agent-grant として検証）
  const grant = await new SignJWT({ email: session.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));

  const url = new URL(req.url);
  const target = new URL(`/${upstreamPath}${url.search}`, proxyUrl);

  const headers = new Headers();
  headers.set("x-agent-grant", grant);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual",
      // @ts-expect-error Node fetch 拡張（Next.js ランタイムで有効）
      duplex: hasBody ? "half" : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `エージェントへの接続に失敗しました: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const respHeaders = new Headers();
  const passHeaders = ["content-type", "cache-control", "x-accel-buffering"];
  for (const key of passHeaders) {
    const v = upstream.headers.get(key);
    if (v) respHeaders.set(key, v);
  }

  // SSE を含むレスポンスボディはストリーム透過
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export { handler as GET, handler as POST };
