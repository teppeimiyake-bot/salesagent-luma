import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// グラント（Luma が発行する短命 JWT）の検証と、
// プロキシ自身のセッション Cookie（このプロキシが発行する JWT）の署名/検証。
// 2つは別の秘密鍵を使う（グラント=Lumaと共有 / セッション=プロキシ単独）。

export const SESSION_COOKIE = "agent_proxy_session";
const SESSION_MAX_AGE = 60 * 60 * 8; // 8時間

function grantSecret(): Uint8Array {
  const s = process.env.AGENT_PROXY_GRANT_SECRET;
  if (!s) throw new Error("AGENT_PROXY_GRANT_SECRET が未設定です");
  return new TextEncoder().encode(s);
}

function sessionSecret(): Uint8Array {
  const s = process.env.AGENT_PROXY_SESSION_SECRET;
  if (!s) throw new Error("AGENT_PROXY_SESSION_SECRET が未設定です");
  return new TextEncoder().encode(s);
}

export interface Principal {
  sub: string;
  email: string;
}

/** Luma が署名したグラント JWT を検証。妥当なら principal を返す。 */
export async function verifyGrant(token: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, grantSecret());
    return principalFrom(payload);
  } catch {
    return null;
  }
}

/** プロキシ自身のセッション JWT を発行。 */
export async function createSession(p: Principal): Promise<string> {
  return await new SignJWT({ sub: p.sub, email: p.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionSecret());
}

/** プロキシのセッション Cookie を検証。 */
export async function verifySession(token: string): Promise<Principal | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    return principalFrom(payload);
  } catch {
    return null;
  }
}

function principalFrom(payload: JWTPayload): Principal | null {
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub) return null;
  return { sub, email };
}

export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE;
