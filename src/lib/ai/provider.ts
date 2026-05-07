/**
 * AIプロバイダ抽象レイヤ
 *
 * AI_PROVIDER 環境変数で動的切替：
 *   - "gemini"（デフォルト・推奨）：Vercel AI SDK + @ai-sdk/google
 *   - "anthropic"（フォールバック）：Anthropic SDK 直叩き（旧実装）
 *
 * 呼出側は `callClaude` / `callClaudeJSON` / `transcribeFile` / `embed`
 * という旧来の関数名のまま使い続ける（diffを最小化し本体・リージー版との
 * マージコストを抑える）。本ファイルは内部の振り分け先を決めるだけ。
 */

export type AiProvider = "gemini" | "anthropic";

/**
 * 現在のテキスト生成プロバイダを返す。
 * AI_PROVIDER が未設定／不正値ならデフォルトの "gemini"。
 */
export function getTextProvider(): AiProvider {
  const v = (process.env.AI_PROVIDER ?? "").toLowerCase();
  if (v === "anthropic") return "anthropic";
  return "gemini";
}

/**
 * Geminiの主要モデル名を環境変数から解決。
 * - GEMINI_MODEL_DEFAULT: 通常タスク（チャット・7段推論）。デフォルト gemini-2.5-flash
 * - GEMINI_MODEL_HEAVY:   高品質タスク（STEP3/STEP7 など、明示指定時のみ）。デフォルト gemini-2.5-pro
 * - GEMINI_MODEL_TRANSCRIBE: 音声→テキスト。デフォルト gemini-2.5-flash
 * - GEMINI_MODEL_EMBED:   埋め込み。デフォルト text-embedding-004
 */
export function getGeminiModels() {
  return {
    default: process.env.GEMINI_MODEL_DEFAULT ?? "gemini-2.5-flash",
    heavy: process.env.GEMINI_MODEL_HEAVY ?? "gemini-2.5-pro",
    transcribe: process.env.GEMINI_MODEL_TRANSCRIBE ?? "gemini-2.5-flash",
    embed: process.env.GEMINI_MODEL_EMBED ?? "text-embedding-004",
  };
}

/** Geminiが利用可能か（APIキーが設定されているか）。 */
export function hasGeminiKey(): boolean {
  return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

/** Anthropicが利用可能か（APIキーが設定されているか）。 */
export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/** OpenAIが利用可能か（APIキーが設定されているか・フォールバック用）。 */
export function hasOpenAiKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * 現在のテキスト生成プロバイダで実際にAIを呼べる状態か。
 * （APIキーが入っていれば true、未設定なら false）
 *
 * 旧コードで `process.env.ANTHROPIC_API_KEY` を直接見ていた箇所は
 * これに置き換える（プロバイダ切替に追従できる）。
 */
export function hasAiTextKey(): boolean {
  const provider = getTextProvider();
  if (provider === "anthropic") return hasAnthropicKey();
  return hasGeminiKey();
}
