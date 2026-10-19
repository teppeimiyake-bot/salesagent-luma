import { vertexGenerate } from "./vertex";
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

import { measureAiCall, type AiFeature } from "./usage";
import Anthropic from "@anthropic-ai/sdk";
import { geminiCallText } from "./gemini";
import { getHeavyTextProvider, getTextProvider, hasAnthropicKey } from "./provider";

const anthropicModel = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export function getAnthropicModelName(): string {
  return anthropicModel;
}

let anthropicClient: Anthropic | null = null;
function getAnthropicClient() {
  if (!hasAnthropicKey()) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return anthropicClient;
}

export interface CallOptions {
  feature?: AiFeature;
  system: string;
  cacheableSystem?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  tools?: Array<Record<string, unknown>>;
  /** JSON出力を強制したい場合に true。失敗時はパース前の文字列も返す */
  json?: boolean;
  /** Vertex JSON output shape; other providers still receive the prompt schema. */
  responseSchema?: Record<string, unknown>;
}

export interface CallResult {
  text: string;
  parsed?: unknown;
  usedFallback: boolean;
  usage?: Record<string, unknown>;
}

export type AnthropicCallDebug = {
  text: string | null;
  stopReason: string;
  types: string;
  textLength: number;
  turns: number;
  error?: string;
  usage?: Record<string, unknown>;
};

export type ToolsJsonCallResult<T> = {
  parsed: T | null;
  text: string | null;
  usedFallback: boolean;
  debug: AnthropicCallDebug;
};

type AnthropicMessageLoose = {
  role: "user" | "assistant";
  content: unknown;
};

export type AnthropicSystemTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export function buildSystemText(opts: Pick<CallOptions, "system" | "cacheableSystem">): string {
  const cacheable = opts.cacheableSystem?.trim();
  return cacheable ? `${cacheable}\n\n${opts.system}` : opts.system;
}

export function buildAnthropicSystemParam(
  opts: Pick<CallOptions, "system" | "cacheableSystem">,
): string | AnthropicSystemTextBlock[] {
  const cacheable = opts.cacheableSystem?.trim();
  if (!cacheable) return opts.system;
  return [
    {
      type: "text",
      text: cacheable,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: opts.system,
    },
  ];
}

export function contentBlockTypes(content: unknown): string {
  if (!Array.isArray(content)) return "empty";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && typeof block.type === "string") {
        return block.type;
      }
      return "unknown";
    })
    .join(",") || "empty";
}

export function extractAnthropicText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Keep unknown server-tool blocks intact for pause_turn continuation. */
export function cloneAnthropicContent<T>(content: T): T {
  return JSON.parse(JSON.stringify(content)) as T;
}

export function shouldContinueAnthropicTurn(stopReason: string | null | undefined): boolean {
  return stopReason === "pause_turn" || stopReason === "max_tokens";
}

export function formatAnthropicDebug(debug: AnthropicCallDebug): string {
  return [
    `stop=${debug.stopReason}`,
    `types=${debug.types || "empty"}`,
    `textLen=${debug.textLength}`,
    `turns=${debug.turns}`,
    debug.error ? `error=${debug.error}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000);
}

function anthropicUsageLog(usage: unknown): Record<string, unknown> {
  if (!usage || typeof usage !== "object") return {};
  const raw = usage as Record<string, unknown>;
  const pick = (key: string) => (typeof raw[key] === "number" ? raw[key] : undefined);
  return {
    input_tokens: pick("input_tokens"),
    output_tokens: pick("output_tokens"),
    cache_creation_input_tokens: pick("cache_creation_input_tokens"),
    cache_read_input_tokens: pick("cache_read_input_tokens"),
  };
}

function emptyDebug(error: string): AnthropicCallDebug {
  return {
    text: null,
    stopReason: "none",
    types: "",
    textLength: 0,
    turns: 0,
    error,
  };
}

async function callAnthropicWithDebug(opts: CallOptions): Promise<AnthropicCallDebug> {
  const c = getAnthropicClient();
  if (!c) return emptyDebug("no_client");
  try {
    const tools = opts.tools?.length
      ? (opts.tools as unknown as Anthropic.MessageCreateParams["tools"])
      : undefined;
    const messages: AnthropicMessageLoose[] = [{ role: "user", content: opts.user }];
    const maxTurns = tools ? 6 : 1;
    let last = emptyDebug("no_response");

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const res = await measureAiCall({ provider: "anthropic", model: anthropicModel, feature: opts.feature }, () => c.messages.create({
        model: anthropicModel,
        max_tokens: opts.maxTokens ?? 2000,
        temperature: opts.temperature ?? 0.3,
        system: buildAnthropicSystemParam(opts) as Anthropic.MessageCreateParams["system"],
        messages: messages as Anthropic.MessageParam[],
        ...(tools ? { tools } : {}),
      }), result => result.usage);
      const rawContent = cloneAnthropicContent(res.content);
      const text = extractAnthropicText(rawContent);
      const stopReason = res.stop_reason ?? "unknown";
      const types = contentBlockTypes(rawContent);
      last = {
        text: text || null,
        stopReason,
        types,
        textLength: text.length,
        turns: turn + 1,
        usage: anthropicUsageLog(res.usage),
      };
      console.warn("[anthropic] response", {
        turn,
        stopReason,
        types,
        textLength: text.length,
        usage: anthropicUsageLog(res.usage),
      });

      if (stopReason === "end_turn" || stopReason === "stop_sequence") {
        return text ? last : { ...last, error: "empty_text" };
      }
      if (shouldContinueAnthropicTurn(stopReason)) {
        messages.push({ role: "assistant", content: rawContent });
        continue;
      }
      if (stopReason === "tool_use") {
        console.error("[anthropic] client tool_use returned; server web_search did not finish", {
          types,
        });
        return { ...last, error: "client_tool_use" };
      }
      return text ? last : { ...last, error: `unexpected_stop_${stopReason}` };
    }
    return { ...last, error: last.error ?? "max_turns" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[anthropic] call failed", e);
    return emptyDebug(`exception:${message.slice(0, 300)}`);
  }
}

/** Anthropic（Claude）直叩き実装。 */
async function callAnthropic(opts: CallOptions): Promise<string | null> {
  const debug = await callAnthropicWithDebug(opts);
  return debug.text;
}

/**
 * テキスト生成。AI_PROVIDER に応じて Gemini / Anthropic を選択。
 * APIキーが無い／失敗時は null を返す。
 *
 * 関数名は歴史的事情で `callClaude` のまま（呼出側変更回避）。
 */
export async function callClaude(opts: CallOptions): Promise<string | null> {
  const provider = getTextProvider();
  if (provider === "vertex") return (await vertexGenerate({ ...opts, system: buildSystemText(opts) })).text;
  if (provider === "anthropic") {
    return callAnthropic(opts);
  }
  return geminiCallText({ ...opts, system: buildSystemText(opts) });
}

/**
 * Heavy text task router.
 *
 * AI_PROVIDER_HEAVY=anthropic sends the first attempt directly to Claude. Missing
 * keys or runtime failures fall back to Gemini so the pipeline can still finish.
 */
export async function callClaudeHeavy(opts: CallOptions): Promise<CallResult | null> {
  const provider = getHeavyTextProvider();
  if (provider === "vertex") {
    const result = await vertexGenerate({ ...opts, system: buildSystemText(opts) });
    return { ...result, usedFallback: false };
  }
  if (provider === "anthropic") {
    const debug = await callAnthropicWithDebug(opts);
    if (debug.text) return { text: debug.text, usedFallback: false, usage: debug.usage };
    const geminiText = await geminiCallText({ ...opts, system: buildSystemText(opts) });
    return geminiText ? { text: geminiText, usedFallback: true } : null;
  }

  const geminiText = await geminiCallText({ ...opts, system: buildSystemText(opts) });
  return geminiText ? { text: geminiText, usedFallback: false } : null;
}

/** JSON出力を期待してテキスト生成。タグやmarkdownを剥がしてパース。 */
export async function callClaudeJSON<T = unknown>(opts: CallOptions): Promise<T | null> {
  const text = await callClaude({ ...opts, json: true });
  if (!text) return null;
  return tryParseJSON<T>(text);
}

export async function callClaudeHeavyJSONWithTools<T = unknown>(
  opts: CallOptions & { tools: Array<Record<string, unknown>> },
): Promise<ToolsJsonCallResult<T>> {
  const provider = getHeavyTextProvider();
  if (provider !== "anthropic") {
    console.warn("[anthropic] tools call skipped; heavy provider is", provider);
    return {
      parsed: null,
      text: null,
      usedFallback: false,
      debug: emptyDebug(`provider_${provider}`),
    };
  }

  const debug = await callAnthropicWithDebug({ ...opts, json: true });
  if (!debug.text) {
    return {
      parsed: null,
      text: null,
      usedFallback: false,
      debug: { ...debug, error: debug.error ?? "empty_text" },
    };
  }
  const parsed = tryParseJSON<T>(debug.text);
  if (!parsed) {
    console.warn("[anthropic] tools call returned non-JSON text", debug.text.slice(0, 200));
    return {
      parsed: null,
      text: debug.text,
      usedFallback: false,
      debug: { ...debug, error: debug.error ?? "non_json" },
    };
  }
  return { text: debug.text, parsed, usedFallback: false, debug };
}

export async function callClaudeHeavyJSON<T = unknown>(
  opts: CallOptions,
): Promise<(CallResult & { parsed: T }) | null> {
  const provider = getHeavyTextProvider();
  if (provider === "vertex") {
    const result = await vertexGenerate({ ...opts, system: buildSystemText(opts), json: true });
    const parsed = tryParseJSON<T>(result.text);
    return parsed ? { ...result, parsed, usedFallback: false } : null;
  }
  if (provider === "anthropic") {
    const debug = await callAnthropicWithDebug({ ...opts, json: true });
    if (debug.text) {
      const parsed = tryParseJSON<T>(debug.text);
      if (parsed) return { text: debug.text, parsed, usedFallback: false, usage: debug.usage };
    }

    const geminiText = await geminiCallText({ ...opts, system: buildSystemText(opts), json: true });
    if (!geminiText) return null;
    const parsed = tryParseJSON<T>(geminiText);
    return parsed ? { text: geminiText, parsed, usedFallback: true } : null;
  }

  const geminiText = await geminiCallText({ ...opts, system: buildSystemText(opts), json: true });
  if (!geminiText) return null;
  const parsed = tryParseJSON<T>(geminiText);
  return parsed ? { text: geminiText, parsed, usedFallback: false } : null;
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
