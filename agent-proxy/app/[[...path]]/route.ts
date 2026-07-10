import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  verifyGrant,
  verifySession,
} from "@/lib/session";
import { cloudRunUrl, getIdToken } from "@/lib/gcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 転送時に落とすヘッダ（ホップバイホップ + 内容エンコーディング/長さ）。
// fetch が gzip を展開済みで返すため content-encoding / content-length は付け直さない。
const STRIP_REQUEST = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
  "cookie", // プロキシ自身のセッション Cookie を Cloud Run に漏らさない
]);
const STRIP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

function unauthorizedHtml(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログインが必要です</title>
<style>body{font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
background:#f6f6f9;color:#1a1730;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border:1px solid #e7e4ee;border-radius:14px;padding:32px 36px;max-width:440px;
box-shadow:0 8px 24px rgba(30,20,60,.06);text-align:center}
h1{font-size:18px;margin:0 0 10px}p{color:#5c5670;font-size:14px;line-height:1.7;margin:0}</style></head>
<body><div class="card"><h1>ログインが必要です</h1>
<p>このエージェントは Luma からのみ開けます。<br>Luma にログインし、サイドバーの「エージェント」→「エージェントを開く」から開いてください。</p>
</div></body></html>`;
}

async function handler(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 1) グラント引き換え: Luma 署名の短命 JWT → プロキシ自身のセッション Cookie を発行
  if (pathname === "/__grant") {
    const token = url.searchParams.get("token");
    const grant = token ? await verifyGrant(token) : null;
    if (!grant) {
      return new NextResponse(unauthorizedHtml(), {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const session = await createSession(grant);
    const res = NextResponse.redirect(new URL("/", req.url));
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return res;
  }

  // 2) セッション検証（無効なら案内を返す）
  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value;
  const session = sessionToken ? await verifySession(sessionToken) : null;
  if (!session) {
    return new NextResponse(unauthorizedHtml(), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 3) 非公開 Cloud Run へ ID トークン付きで転送（SSE 等はストリーム透過）
  const target = cloudRunUrl() + pathname + url.search;

  // Cloud Run 用 ID トークンの取得（WIF/OIDC/impersonation）。失敗時は原因を返す。
  let idToken: string;
  try {
    idToken = await getIdToken();
  } catch (err) {
    console.error("getIdToken failed:", err);
    return new NextResponse(
      `認証トークンの取得に失敗しました（WIF/OIDC）: ${(err as Error).message}`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("authorization", `Bearer ${idToken}`);

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  } catch (err) {
    return new NextResponse(
      `エージェントへの接続に失敗しました: ${(err as Error).message}`,
      { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  // upstream.body（ReadableStream）をそのまま返す → SSE/長時間レスポンスをストリーム透過
  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
