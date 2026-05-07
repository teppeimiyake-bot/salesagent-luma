/**
 * Geminiスモークテスト（フェーズ1動作確認用）
 *
 * 使い方：
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"
 *   npx tsx scripts/test-gemini-smoke.ts
 *
 * 確認項目：
 *   1. プロバイダ判定（AI_PROVIDER / キー有無）
 *   2. callClaudeJSON：JSON出力（短いプロンプト）
 *   3. callClaude：テキスト出力（短いプロンプト）
 *   4. embed：埋め込みベクトル生成
 *   5. transcribeFile：音声書き起こし（uploads/recordings/ にWebMがあれば）
 *   6. 7段推論パイプライン：架空商談データで runPipeline 実行
 *
 * GOOGLE_GENERATIVE_AI_API_KEY 未設定時は各機能のフォールバック挙動を確認。
 */

import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import { callClaude, callClaudeJSON } from "../src/lib/ai/anthropic";
import { transcribeFile, embed } from "../src/lib/ai/openai";
import { runPipeline } from "../src/lib/ai/pipeline";
import {
  getTextProvider,
  hasGeminiKey,
  hasAnthropicKey,
  hasOpenAiKey,
  hasAiTextKey,
  getGeminiModels,
} from "../src/lib/ai/provider";

function line(label: string, value: unknown) {
  console.log(`  ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function main() {
  console.log("=== Luma SalesAgent Gemini Smoke Test ===\n");

  // 1. プロバイダ判定
  console.log("[1] Provider detection");
  line("AI_PROVIDER", getTextProvider());
  line("hasGeminiKey", hasGeminiKey());
  line("hasAnthropicKey", hasAnthropicKey());
  line("hasOpenAiKey", hasOpenAiKey());
  line("hasAiTextKey (current provider)", hasAiTextKey());
  line("Gemini models", getGeminiModels());
  console.log("");

  // キーが無いならスキップ
  const hasKey = hasAiTextKey();
  if (!hasKey) {
    console.log("[!] AIキー未設定。callClaude/embed/transcribeFile はnull返却を確認するのみ。");
  }

  // 2. callClaudeJSON
  console.log("[2] callClaudeJSON: JSON生成");
  const jsonRes = await callClaudeJSON<{ greeting: string; lang: string }>({
    system:
      "あなたはJSON生成器。指示通りのJSONのみを返す。前後に説明や改行を入れない。",
    user:
      'こんにちは。次のキー2つで返してください: greeting（短い挨拶文・日本語）、 lang（"ja"固定）。JSONのみ。',
    maxTokens: 200,
    temperature: 0.1,
  });
  line("result", jsonRes ?? "(null - キー未設定 or 失敗)");
  console.log("");

  // 3. callClaude
  console.log("[3] callClaude: テキスト生成");
  const textRes = await callClaude({
    system: "あなたは簡潔な営業アシスタント。1文で返答。",
    user: "営業トップが大切にする3つの原則を、各15字以内で。番号付きで。",
    maxTokens: 200,
    temperature: 0.3,
  });
  line("result", textRes ?? "(null - キー未設定 or 失敗)");
  console.log("");

  // 4. embed
  console.log("[4] embed: 埋め込みベクトル");
  const vec = await embed("採用動画の制作を検討中。予算は100万円。");
  if (vec) {
    line("dim", vec.length);
    line("first 5 dims", vec.slice(0, 5).map((v) => v.toFixed(4)));
  } else {
    line("result", "(null - キー未設定 or 失敗)");
  }
  console.log("");

  // 5. transcribeFile（任意）
  console.log("[5] transcribeFile: 音声書き起こし");
  try {
    const recDir = path.join(process.cwd(), "uploads", "recordings");
    const files = await fs.readdir(recDir).catch(() => [] as string[]);
    const audio = files.find((f) =>
      /\.(webm|mp3|wav|m4a|aac|ogg|flac|aiff)$/i.test(f),
    );
    if (audio) {
      const fp = path.join(recDir, audio);
      const stat = await fs.stat(fp);
      line("file", `${audio} (${(stat.size / 1024).toFixed(1)}KB)`);
      const t = await transcribeFile(fp);
      line(
        "transcript",
        t ? t.slice(0, 200) + (t.length > 200 ? "..." : "") : "(null - キー未設定 or 失敗)",
      );
    } else {
      console.log("  (音声ファイルが uploads/recordings/ にないためスキップ)");
    }
  } catch (e) {
    console.log("  skip:", (e as Error).message);
  }
  console.log("");

  // 6. 7段推論
  console.log("[6] 7段推論パイプライン (runPipeline)");
  const transcript = `
営業: 本日はお時間いただきありがとうございます。御社の採用動画について、現状の課題をお聞かせください。
顧客: エンジニア採用がうまくいかなくて。今の動画は社長の挨拶だけで、エンジニアの日常が伝わらない。
営業: 競合他社さんはどんな採用動画をお作りに？
顧客: 大手は社員インタビュー型が多いですね。うちも同じ路線でいきたい。
営業: 予算感はどのくらいでお考えですか？
顧客: 100万円前後。それ以上は稟議が厳しい。決めるのは私と社長で、今期中に着手したいです。
営業: 撮影は何月をご希望ですか？
顧客: 5月中に撮って6月公開がベスト。会計年度の関係で。
`.trim();
  const startTs = Date.now();
  const result = await runPipeline(transcript, {
    companyName: "テスト株式会社",
    dealTitle: "採用動画制作",
    industry: "IT・ソフトウェア",
  });
  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  line("elapsed", `${elapsedSec}s`);
  line("fallback", result.fallback);
  line("improved", result.improved);
  line("structured.key_facts (上位3件)", result.structured.key_facts.slice(0, 3));
  line("analysis.bant.budget", result.analysis.bant.budget);
  line("analysis.bant.timeline", result.analysis.bant.timeline);
  line("topSales.real_intent", result.topSales.real_intent.slice(0, 100) + "...");
  line(
    "nextActions.action[0]",
    result.nextActions.next_actions[0]?.action?.slice(0, 100) + "...",
  );
  line("scores", result.scores.scores);
  console.log("");

  console.log("=== DONE ===");
  console.log(
    hasKey
      ? "AIキー設定済みのため、上記出力が Gemini 経由の本番動作です。"
      : "AIキー未設定のため、フォールバック実装が動作。GOOGLE_GENERATIVE_AI_API_KEY を .env に設定して再実行してください。",
  );
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
