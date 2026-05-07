/**
 * 営業エージェント 多段推論パイプライン（最重要）
 *
 * STEP1: 構造化（事実整理）
 * STEP2: 営業分析（課題・BANT）
 * STEP3: トップ営業思考（本音・意思決定構造・失注リスク・勝ち筋）
 * STEP4: 戦略設計
 * STEP5: Next Action生成
 * STEP6: スコアリング
 * STEP7: 自己改善（スコア4未満は再生成）
 *
 * 設計方針
 * - 各STEPは独立関数。AI（Gemini/Anthropic）が利用不可ならローカルなフォールバックで完走
 * - 各STEPの入出力を ai_logs に記録（呼び出し側責務）
 * - 過去のユーザー編集（pastEdits）をプロンプトに織り込んで学習を回す
 */

import { callClaudeJSON, tryParseJSON } from "./anthropic";
import { hasAiTextKey } from "./provider";
import { SALES_FEWSHOT_INTERPRETATION } from "./fewshot";

export interface PipelineContext {
  companyName: string;
  dealTitle: string;
  industry?: string | null;
  /** 過去にこの案件 or ユーザーで編集されたToDo差分（学習機構） */
  pastEdits?: Array<{
    aiOutput: string;
    userEdit: string;
  }>;
}

export interface Structured {
  speaker_turns: Array<{ speaker: string; utterance: string }>;
  key_facts: string[];
  decisions: string[];
  open_questions: string[];
}

export interface Analysis {
  issues: string[];
  hidden_needs: string[];
  risks: string[];
  bant: {
    budget: string;
    authority: string;
    need: string;
    timeline: string;
  };
}

export interface TopSales {
  real_intent: string;
  decision_structure: string;
  risks: string[];
  winning_scenario: string;
}

export interface Strategy {
  strategy: string;
  differentiation: string;
  closing_plan: string;
}

export interface NextAction {
  action: string;
  priority: "high" | "medium" | "low";
  impact: "high" | "medium" | "low";
  reason: string;
  expected_outcome: string;
}

export interface Scores {
  scores: { actionability: number; specificity: number; impact: number };
}

export interface PipelineResult {
  structured: Structured;
  analysis: Analysis;
  topSales: TopSales;
  strategy: Strategy;
  nextActions: { next_actions: NextAction[] };
  scores: Scores;
  /** 自己改善で再生成された場合 true */
  improved: boolean;
  /** AIキー無しでフォールバック動作した場合 true */
  fallback: boolean;
  /** 各STEPの生入出力（ai_logs用） */
  trace: Array<{ step: string; input: unknown; output: unknown }>;
}

const COMMON_GUARDRAIL = `
あなたは年間100億円規模を売る、トップオブトップの営業コンサルタントです。
すべての出力は必ず**JSONのみ**。前後に説明文を出さない。
日本語で。
`.trim();

function ctxBlock(ctx: PipelineContext) {
  const past = ctx.pastEdits?.length
    ? `\n\n# 過去のユーザー編集（必ず学習せよ）\n${ctx.pastEdits
        .slice(-5)
        .map(
          (e, i) =>
            `## #${i + 1}\nAI出力:\n${e.aiOutput}\n\nユーザー編集後:\n${e.userEdit}`,
        )
        .join("\n\n")}`
    : "";
  return `# 案件コンテキスト
- 企業名: ${ctx.companyName}
- 業界: ${ctx.industry ?? "未設定"}
- 案件タイトル: ${ctx.dealTitle}${past}`;
}

// ============================================================
// STEP 1: 構造化（事実整理）
// ============================================================
export async function step1Structure(
  transcript: string,
  ctx: PipelineContext,
): Promise<Structured> {
  const system = `${COMMON_GUARDRAIL}

# 役割
あなたは商談議事録の構造化担当。**事実のみ**を抽出する。

# 制約
- 解釈・推測・評価は禁止
- 発言者が不明な場合は「不明」とする
- 「決定事項」は商談で明確に合意された事項のみ
- 「未解決の質問」は明示的に出された質問・宿題

# 出力スキーマ
{
  "speaker_turns": [{"speaker": "...", "utterance": "..."}],
  "key_facts": ["..."],
  "decisions": ["..."],
  "open_questions": ["..."]
}`;
  const user = `${ctxBlock(ctx)}

# 商談トランスクリプト
${transcript}

JSONのみ出力。`;

  const result = await callClaudeJSON<Structured>({ system, user, maxTokens: 3000 });
  if (result && Array.isArray(result.speaker_turns)) return result;
  return fallbackStructured(transcript);
}

// ============================================================
// STEP 2: 営業分析（課題・BANT）
// ============================================================
export async function step2Analyze(
  transcript: string,
  structured: Structured,
  ctx: PipelineContext,
): Promise<Analysis> {
  const system = `${COMMON_GUARDRAIL}

# 役割
営業分析担当。トランスクリプトとSTEP1の構造化結果から、課題・潜在ニーズ・リスク・BANTを抽出する。

# BANT
- Budget: 予算（金額／確保状況／会計年度）
- Authority: 決裁権限（誰が決裁／稟議プロセス／意思決定者は商談に出ているか）
- Need: 必要性（解決したい課題／優先度）
- Timeline: 導入時期（いつまでに導入したいか）
※不明な場合は「未確定: 〜を確認する必要あり」と書く

# 出力スキーマ
{
  "issues": ["..."],
  "hidden_needs": ["..."],
  "risks": ["..."],
  "bant": {
    "budget": "...",
    "authority": "...",
    "need": "...",
    "timeline": "..."
  }
}`;
  const user = `${ctxBlock(ctx)}

# トランスクリプト
${transcript}

# STEP1構造化
${JSON.stringify(structured, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Analysis>({ system, user, maxTokens: 2500 });
  if (r && r.bant) return r;
  return fallbackAnalysis(structured);
}

// ============================================================
// STEP 3: トップ営業思考（コア）
// ============================================================
export async function step3TopSales(
  transcript: string,
  structured: Structured,
  analysis: Analysis,
  ctx: PipelineContext,
): Promise<TopSales> {
  const system = `${COMMON_GUARDRAIL}

# 役割
あなたはトップ営業の思考を再現する。表面的な発言ではなく、顧客の本音・意思決定構造・失注リスク・勝ち筋を読み解く。

# 思考順序（厳守）
1. 顧客の本音（real_intent）：表向き発言の裏にある本当の関心・懸念
2. 意思決定構造（decision_structure）：誰が／どう／いつ決めるか。隠れたキーパーソンを必ず推定
3. 失注リスク（risks）：このまま進むと失注する具体的シナリオ
4. 勝ち筋（winning_scenario）：受注に至るシナリオを「動詞＋主語」で記述

# 守るべき原則
- 抽象論禁止（「関係構築が大切」のような）
- 必ず「誰が／何を／いつまでに」が含まれる
- 失注リスクは「想定」ではなく「現に発生している兆候」をベースにする

${SALES_FEWSHOT_INTERPRETATION}

# 出力スキーマ
{
  "real_intent": "...",
  "decision_structure": "...",
  "risks": ["..."],
  "winning_scenario": "..."
}`;
  const user = `${ctxBlock(ctx)}

# トランスクリプト
${transcript}

# STEP1構造化
${JSON.stringify(structured, null, 2)}

# STEP2分析
${JSON.stringify(analysis, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<TopSales>({ system, user, maxTokens: 2000, temperature: 0.4 });
  if (r && r.real_intent) return r;
  return fallbackTopSales(analysis);
}

// ============================================================
// STEP 4: 戦略設計
// ============================================================
export async function step4Strategy(
  topSales: TopSales,
  analysis: Analysis,
  ctx: PipelineContext,
): Promise<Strategy> {
  const system = `${COMMON_GUARDRAIL}

# 役割
受注確率を最大化する戦略を設計する。

# 出力スキーマ
{
  "strategy": "全体戦略（1〜2文）",
  "differentiation": "競合・代替案に対しどこで明確に勝つか",
  "closing_plan": "受注までの具体プラン（フェーズ・週次タイムライン）"
}`;
  const user = `${ctxBlock(ctx)}

# STEP2分析
${JSON.stringify(analysis, null, 2)}

# STEP3トップ営業思考
${JSON.stringify(topSales, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Strategy>({ system, user, maxTokens: 1500 });
  if (r && r.strategy) return r;
  return fallbackStrategy(topSales);
}

// ============================================================
// STEP 5: Next Action生成
// ============================================================
export async function step5NextActions(
  topSales: TopSales,
  strategy: Strategy,
  analysis: Analysis,
  ctx: PipelineContext,
): Promise<{ next_actions: NextAction[] }> {
  const system = `${COMMON_GUARDRAIL}

# 役割
受注確度を上げる「即実行可能なNext Action」を3〜6個生成する。

# 制約（厳守）
- 抽象禁止：「関係構築」「フォローアップ」「検討」「強化」NG
- 必ず「動詞＋目的語＋期限」を含める
- 主語は「営業担当」。誰が動くか明確にする
- impactは受注確度への寄与度
- priorityは「今すぐ着手すべき度合い」
- 1つは必ず "決裁者を巻き込む / 稟議を通す" 系
- 1つは必ず "失注リスクを潰す" 系
- すべて1日〜1週間以内に着手可能なもの

${SALES_FEWSHOT_INTERPRETATION}

# 出力スキーマ
{
  "next_actions": [
    {
      "action": "...",
      "priority": "high|medium|low",
      "impact": "high|medium|low",
      "reason": "...",
      "expected_outcome": "..."
    }
  ]
}`;
  const user = `${ctxBlock(ctx)}

# STEP2分析
${JSON.stringify(analysis, null, 2)}

# STEP3トップ営業思考
${JSON.stringify(topSales, null, 2)}

# STEP4戦略
${JSON.stringify(strategy, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<{ next_actions: NextAction[] }>({
    system,
    user,
    maxTokens: 2500,
    temperature: 0.4,
  });
  if (r && Array.isArray(r.next_actions) && r.next_actions.length > 0) return r;
  return fallbackNextActions(strategy, topSales);
}

// ============================================================
// STEP 6: スコアリング
// ============================================================
export async function step6Score(actions: { next_actions: NextAction[] }): Promise<Scores> {
  const system = `${COMMON_GUARDRAIL}

# 役割
Next Actionの品質を1〜5で評価する。

# 評価基準
- actionability: 1=曖昧 / 5=今日中に着手可能
- specificity: 1=抽象的 / 5=「誰が・いつまでに・何を」が明確
- impact: 1=効果が読めない / 5=受注確度に直結

# 出力スキーマ
{
  "scores": {
    "actionability": 1-5,
    "specificity": 1-5,
    "impact": 1-5
  }
}`;
  const user = `# Next Actions
${JSON.stringify(actions, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Scores>({ system, user, maxTokens: 400 });
  if (r && r.scores) return r;
  return fallbackScores(actions);
}

// ============================================================
// STEP 7: 自己改善（スコア4未満は再生成）
// ============================================================
export async function step7SelfImprove(
  actions: { next_actions: NextAction[] },
  scores: Scores,
  topSales: TopSales,
  strategy: Strategy,
  analysis: Analysis,
  ctx: PipelineContext,
): Promise<{ next_actions: NextAction[] } | null> {
  const min = Math.min(scores.scores.actionability, scores.scores.specificity, scores.scores.impact);
  if (min >= 4) return null;

  const system = `${COMMON_GUARDRAIL}

# 役割
直前のNext Actionは品質が不足。**より具体的に**書き直す。

# 改善ルール
- すべての action に「期限（今日中／48時間以内／今週中）」を入れる
- すべての action に「主語＋動詞＋目的語」を入れる
- expected_outcome に「定量／定性の到達点」を入れる
- 抽象動詞（強化・改善・検討・最適化）を使ったらNG
- 同じ趣旨でも書き直す。妥協しない

${SALES_FEWSHOT_INTERPRETATION}

# 出力スキーマ
{
  "next_actions": [
    { "action": "...", "priority": "...", "impact": "...", "reason": "...", "expected_outcome": "..." }
  ]
}`;
  const user = `# 案件
${ctxBlock(ctx)}

# 直前のNext Actions（スコア不足: ${JSON.stringify(scores.scores)}）
${JSON.stringify(actions, null, 2)}

# 戦略コンテキスト
${JSON.stringify({ topSales, strategy, analysis }, null, 2)}

JSONのみ出力。具体性を最大化せよ。`;
  const r = await callClaudeJSON<{ next_actions: NextAction[] }>({
    system,
    user,
    maxTokens: 2500,
    temperature: 0.5,
  });
  if (r && Array.isArray(r.next_actions) && r.next_actions.length > 0) return r;
  return null;
}

// ============================================================
// 全段ランナー
// ============================================================
export async function runPipeline(
  transcript: string,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  const trace: PipelineResult["trace"] = [];
  // プロバイダ抽象化済み：AI_PROVIDER に応じて Gemini or Anthropic のキー有無を見る
  const hasKey = hasAiTextKey();

  const structured = await step1Structure(transcript, ctx);
  trace.push({ step: "step1_structure", input: { transcript_excerpt: transcript.slice(0, 200) }, output: structured });

  const analysis = await step2Analyze(transcript, structured, ctx);
  trace.push({ step: "step2_analysis", input: { structured }, output: analysis });

  const topSales = await step3TopSales(transcript, structured, analysis, ctx);
  trace.push({ step: "step3_top_sales", input: { analysis }, output: topSales });

  const strategy = await step4Strategy(topSales, analysis, ctx);
  trace.push({ step: "step4_strategy", input: { topSales }, output: strategy });

  let nextActions = await step5NextActions(topSales, strategy, analysis, ctx);
  trace.push({ step: "step5_next_actions", input: { strategy }, output: nextActions });

  const scores = await step6Score(nextActions);
  trace.push({ step: "step6_scores", input: { nextActions }, output: scores });

  const improved = await step7SelfImprove(nextActions, scores, topSales, strategy, analysis, ctx);
  if (improved) {
    nextActions = improved;
    trace.push({ step: "step7_self_improved", input: { scores }, output: improved });
  }

  return {
    structured,
    analysis,
    topSales,
    strategy,
    nextActions,
    scores,
    improved: !!improved,
    fallback: !hasKey,
    trace,
  };
}

// ============================================================
// フォールバック実装（API key無し or 失敗時）
// MVPでも UI 動作確認できるように、議事録から決定論的に意味のある出力を作る
// ============================================================
function fallbackStructured(transcript: string): Structured {
  const lines = transcript
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const turns = lines.map((line) => {
    const m = line.match(/^(顧客|営業|担当|先方|当社|[A-Za-z一-鿿]+?)[:：](.*)$/);
    if (m) return { speaker: m[1].trim(), utterance: m[2].trim() };
    return { speaker: "不明", utterance: line };
  });
  const facts = lines.filter((l) => /(円|万|月|社|人|％|%|導入|契約|稟議|決裁)/.test(l)).slice(0, 8);
  const decisions = lines.filter((l) => /(決定|合意|確定)/.test(l)).slice(0, 5);
  const questions = lines.filter((l) => l.endsWith("?") || l.endsWith("？") || /未確定|宿題|確認/.test(l)).slice(0, 5);
  return {
    speaker_turns: turns.slice(0, 30),
    key_facts: facts.length ? facts : ["（議事録からキー事実は抽出できず／AIキー未設定）"],
    decisions: decisions.length ? decisions : ["（明確な決定事項は無し）"],
    open_questions: questions.length ? questions : ["決裁者の参加可否", "予算枠／会計年度", "導入希望時期"],
  };
}

function fallbackAnalysis(s: Structured): Analysis {
  return {
    issues: ["決裁者の意向が未確認", "ROIの提示が不足", "競合比較の論点が未整理"].slice(0, 3),
    hidden_needs: ["短期間で成果を見せたい", "社内稟議を通すための弾が欲しい"],
    risks: s.open_questions.slice(0, 3),
    bant: {
      budget: "未確定: 予算枠と会計年度を次回までに確認",
      authority: "未確定: 決裁者を商談に巻き込む段取りが必要",
      need: "顕在化済み: 議事録から課題は明確",
      timeline: "未確定: 導入希望時期をクロージング前に握る",
    },
  };
}

function fallbackTopSales(_a: Analysis): TopSales {
  return {
    real_intent: "表向きは情報収集だが、本音は『社内で稟議を通せる材料』を探している。",
    decision_structure: "現場担当者が起案→上長→決裁者の3段階。決裁者は商談未出席のため、稟議用1枚資料が必須。",
    risks: ["決裁者不在のまま提案が進み、最終局面でひっくり返される", "競合が並行提案中で価格軸に引きずられる"],
    winning_scenario: "48時間以内に決裁者向けROI 1枚を送付し、来週中に決裁者面談をセット。価格でなく投資対効果で握る。",
  };
}

function fallbackStrategy(t: TopSales): Strategy {
  return {
    strategy: "決裁者巻き込み × ROI起点 × タイミング先押さえ",
    differentiation: "稟議資料まで一気に作るパートナーシップ提案。競合は『売って終わり』、当社は『通すまで伴走』。",
    closing_plan: "Week1: 決裁者向け1枚送付＋面談打診 / Week2: 決裁者面談＋ROI合意 / Week3: 契約ドラフト合意 / Week4: 受注",
  };
}

function fallbackNextActions(_s: Strategy, _t: TopSales): { next_actions: NextAction[] } {
  return {
    next_actions: [
      {
        action: "決裁者向けROI 1枚（現状コスト vs 導入後の差分）を48時間以内に作成し、担当者経由で送付する",
        priority: "high",
        impact: "high",
        reason: "決裁者が商談に未出席のため、稟議を通す材料が決定的に不足している",
        expected_outcome: "決裁者面談の打診OKをもらう／ROI合意の土台を作る",
      },
      {
        action: "今週中の決裁者面談スロットを3つ提示するメールを当日中に送付する",
        priority: "high",
        impact: "high",
        reason: "決裁プロセスの可視化と巻き込みが受注の最大要因",
        expected_outcome: "決裁者の予定を確保／来週中の面談確定",
      },
      {
        action: "競合との比較表（自社が明確に勝つ3軸を強調）を24時間以内に作成し共有する",
        priority: "medium",
        impact: "high",
        reason: "競合並行提案中で価格軸に引きずられるリスクが現に出ている",
        expected_outcome: "比較軸を自社の土俵に再設定する",
      },
      {
        action: "次回MTGまでに導入希望時期と会計年度のヒアリング項目を3つに整理し、商談冒頭で確認する",
        priority: "medium",
        impact: "medium",
        reason: "BANTのT・Bが未確定のままクロージングに向かうと失注確率が上がる",
        expected_outcome: "クロージングのタイミングを確定する",
      },
    ],
  };
}

function fallbackScores(_a: { next_actions: NextAction[] }): Scores {
  return { scores: { actionability: 4, specificity: 4, impact: 4 } };
}

// ヘルパー: 単発のJSONリトライパース
export function safeParse<T>(text: string): T | null {
  return tryParseJSON<T>(text);
}
