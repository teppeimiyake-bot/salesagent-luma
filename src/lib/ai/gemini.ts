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

import { measureAiCall, type AiFeature } from "./usage";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { FileState, GoogleAIFileManager } from "@google/generative-ai/server";
import { Agent, fetch as undiciFetch } from "undici";
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

const INLINE_AUDIO_LIMIT_BYTES = 18 * 1024 * 1024;
const FILES_API_POLL_INTERVAL_MS = 2_000;
const FILES_API_MAX_WAIT_MS = 260_000;
const FILES_API_UPLOAD_ATTEMPTS = 3;
/** 大容量 mp4 の Files API アップロード用（デフォルト fetch だと途中で fetch failed になりやすい） */
const filesApiAgent = new Agent({
  connectTimeout: 60_000,
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
});
const TRANSCRIBE_PROMPT =
  "これは業務用の商談録音です。聞こえた発話だけを日本語で文字起こししてください。複数話者は「話者1:」「話者2:」のように分けてください。説明文は不要で、書き起こし本文のみを返してください。音声が無音・聞き取れない場合は「（聞き取れませんでした）」とだけ返してください。";

export interface GeminiTranscriptionResult {
  text: string | null;
  metrics: {
    provider: "gemini";
    model: string;
    inputMode: "inline" | "files_api";
    inputBytes: number;
    mimeType: string;
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
    usage: Record<string, unknown> | null;
  };
}

function responseUsage(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const usage = (response as { usageMetadata?: unknown }).usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  return JSON.parse(JSON.stringify(usage)) as Record<string, unknown>;
}

export interface GeminiCallOptions {
  feature?: AiFeature;
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
    const result = await measureAiCall({ provider: "gemini", model: modelName, feature: opts.feature }, () => generateText({
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
    }), result => result.totalUsage);
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

/** generateContent の応答から文字起こし本文を取り出す。 */
function extractTranscriptText(response: {
  text: () => string;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
}): string | null {
  try {
    const text = response.text()?.trim();
    if (text) return text;
  } catch {
    // RECITATION 等で text() が throw する場合があるので parts を直接読む
  }

  const partsText =
    response.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim() ?? "";
  if (partsText) return partsText;

  const reason = response.candidates?.[0]?.finishReason;
  if (reason) {
    throw new Error(`Gemini文字起こしがブロックされました（${reason}）。別の録音で再試行してください。`);
  }
  return null;
}

/** 拡張子からMIMEタイプを推定（音声ファイル用）。 */
function guessAudioMime(filepath: string): string {
  const ext = path.extname(filepath).toLowerCase().replace(/^\./, "");
  const map: Record<string, string> = {
    webm: "audio/webm",
    mp3: "audio/mp3",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    mpeg: "video/mpeg",
    mpg: "video/mpeg",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
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
 * 戦略：18MB以下は inlineData、超は Files API（resumable upload + ACTIVE待ち）。
 */
export async function geminiTranscribe(filepath: string): Promise<string | null> {
  return (await geminiTranscribeWithMetrics(filepath)).text;
}

export async function geminiTranscribeWithMetrics(filepath: string): Promise<GeminiTranscriptionResult> {
  if (getTranscribeBackend() === "vertex") {
    // 音声はまだ Vertex 経路を実装していない。黙って劣化させず、理由を残して落とす。
    console.warn(
      "[ai-fallback] site=geminiTranscribe backend=vertex reason=not-implemented " +
        "(AI_TRANSCRIBE_BACKEND=aistudio にするか、Vertex 音声対応を実装すること)",
    );
    if (isFailFast()) throw new Error("音声書き起こしの Vertex 経路は未実装です");
    return {
      text: null,
      metrics: {
        provider: "gemini",
        model: getGeminiModels().transcribe,
        inputMode: "inline",
        inputBytes: 0,
        mimeType: "unknown",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: 0,
        usage: null,
      },
    };
  }
  const genAI = getGenAI();
  if (!genAI) {
    console.warn("[ai-fallback] site=geminiTranscribe reason=no-api-key");
    if (isFailFast()) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY が未設定です");
    return {
      text: null,
      metrics: {
        provider: "gemini",
        model: getGeminiModels().transcribe,
        inputMode: "inline",
        inputBytes: 0,
        mimeType: "unknown",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        elapsedMs: 0,
        usage: null,
      },
    };
  }
  const models = getGeminiModels();
  console.log("[gemini] transcribe start", { model: models.transcribe });
  const started = new Date();
  try {
    const buf = await fs.promises.readFile(filepath);
    const mime = guessAudioMime(filepath);
    const model = genAI.getGenerativeModel({ model: models.transcribe });

    if (buf.byteLength <= INLINE_AUDIO_LIMIT_BYTES) {
      const result = await model.generateContent([
        {
          inlineData: {
            data: buf.toString("base64"),
            mimeType: mime,
          },
        },
        { text: TRANSCRIBE_PROMPT },
      ]);
      const completed = new Date();
      return {
        text: extractTranscriptText(result.response),
        metrics: {
          provider: "gemini",
          model: models.transcribe,
          inputMode: "inline",
          inputBytes: buf.byteLength,
          mimeType: mime,
          startedAt: started.toISOString(),
          completedAt: completed.toISOString(),
          elapsedMs: completed.getTime() - started.getTime(),
          usage: responseUsage(result.response),
        },
      };
    }

    return transcribeViaFilesApi(filepath, mime, models.transcribe, started, buf.byteLength);
  } catch (e) {
    console.error("[gemini] transcribe failed", e);
    // null だと呼び出し側が「空結果」と誤認するため、原因を伝播する
    throw e instanceof Error ? e : new Error(String(e));
  }
}

function formatFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : "";
  return cause ? `${e.message} (${cause})` : e.message;
}

/**
 * Gemini Files API の resumable upload。
 * SDK の uploadFile は大容量で fetch failed になりやすいため、タイムアウト長めの undici で送る。
 */
async function uploadToGeminiFilesApi(
  filepath: string,
  mime: string,
): Promise<{ name: string; uri: string; mimeType: string }> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set");

  const stat = await fs.promises.stat(filepath);
  const numBytes = stat.size;
  const displayName = path.basename(filepath).replace(/[^\w.\-]+/g, "_").slice(0, 120) || "recording.bin";
  const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  console.log("[gemini] Files API upload start", {
    bytes: numBytes,
    mb: Number((numBytes / (1024 * 1024)).toFixed(1)),
    mime,
    displayName,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= FILES_API_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const startRes = await undiciFetch(startUrl, {
        method: "POST",
        dispatcher: filesApiAgent,
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(numBytes),
          "X-Goog-Upload-Header-Content-Type": mime,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: displayName } }),
      });
      if (!startRes.ok) {
        throw new Error(`Files API start failed: ${startRes.status} ${await startRes.text()}`);
      }
      const uploadUrl = startRes.headers.get("x-goog-upload-url");
      if (!uploadUrl) throw new Error("Files API did not return x-goog-upload-url");

      // 592MB級を Buffer 全載せすると Node が落ちるためストリーム送信する
      const stream = fs.createReadStream(filepath);
      const uploadRes = await undiciFetch(uploadUrl, {
        method: "POST",
        dispatcher: filesApiAgent,
        headers: {
          "Content-Length": String(numBytes),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: stream,
        // Node fetch / undici で Readable を送るときに必要
        duplex: "half",
      } as Parameters<typeof undiciFetch>[1]);
      if (!uploadRes.ok) {
        throw new Error(`Files API finalize failed: ${uploadRes.status} ${await uploadRes.text()}`);
      }

      const json = (await uploadRes.json()) as {
        file?: { name?: string; uri?: string; mimeType?: string };
      };
      if (!json.file?.name || !json.file?.uri) {
        throw new Error("Files API upload response missing file.name/uri");
      }

      console.log("[gemini] Files API upload done", { name: json.file.name });
      return {
        name: json.file.name,
        uri: json.file.uri,
        mimeType: json.file.mimeType ?? mime,
      };
    } catch (e) {
      lastError = e;
      console.warn(`[gemini] Files API upload attempt ${attempt}/${FILES_API_UPLOAD_ATTEMPTS} failed`, {
        message: formatFetchError(e),
      });
      if (attempt < FILES_API_UPLOAD_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  throw new Error(
    `Gemini Files APIへのアップロードに失敗しました: ${formatFetchError(lastError)}。ネットワーク／TLS／ファイルサイズを確認してください。`,
  );
}

async function transcribeViaFilesApi(
  filepath: string,
  mime: string,
  modelName: string,
  started: Date,
  inputBytes: number,
): Promise<GeminiTranscriptionResult> {
  const genAI = getGenAI();
  if (!genAI) throw new Error("Gemini is not configured");

  const fileManager = new GoogleAIFileManager(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);
  let fileName: string | null = null;

  try {
    const uploaded = await uploadToGeminiFilesApi(filepath, mime);
    fileName = uploaded.name;

    const activeFile = await waitForActiveGeminiFile(fileManager, fileName);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent([
      {
        fileData: {
          mimeType: activeFile.mimeType ?? uploaded.mimeType,
          fileUri: activeFile.uri,
        },
      },
      { text: TRANSCRIBE_PROMPT },
    ]);
    const completed = new Date();
    return {
      text: extractTranscriptText(result.response),
      metrics: {
        provider: "gemini",
        model: modelName,
        inputMode: "files_api",
        inputBytes,
        mimeType: mime,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        elapsedMs: completed.getTime() - started.getTime(),
        usage: responseUsage(result.response),
      },
    };
  } finally {
    if (fileName) {
      await fileManager.deleteFile(fileName).catch((e) => {
        console.warn("[gemini] failed to delete uploaded file reference", {
          fileName,
          message: e instanceof Error ? e.message : String(e),
        });
      });
    }
  }
}

async function waitForActiveGeminiFile(fileManager: GoogleAIFileManager, fileName: string) {
  const started = Date.now();
  while (true) {
    const file = await fileManager.getFile(fileName);
    if (file.state === FileState.ACTIVE) return file;
    if (file.state === FileState.FAILED) {
      throw new Error("Gemini Files API failed to process the uploaded audio file.");
    }
    if (Date.now() - started > FILES_API_MAX_WAIT_MS) {
      throw new Error("Gemini Files API audio processing timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, FILES_API_POLL_INTERVAL_MS));
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
