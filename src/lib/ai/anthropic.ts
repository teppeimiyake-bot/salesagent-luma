/**
 * AIテキスト生成ラッパ（プロバイダ抽象）
 *
 * **歴史的事情で関数名は callClaude のまま**。実体は AI_PROVIDER に応じて
 * Gemini / Anthropic を振り分ける。呼出側コードを変更せずに済むように
 * 同名・同シグネチャを厳守する（本体・リージー版とのマージコスト最小化）。
 *
 * - AI_PROVIDER=gemini（デフォルト）: Vercel AI SDK + Google Gemini
 * - AI_PROVIDER=anthropic:           Anthropic SDK 直叩き（旧実装・フォールバック）
 *
 * APIキーが無い／呼び出し失敗時は null を返す。呼出側は決定論的フォールバックで完走。
 */

import Anthropic from "@anthropic-ai/sdk";
import { geminiCallText } from "./gemini";
import { getTextProvider, hasAnthropicKey } from "./provider";

const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

let anthropicClient: Anthropic | null = null;
function getAnthropicClient() {
  if (!hasAnthropicKey()) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return anthropicClient;
}

export interface CallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** JSON出力を強制したい場合に true。失敗時はパース前の文字列も返す */
  json?: boolean;
}

export interface CallResult {
  text: string;
  parsed?: unknown;
  usedFallback: boolean;
}

/** Anthropic（Claude）直叩き実装。 */
async function callAnthropic(opts: CallOptions): Promise<string | null> {
  const c = getAnthropicClient();
  if (!c) return null;
  try {
    const res = await c.messages.create({
      model: anthropicModel,
      max_tokens: opts.maxTokens ?? 2000,
      temperature: opts.temperature ?? 0.3,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n");
    return text;
  } catch (e) {
    console.error("[anthropic] call failed", e);
    return null;
  }
}

/**
 * テキスト生成。AI_PROVIDER に応じて Gemini / Anthropic を選択。
 * APIキーが無い／失敗時は null を返す。
 *
 * 関数名は歴史的事情で `callClaude` のまま（呼出側変更回避）。
 */
export async function callClaude(opts: CallOptions): Promise<string | null> {
  const provider = getTextProvider();
  if (provider === "anthropic") {
    return callAnthropic(opts);
  }
  return geminiCallText(opts);
}

/** JSON出力を期待してテキスト生成。タグやmarkdownを剥がしてパース。 */
export async function callClaudeJSON<T = unknown>(opts: CallOptions): Promise<T | null> {
  const text = await callClaude({ ...opts, json: true });
  if (!text) return null;
  return tryParseJSON<T>(text);
}

/**
 * テキストからJSONを抽出してパース。
 * - ```json ... ``` フェンス対応
 * - 最初の `{` 〜 最後の `}` を切り出してパース
 * 失敗時は null。
 *
 * Geminiの `responseMimeType: application/json` 指定でも、稀に説明文が混じる
 * モデル挙動が報告されているため、従来の保険ロジックは引き続き有効。
 */
export function tryParseJSON<T = unknown>(text: string): T | null {
  // ```json ... ``` ブロック
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  // 最初の { ... 最後の } を切り出し
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  const sliced = first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
  try {
    return JSON.parse(sliced) as T;
  } catch {
    return null;
  }
}
