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

import { callClaudeHeavyJSON, callClaudeJSON, tryParseJSON } from "./anthropic";
import { hasAiTextKey } from "./provider";
import { SALES_FEWSHOT_INTERPRETATION } from "./fewshot";
import { formatBantDefinitions } from "./bant-definitions";
import { isUnknownBantValue, normalizeUnconfirmedNeed } from "./bant-reconciliation";
import { groundTimeline, splitRunOnSpeakerTurns, stripGeneratedSourceReference, timelineSourceTurns } from "./timeline-evidence";
import { findBantWithdrawal } from "./bant-withdrawal";
import { customerAdoptionConditions, constrainUnagreedSubmissionDeadline } from "./customer-conditions";
import { constrainOfferEvidence } from "./offer-evidence";
import { normalizeStrategyText } from "./strategy-text";
import { groundMinutesProposals, type MinutesProposalAudit, type MinutesProposalCandidate } from "./minutes-proposal-evidence";
import { constrainActionOutcomes } from "./action-outcome";
import { constrainUnverifiedCausalRecommendations } from "./causal-evidence";
import { groundIssueEvidence, type IssueEvidenceAudit } from "./issue-evidence";
import { groundNeedEvidence } from "./need-evidence";
import { groundActionReasons } from "./action-reason-evidence";
import { stripRecommendationSourceReferences } from "./recommendation-source-references";
import { groundMinutesActions, type MinutesActionAudit, type MinutesActionCandidate } from "./minutes-action-evidence";
import { groundMinutesParticipants, type MinutesParticipantAudit } from "./minutes-participant-evidence";
import type { LumaContextDealProduct } from "./luma-context";

export interface PipelineContext {
  companyName: string;
  dealTitle: string;
  industry?: string | null;
  products?: string[];
  dealProducts?: LumaContextDealProduct[];
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

interface NextActionDraft extends NextAction {
  reason_source_ids?: unknown;
}

// Preserve deterministic fallback provenance without adding public/model fields.
const deterministicActionDrafts = new WeakSet<object>();

export interface Scores {
  scores: { actionability: number; specificity: number; impact: number };
}

export interface MeetingMinutesJson {
  participants: string[];
  customer_issues: string[];
  proposals: string[];
  next_actions: Array<{ action: string; owner: string; due: string }>;
  decisions: string[];
  summary: string;
}

interface MeetingMinutesDraft extends Omit<MeetingMinutesJson, "proposals" | "customer_issues" | "next_actions"> {
  issue_source_ids: number[];
  proposals: MinutesProposalCandidate[];
  next_actions: MinutesActionCandidate[];
}

export interface MeetingMinutesResult {
  json: MeetingMinutesJson;
  markdown: string;
  usedFallback: boolean;
  usage?: Record<string, unknown>;
  promptVersion?: string;
  /** Literal customer caveats retained separately from the generated summary. */
  sourceCaveats?: string[];
  generatedSummary?: string;
  /** Provider proposal candidates and grounding decisions; never part of public minutes. */
  proposalAudit?: MinutesProposalAudit;
  /** Issue source references and grounding decisions; never part of public minutes. */
  issueAudit?: IssueEvidenceAudit;
  /** Original action candidates and literal commitment evidence; audit only. */
  actionAudit?: MinutesActionAudit;
  /** Draft participants and why each was kept (speaker / stated attendance) or dropped; audit only. */
  participantAudit?: MinutesParticipantAudit;
}

export interface PipelineResult {
  meetingMinutes: MeetingMinutesResult;
  structured: Structured;
  analysis: Analysis;
  topSales: TopSales;
  strategy: Strategy;
  nextActions: { next_actions: NextAction[] };
  scores: Scores;
  /** 自己改善で再生成された場合 true */
  improved: boolean;
  /**
   * 1段でも決定論フォールバックに落ちた場合 true。
   * 設定が無い場合だけでなく、**設定はあるが呼び出しが失敗した場合も含む**
   * (旧実装はキー有無しか見ておらず、認証エラーを検知できなかった)。
   */
  fallback: boolean;
  /** フォールバックに落ちた段の一覧。どこで壊れたかの特定に使う */
  fallbackSteps: string[];
  /** どのバックエンドで実行したか (A/B 比較の証跡) */
  backend: string;
  /** 未確認の顧客課題を前提に推測を広げず、確認作業に限定した場合。 */
  recommendationGuard?: "unconfirmed-need";
  /** 各STEPの生入出力（ai_logs用） */
  trace: Array<{ step: string; input: unknown; output: unknown }>;
}

const COMMON_GUARDRAIL = `
あなたは発言の根拠を確認し、営業担当の次の行動を支援するコンサルタントです。
すべての出力は必ず**JSONのみ**。前後に説明文を出さない。
日本語で。
- 文字起こし・案件データにない事実、金額、人数、日付、期限、決裁者、競合、顧客の発言、効果を作らない。
- 根拠がない項目は「未確認」とし、推測する場合は必ず「仮説」と明記する。
- 「未確認」「未集計なので分からない」「未決定」という発言から、事実の存在・不在や顧客の認識・意欲を断定しない。「応募数不足か未集計で不明」を「応募数不足を認識していない」に、「導入未決定」を「導入意欲が低い」に変えない。未確認の対象と理由を保持する。
- 文字起こしを一次根拠とする。前段のAI分析や過去の編集、見本は顧客の発言の証拠ではない。仮説・提案を後段で事実や合意に変えない。
- 発言ごとの対象と述語を保つ。同じ発言に複数の媒体・人物・資料が登場しても、一つについて述べた不足・状態を別の対象へ広げない。否定が確認された対象と、状態自体が不明な対象は分ける。
- 未取得・未承認・手元にないと明言された状態を、一律に「未確認」へ弱めない。逆に存在するか不明なものを「存在しない」と断定しない。後の訂正があれば訂正後の状態を使う。
- 同時に述べられた二つの課題は因果関係の証明ではない。原因が未調査なら原因とは断定せず、関係を確認する事項として扱う。
`.trim();

export const SALES_REASONING_PROMPT_VERSION = "20261001-evidence-first-v22";

const RECOMMENDATION_GUARDRAIL = `
# 事実・提案・未確認の区別（全フィールドに適用）
- 以下は条件付きの判定規則であり、今回の顧客の発言例ではない。まず原文にその条件・行動の表明があるか確認する。指示中の例文を、顧客が発言した事実や推奨の理由へ転用しない。
- action だけでなく reason、expected_outcome、risks、winning_scenario にも同じ根拠制約を適用する。
- 確認できない顧客の心理・認識・関心・意欲を、推奨の理由やリスクの原因にしない。「仮説」と付けるだけで未確認の課題を存在する前提にすることも不可。確かめる質問に変える。
- 情報不足に基づくリスクは「未確認のまま提案を進めた場合、条件が合わない可能性」のように未確認の事実と条件付きの懸念を分ける。顧客の欠点や意欲の低さに置き換えない。
- リスクの前提となる発言・予定にも原文の根拠が必要。結果に「可能性」を付けても、前提となる行動や意向を作ってよいことにはならない。
- 今後の営業提案は可能。ただし顧客が承諾・導入・課題認識すると約束しない。必要な情報・希望・連絡可否を確認し、課題や条件が確認できた場合に提案する。
- 顧客の対応予定は原文に明示された行動だけを使う。社内検討や日程未定の発言から、顧客が後で連絡すると約束したことや、営業からの連絡を望まないことを推定しない。片方の予定を双方の合意へ変えない。連絡の制限は明示された場合だけ記載する。
- 応募数を未集計と述べただけなら、未確認なのはその数値と不足の有無。顧客が採用状況全体を把握できない、課題認識が低い、現状把握の支援を求めている、と広げない。課題が確認された場合という条件で提案し、「顧客に課題を認識させる」を目的にしない。
- 顧客の確認内容は原文に明示がなければ不明。別の発言の未集計・未決定を、その確認の対象・予定と結びつけない。real_intent・winning_scenario・strategyでも原文の広さを保つ。
- 集計支援が必要かも、など未確認のhidden_needsは支援ニーズがあるという仮説の断定文にせず、「集計支援を希望するか確認が必要」のように確認事項で書く。
- 期限・期間・週次予定は、今回の原文に対応する行動と共に明示されている場合だけ使う。原文にある別の行動の期限、日程未定を述べる「今日」、過去の日付、過去編集や見本から期限を補わない。
- 「次回面談までに」「次回商談の前に」も期限であり、原文に対応する提出期限の合意がなければ追加しない。面談候補日は資料の提出期限ではない。
- 面談候補の日付を文章や括弧で添えても、資料準備の期限へ転用できない。候補日の確認・調整という行動と、資料を用意する行動の期限は別々に扱う。
- 明示的に撤回された予算・導入希望時期は過去の条件であり、現在の提案条件や約束として使わない。現在未定なら再確認を勧める。撤回理由や顧客心理も、原文にない場合は推測で断定しない。
- 以前の条件の「撤回」と現在の「未定」は、顧客が今「再検討している」「見直しを進めている」「社内で調整中」という進行状況を示すものではない。原文にその活動の明示がなければ、real_intent・strategy・reasonなどの前提は「予算と導入時期が未定であることを踏まえ」と記す。現在の検討状況・未定の理由・決定プロセスは確認事項にし、前段のAIが書いた進行状況も事実として引き継がない。
- 原文の推量・見込み（「上長に相談するとは思いますが」「〜かもしれません」）を「予定」「〜を経て決定される」「進めている」と強めない。推量のまま書くか確認事項にする。確認・質問の行動でも、原文にない活動を前提にした言い方（撤回・未定だけなのに「再検討状況を質問する」）にせず、「現在の予算と導入時期の考え方を確認する」のように原文で分かっている状態だけを前提にする。
- 競合の劣位、実績資料の存在、提供できる支援範囲は未確認なら断定しない。利用できる資料・提供範囲を確認してから提案する。
- 「成功事例を社内データベースから抽出する」「成果のある事例を整理する」は、データベースや成果を示す実績が存在するとの前提を含む。原文・案件データに根拠がなければ、まず「利用できる事例資料・情報源の有無と内容を社内で確認する」とする。事例が確認でき、顧客の状況に合う場合にだけ資料準備や提供を提案する。社内準備という将来の行動でも、未確認の資料・設備・成果を存在する前提にしない。
- 有無・提供可否を確認する行動の expected_outcome は、有無や可否を判断できること。確認すれば必ず資料が見つかり、提供できるようになるとは書かない。利用できる場合の効果を述べるときは、その条件を残す。
- 顧客の予算・目安額は、当社の価格・見積や提供可否の証拠ではない。登録商材名だけでは単価・期間・範囲・組み合わせの総額は分からない。未確認なら「各商材の提供範囲と見積を社内確認し、顧客の目安予算に収まる場合に説明する」と段階を分ける。「その予算で提供可能なサービスを説明する」「その予算で実現できる」と確認済みの前提にしない。reason・expected_outcome・strategy・winning_scenarioにも適用する。顧客の予算額と未承認という条件はそのまま保持する。
- 「導入するなら6月希望」は導入そのものを条件とした希望であり、「6月導入を検討している」という現在の活動や導入予定ではない。real_intentを含む全文で「導入するなら」という条件と正式時期未確定を残す。具体的な課題が確認できても、商材の導入意思・提供価格・提供可否が確認できたことにはならない。
`.trim();

function ctxBlock(ctx: PipelineContext) {
  const past = ctx.pastEdits?.length
    ? `\n\n# 過去のユーザー編集（表現の参考のみ。今回の事実・期限・合意の根拠にしない）\n${ctx.pastEdits
        .slice(-5)
        .map(
          (e, i) =>
            `## #${i + 1}\nAI出力:\n${e.aiOutput}\n\nユーザー編集後:\n${e.userEdit}`,
        )
        .join("\n\n")}`
    : "";
  const products = ctx.products?.length ? ctx.products.join(", ") : "未設定";
  return `# 案件コンテキスト
- 企業名: ${ctx.companyName}
- 業界: ${ctx.industry ?? "未設定"}
- 案件タイトル: ${ctx.dealTitle}
- 商材: ${products}${past}`;
}

// ============================================================
// T05: 議事録生成（minutesJson + Markdown）
// ============================================================
export const MEETING_MINUTES_PROMPT_VERSION = "20261001-transcript-only-v14";

// Retain a narrowly identifiable caveat as a literal quote, without judging
// whether a generated paraphrase has the same meaning or inferring a speaker.
function customerUncertaintyCaveats(transcript: string): string[] {
  const quotes: string[] = [];
  for (const line of transcript.split(/\r?\n/u)) {
    const match = line.trim().match(/^(顧客|先方|お客様)\s*[:：]\s*(.+)$/u);
    if (!match) continue;
    for (const sentence of match[2].match(/[^。！？!?]+[。！？!?]?/gu) ?? []) {
      const reason = /未集計|未調査|(?:集計|調査)(?:を)?(?:していない|していません|しておらず|できていない|できていません|できておらず)/u;
      const uncertain = /分から|分かりません|わから|わかりません|不明|未確認|判断でき(?:ない|ません|ず)/u;
      const negatedReason = /(?:未集計|未調査)(?:では|じゃ)(?:ない|なく|ありません)/u;
      if (sentence.length > 300 || /[?？]/u.test(sentence) || negatedReason.test(sentence) || !reason.test(sentence) || !uncertain.test(sentence)) continue;
      const quote = sentence.trim();
      if (!quotes.includes(quote)) quotes.push(quote);
      if (quotes.length === 2) return quotes;
    }
  }
  return quotes;
}

export async function generateMeetingMinutes(
  rawTranscript: string,
  ctx: PipelineContext,
): Promise<MeetingMinutesResult> {
  // 1行に続けて書かれた複数の発話を話者ラベルで分ける（発言番号と根拠照合を1発話単位にそろえる）。
  const transcript = splitRunOnSpeakerTurns(rawTranscript);
  // Minutes record this conversation, unlike sales strategy. Do not supply the
  // product catalog, deal offerings/title, or historical edits as spoken facts.
  const system = `
あなたは営業商談の議事録作成者です。出力は必ず JSON のみです。

制約:
- 今回の文字起こしだけを発言・提案・合意の根拠とする。文字起こしにない内容を補完しない。不明な場合は "未確認" と書く。
- summary を含む全項目で、事実の有無が未確認であることと、顧客が事実を否定していること・認識していないことを区別する。未確認の理由（未集計、未調査など）が述べられていれば要約にも残す。
- 例: 「応募数が不足しているかは、まだ集計していないので分かりません」は「応募数は未集計のため、不足の有無は未確認」と記録する。「応募数は不足していない」「応募数不足を認識していない」「課題意識がない」と言い換えない。根拠なく不足の存在や顧客の心理・認識を前提にしない。
- 逆に、顧客が明示的に肯定・否定した事実は、その発言として肯定・否定を保持する。「不足していないと確認した」「不足していると確認した」を一律に未確認へ変えない。
- 各文の対象とその状態を個別に保つ。「承認はまだ取れていない」は未取得・未承認であり、承認済みか不明という意味ではない。「資料は手元にない」と「別の資料の有無は分からない」を両方未確認または両方なしにまとめない。後で訂正された場合は最新の状態を使う。
- 識別用の企業名は記録を紐付けるためのメタデータであり、発言者の所属・役職・実名や会話の内容を確定する根拠ではない。
- 金額・人数・日付・期限は、文字起こしに同じ値がある場合だけ書く。値を丸めたり、相対期限へ変換したりしない。
- 「導入するなら2027年6月を希望」は、必ず「導入するなら」という条件付き希望として要約にも残す。「6月導入を希望」「導入を検討している」へ省略・格上げしない。金額の目安・未承認と正式時期未確定も別々に保持する。
- participants は発言者（文字起こしの話者ラベル）と、原文で同席・出席が明示された人だけを書く。話の中で名前が出ただけの人（決裁者・上長・第三者など。例:「決済は工場長の石田です」の石田）は参加者にしない。話者ラベルを保持し、その話者本人について原文に明示された所属・役職・実名だけを補足する。1つの話者ラベルに別の人物を重ねて書かない。「営業」「顧客」のままでよい。根拠なく人物・所属を特定しない。
- customer_issues の自由記述は生成せず、issue_source_ids に顧客が自ら述べた課題・希望・制約の原文発言番号を最大8件選ぶ。公開文は選ばれた発言の原文全体から構成するため、主語・対象・条件・未確認の範囲を要約で変更しない。明示的な営業の質問・推測は選ばず、顧客の「分からない」「未確認」「集計していない」だけを確定課題にしない。予算・承認状況、導入時期・日程、決裁者・承認経路、導入の有無や情報交換という説明だけの発言は課題ではない（BANTとして別に記録される）ので選ばない。同じ発言に困りごと・希望・制約が含まれる場合は選んでよい。確認できた課題がなければ [] とする。
- issue_source_ids は今回の文字起こしの id のみを使う。実名や「話者1」だけの場合は役割を推測しない。原文全体で引用されるため、重複する発言を避け、重要な課題を優先し、選択した原文の合計が2400文字以内に収まるようにする。発言番号はこの内部フィールド以外に書かない。
- proposals は営業が今回の原文で実際に示した方法・選択肢・条件付き案も含む。「提案します」という定型句は不要。「営業側の検討案」「条件付き案」として条件を保ち、採用や発注が未決定であることを区別する。仮説として述べた解決方法を顧客の確定課題に変えない。
- 案件に登録された商材、事実確認の質問、提案してよいか尋ねるだけの質問、明示的に否定された提案、今後のAI推奨を proposals に補わない。原文に方法・選択肢の提示がなければ必ず [] とする。
- proposals は最大6件の内部候補レコードで、各候補に text（60文字以内を目安にした要約）、source_quote、speech_act を付ける。source_quote は営業の同じ発言から、話者ラベルを除いて、連続する完全な文を原文どおり引用する。必要な条件・仮説・未確定の留保を含め、無関係な質問や発言全体をまとめて引用しない。引用は1件300文字以内を目安に、全候補合計1000文字以内に収める。文を途中で切らず、関連する複数の方法は原文の同じ候補にまとめ、重要な選択肢を優先する。
- 話者が実名や「話者1」だけで営業・顧客の別が不明な場合も、今回の会話中に明示された検討案はその原文から候補にできるが、営業の発言と推測しない。明示的な顧客の発言、過去の提案や他社の感想を今回の営業の提案にしない。隣接する条件や「ただし」「仮説」「取り下げる」等を引用から落とさない。
- 提案後の発言も確認する。後で明示的に訂正・撤回された予算や条件を含む旧提案は、現在の検討案として選ばない。訂正後に改めて提示された案があれば、その完全な原文を引用する。別の発言の新しい金額を旧提案へ代入したり、無関係な価格を訂正後の予算と解釈したりしない。現在も有効な原文を条件ごと引用できなければ、その候補は省く。
- speech_act は offered_option / factual_question / existing_state / permission_request / negated_proposal / other のいずれか。事実確認の「共有されていますか」を「共有する」という提案にしない。疑問形でも「この方法を試してみてはいかがでしょうか」は offered_option にできる。「提案してもよろしいですか」は permission_request。同じ発言に提案と事実確認が混在する場合、提案の完全な文だけを引用する。source_quote を抜粋・言い換え・補完して提案を作らない。
- next_actions は原文で表明された対応予定だけを最大6件、action, owner, due, source_quote で記録する。source_quote は先頭の話者ラベルを除き、同じ話者の発言から対応を表明した完全な文を原文どおり引用し、条件・否定を省略しない。全引用合計1200文字以内。公開する対応文と担当は原文から構成するため、営業に勧めたい行動を新たに作らない。期限は対応と一緒に明示された原文表記だけを使い、不明なら "未確認"。「来週の金曜日まで」「明日中」のような相対的な期限も原文の表記のまま due に書き、日付に変換しない。根拠を示せない対応予定は [] とする。
- 「またお話しできればと思います」「話す機会も検討できれば」のような機会への希望を「機会を設ける」「日程を調整する」という担当付きの対応予定に変えない。「社内でも話してみたいと思います」のように本人が行う具体的な対応の意向は、その原文の弱さを保った引用で記録できる。
- 「確認が必要」「できるとよい」という論点だけで担当を割り当てた予定を作らない。顧客が述べた希望や営業が示した選択肢は、実行するとの表明がない限り next_actions へ移さない。
- 原文に「社内で確認してから連絡する」と明示された場合だけ、その連絡予定として残す。「日程を決められない」を、次回打ち合わせの実施や日程調整への合意、提出期限へ変換しない。
- decisions は双方の明示的合意または明示的決定だけを最大3件書く。質問、未決定事項、情報交換だったという説明、片方の連絡予定で埋めない。明確な決定事項がなければ必ず [] とする。
- 一方が日時・条件・対応を具体的に示して確認し（「次回は11月5日の10時に伺ってもよろしいですか」のような質問形でもよい）、もう一方がその内容を明示的に承諾した（「はい、11月5日の10時で大丈夫です」「それでお願いします」）場合は、2つの発言に分かれていても双方の合意として decisions に入れる（例:「次回は11月5日10時に訪問することで合意」）。次回の日程の合意も含む。話者が「話者1」「話者2」のように役割不明でも、異なる話者の間の提示と承諾なら合意として記録できる（役割・所属は推測しない）。承諾の返答がない提示、「検討します」「確認して連絡します」などの保留、条件付きの返答、日程の候補を挙げただけのものは決定事項にしない。
- summary は今回の会話を3行以内でまとめる。原文で述べられた金額・日付・時刻・期限・提出物（例:「80万円を目安」「企画書と正式見積書」「9月30日17時まで」）は、要約で触れるなら省略・一般化しない（「制作費の目安について回答があった」「見積書を送付」だけにしない）。決定がなくても空欄を埋めるために合意を作らず、情報交換、未確認、未決定、日程未定などの留保を保持する。原文で連絡予定が示され、日程が未定の場合は、その2点を区別して記載する。連絡予定から打ち合わせの実施を確定しない。

出力スキーマ:
{
  "participants": ["..."],
  "issue_source_ids": [],
  "proposals": [{ "text": "...", "source_quote": "...", "speech_act": "offered_option" }],
  "next_actions": [{ "action": "...", "owner": "...", "due": "...", "source_quote": "..." }],
  "decisions": ["..."],
  "summary": "..."
}
`.trim();

  const user = `# 識別用の企業名（発言の根拠には使わない）
${JSON.stringify(ctx.companyName)}

# 文字起こし（idは原文の発言番号。textは原文そのまま）
${JSON.stringify(timelineSourceTurns(transcript), null, 2)}

JSONのみ出力してください。`;

  const result = await callClaudeHeavyJSON<MeetingMinutesDraft>({
    feature: "minutes",
    system,
    user,
    maxTokens: 3000,
    temperature: 0.2,
  });

  const draft = result?.parsed;
  const groundedProposals = draft ? groundMinutesProposals(transcript, draft.proposals) : undefined;
  const groundedIssues = draft ? groundIssueEvidence(transcript, draft.issue_source_ids, { excludeBantOnly: true }) : undefined;
  const groundedActions = draft ? groundMinutesActions(transcript, draft.next_actions) : undefined;
  const groundedParticipants = draft ? groundMinutesParticipants(transcript, draft.participants) : undefined;
  const json = normalizeMeetingMinutes(draft
    ? { ...draft, participants: groundedParticipants!.participants, customer_issues: groundedIssues!.issues, proposals: groundedProposals!.proposals, next_actions: groundedActions!.next_actions }
    : fallbackMeetingMinutes(transcript));
  const generatedSummary = json.summary;
  const sourceCaveats = [...customerUncertaintyCaveats(transcript), ...customerAdoptionConditions(transcript).map(({ quote }) => quote)]
    .filter((quote, index, all) => all.indexOf(quote) === index && !json.summary.includes(quote));
  if (sourceCaveats.length) {
    json.summary = [json.summary, ...sourceCaveats.map((quote) => `顧客発言（原文）: ${quote}`)].filter(Boolean).join("\n");
  }
  return {
    json,
    markdown: formatMeetingMinutesMarkdown(json),
    usedFallback: result?.usedFallback ?? true,
    usage: result?.usage,
    promptVersion: MEETING_MINUTES_PROMPT_VERSION,
    ...(sourceCaveats.length ? { sourceCaveats, generatedSummary } : {}),
    ...(groundedProposals ? { proposalAudit: groundedProposals.audit } : {}),
    ...(groundedIssues ? { issueAudit: groundedIssues.audit } : {}),
    ...(groundedActions ? { actionAudit: groundedActions.audit } : {}),
    ...(groundedParticipants ? { participantAudit: groundedParticipants.audit } : {}),
  };
}

function normalizeMeetingMinutes(raw: unknown): MeetingMinutesJson {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const toString = (v: unknown) => {
    if (typeof v === "string") return v.trim();
    if (v == null) return "";
    return String(v).trim();
  };
  const toStringArray = (v: unknown) =>
    Array.isArray(v) ? v.map(toString).filter(Boolean).slice(0, 12) : [];
  const nextActions = Array.isArray(obj.next_actions)
    ? obj.next_actions
        .map((item) => {
          const row =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {};
          return {
            action: toString(row.action) || "未確認",
            owner: toString(row.owner) || "未確認",
            due: toString(row.due) || "未確認",
          };
        })
        .filter((item) => item.action)
        .slice(0, 10)
    : [];

  return {
    participants: toStringArray(obj.participants),
    customer_issues: toStringArray(obj.customer_issues),
    proposals: toStringArray(obj.proposals),
    next_actions: nextActions,
    decisions: toStringArray(obj.decisions).slice(0, 3),
    summary: toString(obj.summary),
  };
}

export function formatMeetingMinutesMarkdown(minutes: MeetingMinutesJson): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- 未確認");
  const actions = minutes.next_actions.length
    ? minutes.next_actions
        .map((a) => `- ${a.action}（担当: ${a.owner || "未確認"} / 期限: ${a.due || "未確認"}）`)
        .join("\n")
    : "- 未確認";
  return `# 商談議事録

## 決定事項サマリー
${minutes.summary || list(minutes.decisions)}

## 参加者
${list(minutes.participants)}

## 顧客の課題
${list(minutes.customer_issues)}

## 提案内容
${list(minutes.proposals)}

## ネクストアクション
${actions}

## 決定事項
${list(minutes.decisions)}
`;
}

// ============================================================
// STEP 1: 構造化（事実整理）
// ============================================================
export const STRUCTURE_PROMPT_VERSION = "20260924-bounded-structure-v2";
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
- 原文は後続の分析にも全文が渡される。ここでは重要な根拠を選び、全発言の再掲は禁止。
- speaker_turns は会話全体から重要な発言を最大12件選び、utterance は原文の連続した短い箇所（目安120文字以内）とする。冒頭だけを選ばない。条件や否定を途中で切って意味を変えない。
- key_facts は最大12件、各140文字以内を目安に要点をまとめる。訂正後の条件・未承認・条件付き希望・未確認の意味と話者を保持する。旧条件を残す場合は訂正前と明記する。
- key_facts の各事実は原文の対象・状態を保つ。複数の資料や媒体の状態を一つにまとめない。文字数が厳しい場合は事実を選び、否定や未承認を省いて意味を広げない。
- decisions は最大3件、open_questions は最大8件、各100文字以内を目安にする。明示された合意や質問がなければ空配列にする。営業の提案・他社の事例を顧客の確定事実に変えない。

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

  const result = await callClaudeJSON<Structured>({ feature: "context", system, user, maxTokens: 3000 });
  if (result && Array.isArray(result.speaker_turns)) return result;
  noteFallback("step1_structure");
  return fallbackStructured(transcript);
}

// ============================================================
// STEP 2: 営業分析（課題・BANT）
// ============================================================
export async function step2Analyze(
  transcript: string,
  structured: Structured,
  ctx: PipelineContext,
  trace?: PipelineResult["trace"],
): Promise<Analysis> {
  const system = `${COMMON_GUARDRAIL}

# 役割
営業分析担当。トランスクリプトとSTEP1の構造化結果から、課題・潜在ニーズ・リスク・BANTを抽出する。

${RECOMMENDATION_GUARDRAIL}

# BANT
${formatBantDefinitions()}
※不明な場合は「未確定: 〜を確認する必要あり」と書く
※各項目の金額・人物・日付は文字起こしに同じ記載がある場合だけ使う。推定で補完しない
※BANTは原文の事実・未確認事項・その理由だけを記録する。顧客の認識・意欲の評価や潜在ニーズの仮説をBANT本文に混ぜない。未確認の理由が未集計なら、その理由と不足の有無が不明であることを保持する
※Needは顧客が明示した課題・希望だけを記す。「不足しているか未集計で分からない」なら「未確認: 応募数は未集計のため不足の有無が不明」とする。「現状把握が必要な可能性」など営業側の支援仮説や確認作業を顧客ニーズへ昇格させない
※Needの自由記述は内部下書き。need_source_ids に主要な課題・希望、またはその有無が未確認であることを最も直接表す原文発言番号を1件選ぶ。公開Needはその発言全体（1200文字以内）の原文から構成する。課題一覧を転記せず、否定・理由・条件・訂正を含む主要な1発言を優先する。営業の質問・仮説や商材名だけを根拠にせず、根拠がなければ空配列にする
※原文にある仮額・目安・上限・承認未了は区別して残す。例えば「予算80万円を目安に検討、正式承認は未了」を金額なしの未確認に置き換えない
※顧客が以前の予算・導入時期を明示的に撤回し、現在は未定と述べた場合、現在のBANTは未確定にする。撤回済みの金額や日付を現行条件として使わない。単に今回話題に出なかった場合とは区別する
※Timelineは導入時期の根拠がある発言番号をtimeline_source_idsに列挙する。原文の番号だけを使い、該当しなければ空配列にする。導入可否が未決定・今回は情報交換という発言だけでは、時期が未定、検討段階ではない、意欲が低いとは分からない
※条件付き希望、予定、明示された未確認の理由は条件を含む発言全体を選ぶ。「導入するなら4月希望」を確定日へ変えない。明示的に時期を未検討と述べた場合はその発言を選ぶ。質問への短い回答なら質問・回答の番号を両方選ぶ。営業の質問・提案だけ、次回面談日、見積送付期限、承認会議日は導入時期の根拠にしない
※Timelineの自由記述は下書き。保存する値は検証済み原文から構成する。STEP1・過去編集・案件タイトル・商材の期間から発言番号を補わない
※入力のidは内部参照専用。発言番号はtimeline_source_ids・issue_source_ids・need_source_idsだけに出力し、BANT・hidden_needs・risksの文章に「(id: 4)」等の注釈を付けない。原文に実際にある業務上のIDはそのまま保持する
※issue_source_ids は顧客が実際に述べた課題・希望、または明示した未確認の条件がある発言番号を最大8件選ぶ。引用する発言全体の合計は2400文字以内を目安に、具体的な課題と重要な留保を優先する。営業の質問・仮説、案件の商材名、前段の要約を顧客課題の根拠にしない。話者の役割が不明な発言は顧客と推定しない
※issues の要約文や原文引用は生成しない。公開する課題・現状は選択した発言の原文全体から構成する。対象・述語・条件・否定を結合・省略しない。根拠がなければissue_source_idsは空配列にする
※hidden_needs と risks の推論は必ず「仮説」と明記し、未決定という事実だけで意欲や認識の低さを断定しない

# 出力スキーマ
{
  "issue_source_ids": [],
  "hidden_needs": ["..."],
  "risks": ["..."],
  "timeline_source_ids": [],
  "need_source_ids": [],
  "bant": {
    "budget": "...",
    "authority": "...",
    "need": "...",
    "timeline": "..."
  }
}`;
  const user = `${ctxBlock(ctx)}

# トランスクリプト（idは原文の発言番号。textは原文そのまま）
${JSON.stringify(timelineSourceTurns(transcript), null, 2)}

# STEP1構造化
${JSON.stringify(structured, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Omit<Analysis, "issues"> & { issues?: unknown; issue_source_ids?: unknown; timeline_source_ids?: unknown; need_source_ids?: unknown }>({ feature: "context", system, user, maxTokens: 2500 });
  if (r && r.bant) {
    trace?.push({ step: "step2_analysis_draft", input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: r });
    const { timeline_source_ids: sourceIds, issue_source_ids: issueSourceIds, need_source_ids: needSourceIds, ...draft } = r;
    const issueEvidence = groundIssueEvidence(transcript, issueSourceIds);
    trace?.push({ step: "evidence_guard_issues", input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: issueEvidence });
    const needEvidence = groundNeedEvidence(transcript, needSourceIds);
    trace?.push({ step: "evidence_guard_need", input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: needEvidence });
    let cleanedFields = 0;
    const clean = (value: string): string => {
      if (typeof value !== "string") return value;
      const result = stripGeneratedSourceReference(value, transcript);
      if (result !== value) cleanedFields++;
      return result;
    };
    const cleaned = { ...draft,
      issues: issueEvidence.issues,
      hidden_needs: Array.isArray(draft.hidden_needs) ? draft.hidden_needs.map(clean) : draft.hidden_needs,
      risks: Array.isArray(draft.risks) ? draft.risks.map(clean) : draft.risks,
      bant: { budget: clean(r.bant.budget), authority: clean(r.bant.authority),
        need: needEvidence.value, timeline: r.bant.timeline },
    };
    trace?.push({ step: "evidence_guard_source_references",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: { cleanedFields },
    });
    const timeline = groundTimeline(transcript, sourceIds);
    const budgetWithdrawal = findBantWithdrawal(transcript, "budget");
    trace?.push({ step: "evidence_guard_withdrawal", input: { promptVersion: SALES_REASONING_PROMPT_VERSION },
      output: { budget: budgetWithdrawal, timeline: timeline.withdrawal ?? null } });
    trace?.push({
      step: "evidence_guard_timeline",
      input: { rawTimeline: r.bant.timeline, sourceIds: sourceIds ?? null, promptVersion: SALES_REASONING_PROMPT_VERSION },
      output: timeline,
    });
    return { ...cleaned, bant: { ...cleaned.bant,
      budget: budgetWithdrawal?.value ?? cleaned.bant.budget,
      need: normalizeUnconfirmedNeed(cleaned.bant.need), timeline: timeline.value,
    } };
  }
  noteFallback("step2_analysis");
  return fallbackAnalysis(structured, transcript);
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
顧客が明示した意図、未確認事項、確認後に取り得る営業行動を整理する。

${RECOMMENDATION_GUARDRAIL}

# 思考順序（厳守）
1. 顧客の意図（real_intent）：明示された関心・懸念と、まだ確認できない点。発言の裏側の心理を決めつけない
2. 意思決定構造（decision_structure）：誰が／どう／いつ決めるか。文字起こしにない人物・段階は推定せず「未確認」とする
3. 失注リスク（risks）：確認できた条件・未確認事項に基づく条件付きの懸念。情報不足だけで失注や拒否の兆候としない
4. 勝ち筋（winning_scenario）：営業が確認すべき点と、条件が確認できた場合の提案手順。顧客の反応・導入を断定しない

# 守るべき原則
- 抽象論禁止（「関係構築が大切」のような）
- 「いつまでに」は文字起こしに期限がある場合だけ使い、無ければ期限を作らない
- 失注の兆候が確認できない場合はその旨を記し、懸念を書くときは未確認事項と条件を明示する
- 顧客の本音は断定しない。明示発言がなければ「仮説」または「未確認」とする
- 金額・日付・期限・競合・提供効果は文字起こしに同じ記載がある場合だけ使う

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
  const r = await callClaudeJSON<TopSales>({ feature: "context", system, user, maxTokens: 2000, temperature: 0.4 });
  if (r && r.real_intent) return normalizeTopSales(r);
  noteFallback("step3_top_sales");
  return fallbackTopSales(analysis, transcript);
}

/** TopSales も string フィールドに object が混入すると UI が落ちるので正規化。 */
function normalizeTopSales(t: TopSales): TopSales {
  const toStr = normalizeStrategyText;
  const risksRaw = (t as unknown as { risks?: unknown }).risks;
  const risks: string[] = Array.isArray(risksRaw) ? risksRaw.map(toStr) : [];
  return {
    real_intent: toStr(t.real_intent),
    decision_structure: toStr(t.decision_structure),
    risks,
    winning_scenario: toStr(t.winning_scenario),
  };
}

// ============================================================
// STEP 4: 戦略設計
// ============================================================
export async function step4Strategy(
  topSales: TopSales,
  analysis: Analysis,
  ctx: PipelineContext,
  transcript = "",
): Promise<Strategy> {
  const system = `${COMMON_GUARDRAIL}

# 役割
受注確率を最大化する戦略を設計する。

${RECOMMENDATION_GUARDRAIL}

# 制約
- 顧客が言っていない効果、競合状況、決裁工程、金額、日付、期限を作らない
- 根拠がない内容は「仮説」または「未確認」と明記する
- strategy、differentiation、closing_plan はすべて日本語の文章の文字列で返す。closing_plan は必要な手順を改行して記し、配列・オブジェクトやJSONを文字列に埋め込まない。

# 出力スキーマ
{
  "strategy": "全体戦略（1〜2文）",
  "differentiation": "確認できる提供価値と比較に必要な確認事項。競合情報がなければ比較は未確認",
  "closing_plan": "次に確認する事項と、条件が確認できた場合の提案手順。原文にない期間や合意を作らない"
}`;
  const user = `${ctxBlock(ctx)}

# 今回の文字起こし（一次根拠）
${transcript || "原文未提供。前段の推測を新たな事実として使わない。"}

# STEP2分析
${JSON.stringify(analysis, null, 2)}

# STEP3トップ営業思考
${JSON.stringify(topSales, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Strategy>({ feature: "context", system, user, maxTokens: 1500 });
  if (r && r.strategy) return normalizeStrategy(r);
  noteFallback("step4_strategy");
  return fallbackStrategy(topSales, transcript);
}

/**
 * Strategy の各フィールドは UI 側で `<p>{...}</p>` 直接レンダリングしているため
 * 文字列でなければならない。AI（Claude）が closing_plan に { week1: ..., week2: ... }
 * のようなネストオブジェクトを返してくるケースが本番で観測されたので、
 * オブジェクト/配列は意味のあるラベルと文章へ変換してから根拠の補正を行う。
 */
function normalizeStrategy(s: Strategy): Strategy {
  const toStr = normalizeStrategyText;
  return {
    strategy: toStr(s.strategy),
    differentiation: toStr(s.differentiation),
    closing_plan: toStr(s.closing_plan),
  };
}

// ============================================================
// STEP 5: Next Action生成
// ============================================================
export async function step5NextActions(
  topSales: TopSales,
  strategy: Strategy,
  analysis: Analysis,
  ctx: PipelineContext,
  transcript = "",
): Promise<{ next_actions: NextActionDraft[] }> {
  const system = `${COMMON_GUARDRAIL}

# 役割
営業担当が次に行う、根拠のある確認・提案行動を必要な件数だけ生成する。情報不足なら件数を埋めるために提案を作らない。

${RECOMMENDATION_GUARDRAIL}

# 制約（厳守）
- 対象のない抽象的な行動だけにしない。原文の留保を保ち、誰が何を確認・作成するかを明確にする。条件付きの検討は、その条件と確認対象を記す
- 必ず「動詞＋目的語」を含める。期限は文字起こしに同じ期限がある場合だけ含める
- 主語は「営業担当」。誰が動くか明確にする
- impactは受注確度への寄与度
- priorityは「今すぐ着手すべき度合い」
- 決裁者・稟議・競合・期限は今回の文字起こしに対応する発言がある場合だけ事実として使う。前段の生成文はそれだけでは根拠にならない
- 根拠がない場合は、未確認事項を確認するアクションにする
- 文字起こしに期限がなければ、1日・48時間・今週中などの期限を補わない
- reason は内部の下書き。各行動の reason_source_ids に、その行動を考える根拠となった原文発言番号を最大2件選ぶ。公開する理由文は選ばれた発言全体の原文から構成するため、原文を要約・言い換えして引用しない。選択する原文の合計は1200文字以内とし、条件・否定・理由・訂正を含む発言を優先する
- reason_source_ids には今回の原文の id だけを使う。営業の提案・質問を参照することは可能だが、顧客の発言や合意に変えない。話者不明は推定しない。根拠がなければ [] とする。発言番号を action・reason・expected_outcome の文章へ書き込まない

${SALES_FEWSHOT_INTERPRETATION}

# 出力スキーマ
{
  "next_actions": [
    {
      "action": "...",
      "priority": "high|medium|low",
      "impact": "high|medium|low",
      "reason": "...",
      "reason_source_ids": [],
      "expected_outcome": "..."
    }
  ]
}`;
  const user = `${ctxBlock(ctx)}

# 今回の文字起こし（idは内部参照専用の原文発言番号。textは一次根拠の原文）
${transcript ? JSON.stringify(timelineSourceTurns(transcript), null, 2) : "原文未提供。前段の推測を新たな事実として使わない。"}

# STEP2分析
${JSON.stringify(analysis, null, 2)}

# STEP3トップ営業思考
${JSON.stringify(topSales, null, 2)}

# STEP4戦略
${JSON.stringify(strategy, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<{ next_actions: NextActionDraft[] }>({
    feature: "context",
    system,
    user,
    maxTokens: 2500,
    temperature: 0.4,
  });
  if (r && Array.isArray(r.next_actions)) {
    return { next_actions: r.next_actions.map(normalizeNextAction) };
  }
  noteFallback("step5_next_actions");
  const fallback = fallbackNextActions(strategy, topSales, transcript);
  deterministicActionDrafts.add(fallback);
  return fallback;
}

/** NextAction の各 string フィールドに object が入るケースをガード。 */
function normalizeNextAction(a: NextActionDraft): NextActionDraft {
  const toStr = normalizeStrategyText;
  const prio = (a as unknown as { priority?: unknown }).priority;
  const imp = (a as unknown as { impact?: unknown }).impact;
  const safePrio: NextAction["priority"] =
    prio === "high" || prio === "medium" || prio === "low" ? prio : "medium";
  const safeImp: NextAction["impact"] =
    imp === "high" || imp === "medium" || imp === "low" ? imp : "medium";
  return {
    action: toStr(a.action),
    priority: safePrio,
    impact: safeImp,
    reason: toStr(a.reason),
    ...(Object.hasOwn(a, "reason_source_ids") ? { reason_source_ids: a.reason_source_ids } : {}),
    expected_outcome: toStr(a.expected_outcome),
  };
}

// ============================================================
// STEP 6: スコアリング
// ============================================================
export const SCORE_PROMPT_VERSION = "20260924-bounded-scores-v1";
const SCORE_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    scores: {
      type: "OBJECT",
      properties: {
        actionability: { type: "INTEGER", minimum: 1, maximum: 5 },
        specificity: { type: "INTEGER", minimum: 1, maximum: 5 },
        impact: { type: "INTEGER", minimum: 1, maximum: 5 },
      },
      required: ["actionability", "specificity", "impact"],
    },
  },
  required: ["scores"],
};
export async function step6Score(actions: { next_actions: NextAction[] }, transcript = ""): Promise<Scores> {
  const system = `${COMMON_GUARDRAIL}

${RECOMMENDATION_GUARDRAIL}

# 役割
Next Actionの品質を1〜5で評価する。

# 評価基準
- actionability: 1=曖昧 / 5=今日中に着手可能
- specificity: 1=抽象的 / 5=「誰が・何を確認/提案するか」が明確。原文に期限がなければ期限なしで満点にできる
- impact: 1=効果が読めない / 5=顧客の判断や次の確認に必要な情報を得られる
- 原文にない期限・顧客の心理・課題・合意、確認していない価格や提供可否を追加していればspecificityを低く評価する。根拠のない具体化を評価しない

# 出力形式（厳守）
全アクションを総合評価し、1〜5の整数を3つだけ返す。アクション別の配列、説明文、理由、原文引用、分析過程、アクション本文の再掲は禁止。
返すキーはscores、その中のactionability・specificity・impactのみ。次は形の例であり、点数は上記基準に従って評価する。
{"scores":{"actionability":3,"specificity":3,"impact":3}}`;
  const user = `# 今回の文字起こし（一次根拠）
${transcript || "原文未提供。期限などの事実の根拠は未確認。"}

# Next Actions
${JSON.stringify(actions, null, 2)}

JSONのみ出力。`;
  const r = await callClaudeJSON<Scores>({ feature: "context", system, user, maxTokens: 400, responseSchema: SCORE_RESPONSE_SCHEMA });
  if (r) {
    const scores = r.scores;
    if (!scores || ![scores.actionability, scores.specificity, scores.impact].every(value => Number.isInteger(value) && value >= 1 && value <= 5)) {
      throw new Error("AIの採点結果が不正です。分析を再実行してください。");
    }
    return { scores: { actionability: scores.actionability, specificity: scores.specificity, impact: scores.impact } };
  }
  noteFallback("step6_scores");
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
  transcript = "",
): Promise<{ next_actions: NextActionDraft[] } | null> {
  const min = Math.min(scores.scores.actionability, scores.scores.specificity, scores.scores.impact);
  if (min >= 4) return null;

  const system = `${COMMON_GUARDRAIL}

# 役割
直前のNext Actionは品質が不足。**より具体的に**書き直す。

${RECOMMENDATION_GUARDRAIL}

# 改善ルール
- 期限は今回の原文で対応する行動に明示された値だけを使う。期限が不明なら「期限未確認」とし、今日中・48時間以内・今週中などを補わない
- すべての action に「主語＋動詞＋目的語」を入れる
- expected_outcome に「定量／定性の到達点」を入れる
- 対象のない抽象的な行動だけにしない。確認できた条件に基づく検討は可能
- 根拠のある行動と留保は保持し、不明瞭な対象や手順を明確にする。具体性のために事実・期限・結果を追加しない
- reason は内部の下書き。各行動の reason_source_ids に、その行動を考える根拠となった今回の原文発言番号を最大2件選び直す。公開理由文は発言全体の原文から構成する。選択する原文の合計は1200文字以内とし、条件・否定・理由・訂正を省略しない
- 営業の質問・提案を参照することは可能だが、顧客の発言や合意に変えない。前段の生成文を根拠にせず、原文の id だけを使う。根拠がなければ reason_source_ids は [] とする。発言番号を action・reason・expected_outcome の文章へ書き込まない

${SALES_FEWSHOT_INTERPRETATION}

# 出力スキーマ
{
  "next_actions": [
    { "action": "...", "priority": "...", "impact": "...", "reason": "...", "reason_source_ids": [], "expected_outcome": "..." }
  ]
}`;
  const user = `# 案件
${ctxBlock(ctx)}

# 今回の文字起こし（idは内部参照専用の原文発言番号。textは一次根拠の原文）
${transcript ? JSON.stringify(timelineSourceTurns(transcript), null, 2) : "原文未提供。前段の推測を新たな事実として使わない。"}

# 直前のNext Actions（スコア不足: ${JSON.stringify(scores.scores)}）
${JSON.stringify(actions, null, 2)}

# 戦略コンテキスト
${JSON.stringify({ topSales, strategy, analysis }, null, 2)}

JSONのみ出力。原文の根拠と留保を保ち、確認・作成する対象を明確にする。`;
  const r = await callClaudeJSON<{ next_actions: NextActionDraft[] }>({
    feature: "context",
    system,
    user,
    maxTokens: 2500,
    temperature: 0.5,
  });
  if (r && Array.isArray(r.next_actions)) {
    return { next_actions: r.next_actions.map(normalizeNextAction) };
  }
  return null;
}

// ============================================================
// フォールバックの可視化
//
// 全段に決定論フォールバックが入っているため、認証がコケても例外にならず
// 劣化出力がそのまま保存される。どの段が落ちたかを残さないと移行の失敗に
// 気づけないので、run ごとに記録する。
// ============================================================

let _fallbackSteps: string[] = [];

function noteFallback(step: string): void {
  const backend = process.env.GOOGLE_AI_BACKEND ?? "aistudio";
  console.warn(`[ai-fallback] step=${step} backend=${backend}`);
  _fallbackSteps.push(step);
}

// ============================================================
// 未確認の課題から、顧客心理・提供可能な商材・期限を推定しない。
// 元のAI案は各STEPのtraceに保持し、表示・保存する推奨だけを制約する。
export function constrainUnconfirmedNeedRecommendations(
  analysis: Analysis,
  topSales: TopSales,
  strategy: Strategy,
  nextActions: { next_actions: NextAction[] },
  scores: Scores,
) {
  const need = normalizeUnconfirmedNeed(analysis.bant.need);
  const uncertainNeed = isUnknownBantValue(need) || /^(?:仮説|推測|推定)(?:[:：\s]|$)/u.test(need.trim());
  if (!uncertainNeed) return { analysis, topSales, strategy, nextActions, scores, applied: false };

  const conditionalRisk = "顧客の課題や条件を確認しないまま提案すると、顧客の状況に合わない可能性がある。未確認という理由だけで失注の兆候とは判断しない。";
  const confirmationPlan = "営業は、議事録で確認できる顧客の発言と未確認事項を整理する。顧客の具体的な課題・希望と導入条件を確認し、自社で対応可能かを確認できた場合に提案内容を検討する。";
  return {
    analysis: {
      ...analysis,
      bant: { ...analysis.bant, need },
      issues: ["具体的な顧客課題は未確認。原文の発言を確認し、課題の有無を確認する必要がある。"],
      hidden_needs: [],
      risks: [conditionalRisk],
    },
    topSales: {
      real_intent: "具体的な顧客課題は未確認。原文の発言と未確認事項を区別し、顧客の認識や導入意欲を断定しない。",
      decision_structure: "原文で確認できる決裁・承認情報を参照し、未確認の部分を確認する。",
      risks: [conditionalRisk],
      winning_scenario: confirmationPlan,
    },
    strategy: {
      strategy: confirmationPlan,
      differentiation: "顧客の課題・希望と比較条件、自社の提供範囲を確認した後に、根拠を示せる提案内容を整理する。",
      closing_plan: "議事録に顧客の連絡予定や合意事項がある場合は、その内容を確認し、未確認事項の確認方法を検討する。次回日程や期限は顧客と確認して決める。",
    },
    nextActions: { next_actions: [
      {
        action: "営業は、原文で確認できる顧客の発言を整理し、具体的な課題と未確認の導入条件を確認するための質問を作成する。連絡予定や合意事項が原文にある場合は、その内容を踏まえて確認方法を検討する。",
        priority: "high" as const,
        impact: "medium" as const,
        reason: "具体的な顧客課題が確認できていないため。",
        expected_outcome: "確認済みの情報と未確認事項を区別した質問が整理される。",
      },
      {
        action: "営業は、利用できる事例資料・情報源の有無と内容、商材の価格・提供範囲を社内で確認する。顧客の課題と条件が確認でき、対応可能な場合に提案内容を検討する。",
        priority: "medium" as const,
        impact: "medium" as const,
        reason: "資料の存在や、顧客の予算内で提供できる範囲を前提にしないため。",
        expected_outcome: "根拠を示せる資料と提供条件が整理され、提案可否を判断できる。",
      },
    ] },
    // 確認作業の一般的な案であり、案件固有の提案として高評価しない。
    scores: { scores: { actionability: 3, specificity: 3, impact: 2 } },
    applied: true,
  };
}

// ============================================================
// 全段ランナー
// ============================================================
export async function runPipeline(
  rawTranscript: string,
  ctx: PipelineContext,
): Promise<PipelineResult> {
  // T04: 改行せずに1行で返された・保存された文字起こしでも、議事録と BANT の根拠照合が発話単位で行えるよう、
  // 行の途中の話者ラベルで分けてから全段に渡す（話者ラベルの無い文を推測で分けることはしない）。
  const transcript = splitRunOnSpeakerTurns(rawTranscript);
  const trace: PipelineResult["trace"] = [];
  // プロバイダ抽象化済み：AI_PROVIDER に応じて Gemini or Anthropic の設定有無を見る
  const hasKey = hasAiTextKey();
  _fallbackSteps = [];

  const meetingMinutes = await generateMeetingMinutes(transcript, ctx);
  trace.push({
    step: "t05_meeting_minutes",
    input: { transcript_excerpt: transcript.slice(0, 200), companyName: ctx.companyName, promptVersion: meetingMinutes.promptVersion },
    output: { json: meetingMinutes.json, usedFallback: meetingMinutes.usedFallback, usage: meetingMinutes.usage,
      ...(meetingMinutes.sourceCaveats ? { sourceCaveats: meetingMinutes.sourceCaveats, generatedSummary: meetingMinutes.generatedSummary } : {}),
      ...(meetingMinutes.proposalAudit ? { proposalAudit: meetingMinutes.proposalAudit } : {}),
      ...(meetingMinutes.issueAudit ? { issueAudit: meetingMinutes.issueAudit } : {}),
      ...(meetingMinutes.actionAudit ? { actionAudit: meetingMinutes.actionAudit } : {}),
      ...(meetingMinutes.participantAudit ? { participantAudit: meetingMinutes.participantAudit } : {}),
    },
  });

  if (!hasBusinessEvidence(transcript)) {
    const structured = fallbackStructured(transcript);
    const safe = buildEvidenceSafeFallback(transcript);
    const scores = fallbackScores(safe.nextActions);
    trace.push({
      step: "evidence_guard_no_business_context",
      input: { transcript_excerpt: transcript.slice(0, 200) },
      output: safe,
    });
    return {
      meetingMinutes,
      structured,
      ...safe,
      scores,
      improved: false,
      fallback: true,
      fallbackSteps: [..._fallbackSteps, "evidence_guard_no_business_context"],
      backend: process.env.GOOGLE_AI_BACKEND ?? "aistudio",
      trace,
    };
  }

  const structured = await step1Structure(transcript, ctx);
  trace.push({ step: "step1_structure", input: { transcript_excerpt: transcript.slice(0, 200), promptVersion: STRUCTURE_PROMPT_VERSION }, output: structured });

  const analysis = await step2Analyze(transcript, structured, ctx, trace);
  trace.push({ step: "step2_analysis", input: { structured, promptVersion: SALES_REASONING_PROMPT_VERSION }, output: analysis });

  const topSales = await step3TopSales(transcript, structured, analysis, ctx);
  trace.push({ step: "step3_top_sales", input: { analysis, promptVersion: SALES_REASONING_PROMPT_VERSION }, output: topSales });

  const strategy = await step4Strategy(topSales, analysis, ctx, transcript);
  trace.push({ step: "step4_strategy", input: { topSales, promptVersion: SALES_REASONING_PROMPT_VERSION }, output: strategy });

  let nextActions = await step5NextActions(topSales, strategy, analysis, ctx, transcript);
  let modelActionReasons = !deterministicActionDrafts.has(nextActions);
  trace.push({ step: "step5_next_actions", input: { strategy, promptVersion: SALES_REASONING_PROMPT_VERSION }, output: nextActions });

  const scores = await step6Score(nextActions, transcript);
  trace.push({ step: "step6_scores", input: { nextActions, promptVersion: SALES_REASONING_PROMPT_VERSION, scorePromptVersion: SCORE_PROMPT_VERSION }, output: scores });

  const improved = await step7SelfImprove(nextActions, scores, topSales, strategy, analysis, ctx, transcript);
  if (improved) {
    nextActions = improved;
    modelActionReasons = true;
    trace.push({ step: "step7_self_improved", input: { scores, promptVersion: SALES_REASONING_PROMPT_VERSION }, output: improved });
  }

  const evidenceSafeFallbackUsed =
    topSales.real_intent === "未確認: 顧客の本音は文字起こしから断定しない" ||
    strategy.differentiation === "未確認: 競合・代替案の情報なし";

  const constrained = constrainUnconfirmedNeedRecommendations(analysis, topSales, strategy, nextActions, scores);
  if (constrained.applied) {
    trace.push({
      step: "evidence_guard_unconfirmed_need",
      input: { bant: analysis.bant, promptVersion: SALES_REASONING_PROMPT_VERSION },
      output: constrained,
    });
  }

  const sourceReferences = stripRecommendationSourceReferences(transcript, {
    topSales: constrained.topSales, strategy: constrained.strategy, nextActions: constrained.nextActions,
  });
  if (sourceReferences.applied) {
    trace.push({ step: "evidence_guard_recommendation_references",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: sourceReferences });
  }
  const causalEvidence = constrainUnverifiedCausalRecommendations(transcript, sourceReferences.value);
  if (causalEvidence.applied) {
    trace.push({ step: "evidence_guard_unverified_cause",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION }, output: causalEvidence });
  }
  const offerEvidence = constrainOfferEvidence(transcript, causalEvidence.value);
  if (offerEvidence.applied) {
    trace.push({
      step: "evidence_guard_unverified_offer",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION },
      output: offerEvidence,
    });
  }

  const deadlineEvidence = constrainUnagreedSubmissionDeadline(transcript, offerEvidence.value);
  if (deadlineEvidence.applied) {
    trace.push({
      step: "evidence_guard_unagreed_deadline",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION, deadlineGuardVersion: "20260924-unagreed-submission-v6" },
      output: deadlineEvidence,
    });
  }

  const actionOutcomes = constrainActionOutcomes(deadlineEvidence.value.nextActions);
  if (actionOutcomes.applied) {
    trace.push({
      step: "evidence_guard_action_outcome",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION, outcomeGuardVersion: "20260924-material-availability-v1" },
      output: actionOutcomes,
    });
  }

  // A conditional date does not establish that adoption is under consideration.
  // Keep this bounded case as a complete literal customer turn;
  // preserve the model's original STEP3 and earlier guards in trace for review.
  // Do this last so no recommendation rewriting can alter text labeled original.
  const adoptionConditions = customerAdoptionConditions(transcript);
  let qualifiedTopSales = deadlineEvidence.value.topSales;
  const turns = [...new Set(adoptionConditions.map(({ turn }) => turn))];
  const verifiedIntent = `顧客が明示した内容（原文）: ${turns.join("\n")}`;
  if (adoptionConditions.length && qualifiedTopSales.real_intent !== verifiedIntent) {
    qualifiedTopSales = { ...qualifiedTopSales, real_intent: verifiedIntent };
    trace.push({
      step: "evidence_guard_conditional_adoption",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION, quotes: adoptionConditions.map(({ quote }) => quote) },
      output: { topSales: qualifiedTopSales, applied: true },
    });
  }

  // Project source passages after every rewriting guard so public quotations
  // cannot be altered. Provider candidates remain in the earlier step traces.
  let publicActions = actionOutcomes.value;
  if (!constrained.applied && modelActionReasons) {
    const actionReasons = groundActionReasons(transcript, actionOutcomes.value);
    publicActions = actionReasons.value;
    trace.push({
      step: "evidence_guard_action_reasons",
      input: { promptVersion: SALES_REASONING_PROMPT_VERSION, candidates: actionOutcomes.value },
      output: actionReasons,
    });
  }

  const fallbackSteps = [..._fallbackSteps];

  return {
    meetingMinutes,
    structured,
    analysis: constrained.analysis,
    topSales: qualifiedTopSales,
    strategy: deadlineEvidence.value.strategy,
    nextActions: publicActions,
    scores: constrained.scores,
    improved: !!improved,
    // 旧実装は `!hasKey` だけを見ていたため、設定があって全段失敗しても false を返していた。
    // それでは Vertex 移行で認証がコケても検知できない。
    fallback: !hasKey || fallbackSteps.length > 0 || meetingMinutes.usedFallback || evidenceSafeFallbackUsed,
    fallbackSteps,
    backend: process.env.GOOGLE_AI_BACKEND ?? "aistudio",
    ...(constrained.applied ? { recommendationGuard: "unconfirmed-need" as const } : {}),
    trace,
  };
}

// ============================================================
// フォールバック実装（API key無し or 失敗時）
// MVPでも UI 動作確認できるように、議事録から決定論的に意味のある出力を作る
// ============================================================
// The offline fallback only lists explicit, affirmative decisions. Questions and
// unresolved or negative statements must not become meeting agreements.
function isAffirmedDecision(line: string): boolean {
  return /(決定|合意|確定|進める|了承)/u.test(line)
    && !/[?？]|未確定|未決定|未合意|未了承|未定|していない|していません|しない|しません|できない|できません|ではない|ではありません|至っていない|至っていません|まだ/u.test(line);
}

function isUnconfirmedStatement(line: string): boolean {
  return /[?？]|未確認|未確定|未定|不明|分かりません|わかりません|分からない|わからない|決めていません|決まっていません|していません|していない|しません|しない|ではありません|ではない/u.test(line);
}

// Offline output remains extractive: a question or a missing value is not a
// promised action. Keep the contact promise separate from a following refusal
// to set a date, and never invent a follow-up task when no promise was spoken.
function explicitFollowUpStatements(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const speaker = line.match(/^([^:：]{1,24}[:：])\s*/u);
    const body = speaker ? line.slice(speaker[0].length) : line;
    return (body.match(/[^。！？!?]+[。！？!?]?/gu) ?? [])
      .map((sentence) => sentence.trim())
      .filter((sentence) => !isUnconfirmedStatement(sentence)
        && /(確認|連絡|送付|共有|提出|回答|調整|相談|準備|対応|作成).*(します|いたします|する予定です|しておきます|送ります)([。！!]|$)/u.test(sentence))
      .map((sentence) => `${speaker?.[1] ?? ""}${sentence}`);
  }).slice(0, 5);
}

function fallbackMeetingMinutes(transcript: string): MeetingMinutesJson {
  const lines = transcript
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const participants = Array.from(
    new Set(
      lines
        .map((line) => line.match(/^([^:：]{1,24})[:：]/)?.[1]?.trim())
        .filter((v): v is string => !!v),
    ),
  ).slice(0, 8);
  const customerIssues = lines
    .filter((l) => !/^(営業|当社|弊社)[:：]/u.test(l) && !isUnconfirmedStatement(l)
      && /(課題|困|悩|不足|できない|難しい|問題|懸念|不安)/.test(l))
    .slice(0, 5);
  const proposals = lines
    .filter((l) => /^(営業|当社|弊社)[:：]/u.test(l) && !isUnconfirmedStatement(l)
      && /(提案|おすすめ|お勧め|支援|ご提供|できます)/u.test(l))
    .slice(0, 5);
  const decisions = lines.filter(isAffirmedDecision).slice(0, 3);
  const nextActionLines = explicitFollowUpStatements(lines);

  return {
    participants: participants.length ? participants : ["未確認"],
    customer_issues: customerIssues.length ? customerIssues : ["未確認"],
    proposals,
    next_actions: nextActionLines.map((line) => ({ action: line, owner: "未確認", due: "未確認" })),
    decisions: decisions.length ? decisions : ["明確な決定事項は文字起こしから確認できませんでした"],
    summary: decisions.length
      ? decisions.join("\n")
      : "明確な決定事項は未確認です。参加者・課題・提案・次回アクションを確認してください。",
  };
}

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
  const decisions = lines.filter(isAffirmedDecision).slice(0, 5);
  const questions = lines.filter((l) => l.endsWith("?") || l.endsWith("？") || /未確定|宿題|確認/.test(l)).slice(0, 5);
  return {
    speaker_turns: turns.slice(0, 30),
    key_facts: facts.length ? facts : ["（議事録からキー事実は抽出できず／AIキー未設定）"],
    decisions: decisions.length ? decisions : ["（明確な決定事項は無し）"],
    open_questions: questions.length ? questions : ["決裁者の参加可否", "予算枠／会計年度", "導入希望時期"],
  };
}

function transcriptLines(transcript: string): string[] {
  return transcript
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function hasBusinessEvidence(transcript: string): boolean {
  return /予算|費用|見積|決裁|承認|稟議|課題|提案|導入|契約|発注|顧客|商談|納期|業務|改善|KPI|次回会議/u.test(
    transcript,
  );
}

function evidenceLines(transcript: string, pattern: RegExp, limit = 2): string[] {
  return transcriptLines(transcript).filter((line) => pattern.test(line)).slice(0, limit);
}

function evidenceValue(lines: string[], unknownLabel: string): string {
  return lines.length > 0 ? `文字起こし記載: ${lines.join(" / ")}` : `未確認: ${unknownLabel}`;
}

export function buildEvidenceSafeFallback(transcript: string): {
  analysis: Analysis;
  topSales: TopSales;
  strategy: Strategy;
  nextActions: { next_actions: NextAction[] };
} {
  const budget = evidenceLines(transcript, /予算|費用|金額|見積|円/u);
  const authority = evidenceLines(transcript, /決裁|導入判断|承認|稟議|取締役会|経営会議|投資会議/u);
  const need = evidenceLines(
    transcript,
    /課題|困|難し|散在|追え|遅延|期限超過|不足|減ら|目標|辞退|採用でき|伝わりにく/u,
    3,
  );
  const timeline = groundTimeline(transcript, timelineSourceTurns(transcript).map((turn) => turn.id));
  const explicitRisks = evidenceLines(transcript, /懸念|リスク|不安|期限超過|散在|追えない/u, 3);
  const actionEvidence = evidenceLines(
    transcript,
    /までに.*(?:送付|提出|準備|確認|行)|次回.*(?:確認|レビュー)|(?:送付|提出|準備)します/u,
    3,
  );

  const analysis: Analysis = {
    issues: need.length > 0 ? need.map((line) => `文字起こし記載: ${line}`) : ["未確認: 顧客課題の明示なし"],
    hidden_needs: ["未確認: 潜在ニーズは文字起こしから断定しない"],
    risks:
      explicitRisks.length > 0
        ? explicitRisks.map((line) => `文字起こし記載: ${line}`)
        : ["未確認: 失注リスクの明示なし"],
    bant: {
      budget: findBantWithdrawal(transcript, "budget")?.value ?? evidenceValue(budget, "予算・金額の明示なし"),
      authority: evidenceValue(authority, "決裁者・決裁工程の明示なし"),
      need: evidenceValue(need, "顧客ニーズの明示なし"),
      timeline: timeline.value,
    },
  };

  const topSales: TopSales = {
    real_intent: "未確認: 顧客の本音は文字起こしから断定しない",
    decision_structure: evidenceValue(authority, "意思決定構造の明示なし"),
    risks: analysis.risks,
    winning_scenario: "仮説: 文字起こしに明示された課題と次回アクションを確認し、未確認事項を埋める",
  };

  const strategy: Strategy = {
    strategy: "仮説: 文字起こしに明示された顧客課題と合意事項を基に次回提案を組み立てる",
    differentiation: "未確認: 競合・代替案の情報なし",
    closing_plan: "仮説: 文字起こしに明示された次回アクションを優先し、未確認の決裁条件は次回確認する",
  };

  const nextActions = {
    next_actions:
      actionEvidence.length > 0
        ? actionEvidence.map(
            (line): NextAction => ({
              action: `文字起こし記載の対応を実行: ${line}`,
              priority: "medium",
              impact: "medium",
              reason: "文字起こしに明示された対応事項",
              expected_outcome: "文字起こしで合意・提示された対応の実行",
            }),
          )
        : [
            {
              action: "次回商談で未確認のBANT項目と次の対応を確認する",
              priority: "medium" as const,
              impact: "medium" as const,
              reason: "文字起こしに具体的な次回対応の明示がない",
              expected_outcome: "未確認事項と担当・期限の明確化",
            },
          ],
  };

  return { analysis, topSales, strategy, nextActions };
}

function fallbackAnalysis(_s: Structured, transcript: string): Analysis {
  return buildEvidenceSafeFallback(transcript).analysis;
}

function fallbackTopSales(_a: Analysis, transcript: string): TopSales {
  return buildEvidenceSafeFallback(transcript).topSales;
}

function fallbackStrategy(_t: TopSales, transcript: string): Strategy {
  return buildEvidenceSafeFallback(transcript).strategy;
}

function fallbackNextActions(
  _s: Strategy,
  _t: TopSales,
  transcript: string,
): { next_actions: NextAction[] } {
  return buildEvidenceSafeFallback(transcript).nextActions;
}

function fallbackScores(_a: { next_actions: NextAction[] }): Scores {
  return { scores: { actionability: 4, specificity: 4, impact: 4 } };
}

// ヘルパー: 単発のJSONリトライパース
export function safeParse<T>(text: string): T | null {
  return tryParseJSON<T>(text);
}
