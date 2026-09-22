/**
 * AI バックエンドの疎通確認エンドポイント（Vertex 移行の主検証ツール）
 *
 *   GET /api/health/ai              … 設定だけ返す（課金なし）
 *   GET /api/health/ai?live=1       … 実際に1回だけ呼ぶ（maxTokens=16、ごく少額）
 *
 * 認証: `Authorization: Bearer <AI_DEBUG_TOKEN>`
 * AI_DEBUG_TOKEN 未設定なら常に 401（誤って全開放しないための安全側）。
 *
 * `oidcSub` は Workload Identity Federation のバインドを実値で確定させるために返す。
 * Preview デプロイでこれを見てから
 *   principal://iam.googleapis.com/projects/<N>/locations/global/workloadIdentityPools/<POOL>/subject/<sub>
 * を serviceAccountTokenCreator に紐づける。
 *
 * **APIキーやトークンそのものは絶対に返さない。**
 */

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { tryParseJSON } from "@/lib/ai/anthropic";
import { geminiCallText } from "@/lib/ai/gemini";
import { peekOidcSubject, vertexAuthMode } from "@/lib/ai/google-auth";
import {
  getGeminiModels,
  getGoogleBackend,
  getTextProvider,
  getTranscribeBackend,
  getVertexConfig,
  hasGeminiKey,
  isFailFast,
} from "@/lib/ai/provider";

export const runtime = "nodejs";
export const maxDuration = 30;

function isAuthorized(req: Request): boolean {
  const expected = process.env.AI_DEBUG_TOKEN;
  if (!expected) return false;
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const secret = Buffer.from(expected);
  if (provided.length !== secret.length) return false;
  return timingSafeEqual(provided, secret);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const backend = getGoogleBackend();
  const body: Record<string, unknown> = {
    provider: getTextProvider(),
    backend,
    transcribeBackend: getTranscribeBackend(),
    configured: hasGeminiKey(),
    failFast: isFailFast(),
    models: getGeminiModels(),
    authMode: backend === "vertex" ? vertexAuthMode() : "api-key",
    oidcSub: peekOidcSubject(),
    vertex: backend === "vertex" ? getVertexConfig() : null,
  };

  if (new URL(req.url).searchParams.get("live") === "1") {
    const started = Date.now();
    try {
      const text = await geminiCallText({
        system: "You are a health check. Reply with exactly: ok",
        user: "ping",
        maxTokens: 16,
        temperature: 0,
      });
      body.live = {
        ok: text !== null,
        latencyMs: Date.now() - started,
        text: text?.slice(0, 40) ?? null,
      };
    } catch (e) {
      body.live = {
        ok: false,
        latencyMs: Date.now() - started,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      };
    }

    // JSON モードの疎通も見る。
    // 7段推論・BANT・事前準備など主要機能はすべて callClaudeJSON 経由なので、
    // ここが通るかどうかがそれらの代理指標になる。providerOptions のキー名が
    // バックエンドで違う可能性があり、外すと JSON パースが崩れて全機能が
    // 静かにフォールバックへ落ちる。
    const jsonStarted = Date.now();
    try {
      const raw = await geminiCallText({
        system:
          'Reply with a JSON object only. Schema: {"status":"ok","n":1}. No prose, no code fence.',
        user: "health check",
        maxTokens: 64,
        temperature: 0,
        json: true,
      });
      const parsed = raw ? tryParseJSON<{ status?: string }>(raw) : null;
      body.liveJson = {
        ok: parsed?.status === "ok",
        latencyMs: Date.now() - jsonStarted,
        parsed: parsed !== null,
        raw: raw?.slice(0, 80) ?? null,
      };
    } catch (e) {
      body.liveJson = {
        ok: false,
        latencyMs: Date.now() - jsonStarted,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      };
    }
  }

  return NextResponse.json(body);
}
