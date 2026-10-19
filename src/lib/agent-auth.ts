import { timingSafeEqual } from "crypto";

function safeEqualString(providedValue: string | null | undefined, expectedValue: string): boolean {
  if (!providedValue) return false;
  const provided = Buffer.from(providedValue);
  const expected = Buffer.from(expectedValue);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * 外部エージェント（Cloud Run）からの `/api/agents/*` 呼び出しをトークン認証する。
 *
 * middleware は `/api/agents/*` を cookie ゲートからバイパスさせるので、
 * 認証はこのヘルパを使って各ルート内（Node runtime）で行う。
 * ヘッダ `Authorization: Bearer <AGENT_INGEST_TOKEN>` を timingSafeEqual で比較。
 *
 * AGENT_INGEST_TOKEN 未設定時は常に false（誤って全開放しないための安全側）。
 */
export function isValidAgentToken(req: Request): boolean {
  const expected = process.env.AGENT_INGEST_TOKEN;
  if (!expected) return false;

  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return safeEqualString(m?.[1], expected);
}

export function isValidCronSecret(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    safeEqualString(bearer, expected) ||
    safeEqualString(req.headers.get("x-cron-secret"), expected) ||
    safeEqualString(req.headers.get("x-vercel-cron"), expected)
  );
}
