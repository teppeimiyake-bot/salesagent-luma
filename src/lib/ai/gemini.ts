/**
 * Gemini 実装層（Vercel AI SDK 経由）
 *
 * - テキスト生成：`generateText` を使い、systemInstruction＋userプロンプトを送る
 * - JSON生成：JSONモード（responseFormat: { type: "json" }）で返却
 * - 音声書き起こし：`@google/generative-ai` 直叩きで Files API を使う
 *   （AI SDKでもファイル添付は可能だが、音声は直叩きの方がシンプル）
 * - 埋め込み：`@google/generative-ai` の embedContent
 *
 * APIキー（GOOGLE_GENERATIVE_AI_API_KEY）が無い場合は null を返す。
 * 呼出側はフォールバック挙動を続行できる。
 */

import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs";
import path from "node:path";
import {
  getGeminiModels,
  getGoogleBackend,
  getTranscribeBackend,
  getVertexConfig,
  hasGeminiKey,
  isFailFast,
} from "./provider";
import { getGoogleAccessToken } from "./google-auth";

// ============================================================
// バックエンド切替（AI Studio / Vertex AI）
//
// Vertex の publishers/google/models/<m>:generateContent は Developer API と
// リクエスト/レスポンス形状が同じなので、@ai-sdk/google の provider を
// Vertex の baseURL に向け、custom fetch で Authorization を付ければ動く。
// 専用 provider (@ai-sdk/google-vertex) を足さずに済み、認証クライアントの
// 受け渡し方に依存しないのでこちらを本線にしている。
// ============================================================

type Provider = ReturnType<typeof createGoogleGenerativeAI>;
let _providerCache: { key: string; provider: Provider } | null = null;

function buildProvider(): Provider {
  if (getGoogleBackend() === "vertex") {
    const { project, location } = getVertexConfig();
    if (!project) throw new Error("GCP_PROJECT_ID が未設定です (GOOGLE_AI_BACKEND=vertex)");
    const host =
      location === "global"
        ? "https://aiplatform.googleapis.com"
        : `https://${location}-aiplatform.googleapis.com`;
    return createGoogleGenerativeAI({
      apiKey: "unused-on-vertex",
      baseURL: `${host}/v1/projects/${project}/locations/${location}/publishers/google`,
      fetch: async (input, init) => {
        const token = await getGoogleAccessToken();
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        // APIキー用ヘッダが混ざると Vertex 側で弾かれることがあるので落とす
        headers.delete("x-goog-api-key");
        return fetch(input, { ...init, headers });
      },
    });
  }
  // AI Studio: apiKey を明示的に渡す。
  // 旧実装の `google(...)` は env を暗黙に読んでいたため、Vertex へ切り替えたつもりでも
  // 旧経路のまま動いてしまう事故を作りやすかった。
  return createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "",
  });
}

function getProvider(): Provider {
  const { project, location } = getVertexConfig();
  const key = `${getGoogleBackend()}:${project}:${location}`;
  if (!_providerCache || _providerCache.key !== key) {
    _providerCache = { key, provider: buildProvider() };
  }
  return _providerCache.provider;
}

/** テスト用: provider キャッシュを捨てる。 */
export function resetProviderCache(): void {
  _providerCache = null;
}

export interface GeminiCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** JSON出力を強制したい場合 true（responseFormat: json） */
  json?: boolean;
  /** モデル明示指定（未指定時は GEMINI_MODEL_DEFAULT） */
  modelOverride?: string;
}

/** Geminiでテキスト生成（失敗時 null）。 */
export async function geminiCallText(opts: GeminiCallOptions): Promise<string | null> {
  const backend = getGoogleBackend();
  if (!hasGeminiKey()) {
    console.warn(`[ai-fallback] site=geminiCallText backend=${backend} reason=not-configured`);
    if (isFailFast()) throw new Error(`AI backend ${backend} が未設定です`);
    return null;
  }
  const models = getGeminiModels();
  const modelName = opts.modelOverride ?? models.default;
  try {
    const result = await generateText({
      model: getProvider()(modelName),
      system: opts.system,
      prompt: opts.user,
      temperature: opts.temperature ?? 0.3,
      // AI SDK v6: maxOutputTokens が標準
      maxOutputTokens: opts.maxTokens ?? 2000,
      // JSONモード: responseFormat で json を指定
      // provider キー名はバックエンドで変わりうる。AI SDK は未知のキーを無視するので
      // 両方入れておけばどちらが正解でも動く。
      ...(opts.json
        ? {
            providerOptions: {
              google: { responseMimeType: "application/json" },
              vertex: { responseMimeType: "application/json" },
            },
          }
        : {}),
    });
    return result.text;
  } catch (e) {
    console.error(
      `[ai-fallback] site=geminiCallText backend=${backend} model=${modelName} err=`,
      e,
    );
    if (isFailFast()) throw e;
    return null;
  }
}

// ============================================================
// 音声書き起こし（Whisper代替）
// Files API で音声をアップロード→generateContentで文字起こしを依頼
// 対応: WebM / MP3 / WAV / AIFF / AAC / OGG / FLAC
// ============================================================

let _genAI: GoogleGenerativeAI | null = null;

/**
 * legacy SDK (@google/generative-ai) のクライアント。**AI Studio 専用**。
 *
 * 音声書き起こしと埋め込みだけがこれを使う。テキスト生成は AI SDK 経由で
 * バックエンドを切り替えるため、ここは通らない。
 * Vertex への移行はテキストが安定してから AI_TRANSCRIBE_BACKEND で行う。
 */
function getGenAI(): GoogleGenerativeAI | null {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) return null;
  if (!_genAI) {
    _genAI = new GoogleGenerativeAI(key);
  }
  return _genAI;
}

/**
 * 音声が inlineData の上限を超えた。
 *
 * null を返すと呼出側がダミー文字列に置き換えて UI 上は成功に見えるため、
 * 例外にして「失敗した」と分かるようにする。恒久対応 (Files API / GCS) は T20。
 */
export class TranscriptionTooLargeError extends Error {
  constructor(public readonly sizeMB: number) {
    super(`音声ファイルが大きすぎます (${sizeMB.toFixed(1)}MB)`);
    this.name = "TranscriptionTooLargeError";
  }
}

/** 拡張子からMIMEタイプを推定（音声ファイル用）。 */
function guessAudioMime(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    webm: "audio/webm",
    mp3: "audio/mp3",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aiff: "audio/aiff",
  };
  return map[ext] ?? "audio/webm";
}

/**
 * Geminiで音声ファイルを書き起こし。失敗時 null。
 *
 * 戦略：ファイルサイズが小さい（〜20MB目安）ものは inlineData（base64直送）、
 * 大きいものは Files API でアップロードしてから generateContent。
 * MVPでは inlineData のみサポート（Lumaの想定30分商談≒10MB ≒ b64で13MB）。
 */
export async function geminiTranscribe(filepath: string): Promise<string | null> {
  if (getTranscribeBackend() === "vertex") {
    // 音声はまだ Vertex 経路を実装していない。黙って劣化させず、理由を残して落とす。
    console.warn(
      "[ai-fallback] site=geminiTranscribe backend=vertex reason=not-implemented " +
        "(AI_TRANSCRIBE_BACKEND=aistudio にするか、Vertex 音声対応を実装すること)",
    );
    if (isFailFast()) throw new Error("音声書き起こしの Vertex 経路は未実装です");
    return null;
  }
  const genAI = getGenAI();
  if (!genAI) {
    console.warn("[ai-fallback] site=geminiTranscribe reason=no-api-key");
    if (isFailFast()) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY が未設定です");
    return null;
  }
  const models = getGeminiModels();
  try {
    const buf = await fs.promises.readFile(filepath);
    const sizeMB = buf.byteLength / (1024 * 1024);
    const mime = guessAudioMime(filepath);
    const model = genAI.getGenerativeModel({ model: models.transcribe });

    // 小さいファイル：inlineData で直送
    if (sizeMB <= 18) {
      const result = await model.generateContent([
        {
          inlineData: {
            data: buf.toString("base64"),
            mimeType: mime,
          },
        },
        {
          text: "この音声を日本語で正確に書き起こしてください。話者が複数いる場合は『話者A:』『話者B:』のように区別してください。フィラー（えーと、あの、等）は適度に省略して構いません。書き起こしテキストのみを出力し、前置きや説明は付けないでください。",
        },
      ]);
      const text = result.response.text();
      return text || null;
    }

    // 大きいファイル：Files API でアップロード → generateContent
    // ※ Files API は @google/generative-ai 0.24 では別モジュール。MVPでは未対応エラー扱い
    // 呼出側 (api/meetings/route.ts) は null をダミー文字列に置換するため、
    // このままだと UI 上は「書き起こし成功」に見えてしまう。判別可能な形で投げる。
    console.warn(
      `[ai-fallback] site=geminiTranscribe reason=file-too-large size=${sizeMB.toFixed(1)}MB ` +
        "(Files API 未実装。T20 で対応予定)",
    );
    throw new TranscriptionTooLargeError(sizeMB);
  } catch (e) {
    if (e instanceof TranscriptionTooLargeError) throw e;
    console.error("[ai-fallback] site=geminiTranscribe err=", e);
    if (isFailFast()) throw e;
    return null;
  }
}

/** Geminiで埋め込みベクトルを生成。失敗時 null。 */
export async function geminiEmbed(text: string): Promise<number[] | null> {
  if (getGoogleBackend() === "vertex") {
    // Vertex の埋め込みは :predict / instances[] と API 形状が異なる。
    // 本体コードからは未使用なので、実装せず理由だけ残す。
    console.warn("[ai-fallback] site=geminiEmbed backend=vertex reason=not-implemented");
    return null;
  }
  const genAI = getGenAI();
  if (!genAI) return null;
  const models = getGeminiModels();
  try {
    const model = genAI.getGenerativeModel({ model: models.embed });
    const result = await model.embedContent(text);
    return result.embedding.values ?? null;
  } catch (e) {
    console.error("[gemini] embed failed", e);
    return null;
  }
}
