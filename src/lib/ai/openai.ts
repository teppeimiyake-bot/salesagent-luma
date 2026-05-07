/**
 * 音声書き起こし・埋め込みラッパ（プロバイダ抽象）
 *
 * **歴史的事情でファイル名は openai.ts のまま**。実体は AI_PROVIDER に応じて
 * Gemini / OpenAI を振り分ける。呼出側コードを変更せずに済むように
 * 同名・同シグネチャを厳守する。
 *
 * - AI_PROVIDER=gemini（デフォルト）: Gemini Files API + 音声入力
 * - AI_PROVIDER=anthropic:           OpenAI Whisper（旧実装）
 *
 * APIキーが無い／失敗時は null を返す。
 */

import OpenAI from "openai";
import fs from "node:fs";
import { geminiTranscribe, geminiEmbed } from "./gemini";
import { getTextProvider, hasOpenAiKey } from "./provider";

const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1";
const embedModel = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

let openaiClient: OpenAI | null = null;
function getOpenAiClient() {
  if (!hasOpenAiKey()) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return openaiClient;
}

/** OpenAI Whisperで書き起こし。 */
async function openaiTranscribe(filepath: string): Promise<string | null> {
  const c = getOpenAiClient();
  if (!c) return null;
  try {
    const res = await c.audio.transcriptions.create({
      file: fs.createReadStream(filepath),
      model: transcribeModel,
      language: "ja",
      response_format: "text",
    });
    return typeof res === "string" ? res : ((res as { text?: string }).text ?? null);
  } catch (e) {
    console.error("[openai] transcribe failed", e);
    return null;
  }
}

/** OpenAI Embeddingsでベクトル化。 */
async function openaiEmbed(text: string): Promise<number[] | null> {
  const c = getOpenAiClient();
  if (!c) return null;
  try {
    const res = await c.embeddings.create({ model: embedModel, input: text });
    return res.data[0]?.embedding ?? null;
  } catch (e) {
    console.error("[openai] embed failed", e);
    return null;
  }
}

/**
 * ファイルパスから文字起こし。AI_PROVIDER に応じて Gemini / OpenAI を選択。
 * 失敗／キー無し時は null。
 */
export async function transcribeFile(filepath: string): Promise<string | null> {
  const provider = getTextProvider();
  if (provider === "anthropic") {
    return openaiTranscribe(filepath);
  }
  return geminiTranscribe(filepath);
}

/**
 * テキストの埋め込みベクトルを返す。AI_PROVIDER に応じて Gemini / OpenAI を選択。
 * 失敗／キー無し時は null。
 */
export async function embed(text: string): Promise<number[] | null> {
  const provider = getTextProvider();
  if (provider === "anthropic") {
    return openaiEmbed(text);
  }
  return geminiEmbed(text);
}
