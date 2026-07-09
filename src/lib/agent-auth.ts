import { timingSafeEqual } from "crypto";

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
  if (!m) return false;

  const provided = Buffer.from(m[1]);
  const secret = Buffer.from(expected);
  if (provided.length !== secret.length) return false;
  return timingSafeEqual(provided, secret);
}
