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
  // Vertex では VERTEX_MODEL_* が優先。未設定なら GEMINI_MODEL_* を継承する。
  // A/B 比較で別モデルを当てられるように分けてある。
  const vertex = getGoogleBackend() === "vertex";
  const pick = (vertexKey: string, sharedKey: string, fallback: string) =>
    (vertex ? process.env[vertexKey] : undefined) ?? process.env[sharedKey] ?? fallback;

  return {
    default: pick("VERTEX_MODEL_DEFAULT", "GEMINI_MODEL_DEFAULT", "gemini-2.5-flash"),
    heavy: pick("VERTEX_MODEL_HEAVY", "GEMINI_MODEL_HEAVY", "gemini-2.5-pro"),
    transcribe: pick("VERTEX_MODEL_TRANSCRIBE", "GEMINI_MODEL_TRANSCRIBE", "gemini-2.5-flash"),
    embed: pick("VERTEX_MODEL_EMBED", "GEMINI_MODEL_EMBED", "text-embedding-004"),
  };
}

export type GoogleBackend = "aistudio" | "vertex";

/**
 * Google 系モデルのバックエンド。
 * - "aistudio"（既定）: Gemini API。APIキー認証。月間上限に当たると止まる
 * - "vertex": Vertex AI。SA/IAM 認証、課金は GCP 請求に統合、モデル版を固定できる
 *
 * 単価そのものは両者で同一。切り替えの目的は「止まらず・測れる」状態にすること。
 */
export function getGoogleBackend(): GoogleBackend {
  return (process.env.GOOGLE_AI_BACKEND ?? "").toLowerCase() === "vertex"
    ? "vertex"
    : "aistudio";
}

/**
 * 音声書き起こしのバックエンド。未設定ならテキストと同じ。
 * テキストが安定してから音声を移せるように別軸にしてある。
 */
export function getTranscribeBackend(): GoogleBackend {
  const v = (process.env.AI_TRANSCRIBE_BACKEND ?? "").toLowerCase();
  if (v === "vertex") return "vertex";
  if (v === "aistudio") return "aistudio";
  return getGoogleBackend();
}

/** Vertex AI の接続設定。 */
export function getVertexConfig() {
  return {
    project: process.env.GCP_PROJECT_ID ?? "",
    location: process.env.VERTEX_LOCATION ?? "asia-northeast1",
  };
}

/**
 * Vertex を呼ぶ設定が揃っているか。
 *
 * 注意: 「設定が揃っている」と「認証が通る」は別物。ここは env の有無しか見られない。
 * 実際の疎通確認は /api/health/ai?live=1 が担う。
 */
export function hasVertexConfig(): boolean {
  return !!getVertexConfig().project;
}

/**
 * 失敗時に決定論フォールバックへ落ちず、例外を投げるか。
 *
 * 本システムは全 AI 機能にフォールバックが入っており、認証がコケても
 * エラーにならず劣化出力が保存される。移行検証中はこれを 1 にして、
 * 失敗を失敗として見えるようにする。
 */
export function isFailFast(): boolean {
  return process.env.AI_FAIL_FAST === "1";
}

/**
 * 現在のバックエンドで Gemini 系モデルを呼べる状態か。
 *
 * 名前は歴史的経緯で hasGeminiKey のままだが、判定内容は
 * 「APIキーがあるか」ではなく「現バックエンドで呼べる設定が揃っているか」。
 * Vertex ではキーを使わないため、キー有無で判定すると全機能が静かに
 * フォールバックへ落ちる（移行失敗に気づけない）。
 */
export function hasGeminiKey(): boolean {
  if (getGoogleBackend() === "vertex") return hasVertexConfig();
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
