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
import { google } from "@ai-sdk/google";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs";
import path from "node:path";
import { getGeminiModels, hasGeminiKey } from "./provider";

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
  if (!hasGeminiKey()) return null;
  const models = getGeminiModels();
  const modelName = opts.modelOverride ?? models.default;
  try {
    const result = await generateText({
      model: google(modelName),
      system: opts.system,
      prompt: opts.user,
      temperature: opts.temperature ?? 0.3,
      // AI SDK v6: maxOutputTokens が標準
      maxOutputTokens: opts.maxTokens ?? 2000,
      // JSONモード: responseFormat で json を指定
      ...(opts.json
        ? {
            providerOptions: {
              google: {
                responseMimeType: "application/json",
              },
            },
          }
        : {}),
    });
    return result.text;
  } catch (e) {
    console.error("[gemini] call failed", e);
    return null;
  }
}

// ============================================================
// 音声書き起こし（Whisper代替）
// Files API で音声をアップロード→generateContentで文字起こしを依頼
// 対応: WebM / MP3 / WAV / AIFF / AAC / OGG / FLAC
// ============================================================

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI | null {
  if (!hasGeminiKey()) return null;
  if (!_genAI) {
    _genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);
  }
  return _genAI;
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
  const genAI = getGenAI();
  if (!genAI) return null;
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
    console.warn(
      `[gemini] file too large for inlineData (${sizeMB.toFixed(1)}MB). Files API path not yet implemented.`,
    );
    return null;
  } catch (e) {
    console.error("[gemini] transcribe failed", e);
    return null;
  }
}

/** Geminiで埋め込みベクトルを生成。失敗時 null。 */
export async function geminiEmbed(text: string): Promise<number[] | null> {
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
