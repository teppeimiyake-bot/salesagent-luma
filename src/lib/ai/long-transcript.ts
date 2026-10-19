/**
 * T04/T22: 長時間録音の文字起こし・長い議事録を、既存の分析パイプラインに渡せる大きさの「原文抜粋」にする（純関数のみ）。
 *
 * 検証用の Vertex は1回の入力を65,536バイトに制限している。分析パイプラインは本文を最大8回送り、
 * 後段ほど前段の結果が重なるため、日本語で約1万字を超える本文はそのままでは分析できない。
 * そこで区間ごとに AI へ「関係する発言の番号と、その発言の文字どおりの一部」を選ばせ、アプリ側で
 * 原文との一致を確かめた発言だけを種にして、原文の文字どおりの抜粋を作る。要約・言い換えは使わない。
 *
 * 抜粋は、後段の根拠照合（撤回の判定・時期の根拠・課題の原文引用）が原文と同じように働くよう、
 * 種の発言が属する「話者の塊」（同じ話者ラベルの連続した行と、ラベルなしの継続行）を丸ごと含める。
 * 原文で隣り合う塊は空行なしで並べ、隣り合わない所にだけ空行を1行入れる。長い行（1行の段落など）は
 * 文末で原文どおりの断片に分けて扱い、同じ行の連続した断片は元の文字列のままつなぐ。
 */
import { createHash } from "node:crypto";
import { timelineSourceTurns, type TimelineSourceTurn } from "./timeline-evidence";
import { bantWithdrawalEvidenceLines } from "./bant-withdrawal";
import { uninvestigated as causalUninvestigated, verified as causalVerified } from "./causal-evidence";
import { nextMeetingMention } from "./customer-conditions";

/** 抽出の指示・発言の番号の付け方を変えたら上げる（保存済みの抜粋は作り直す）。 */
export const LONG_ANALYSIS_EXTRACT_PROMPT_VERSION = "20260928-verbatim-extract-v2";
/** 抜粋本文を発言JSONにしたときの目安（最も大きい STEP7 でも固定部分を足して上限内に収まる大きさ）。 */
export const LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES = 22_000;
/** 入力上限で抜粋を小さくするときの下限。これより小さい抜粋では議事録・BANTに使える発言が少なすぎる。 */
export const LONG_ANALYSIS_MIN_TARGET_TURNS_JSON_BYTES = 8_000;
/** 抽出1回で送る区間の発言JSONの上限（指示文を足しても約27KB）。 */
export const LONG_ANALYSIS_CHUNK_TURNS_JSON_BYTES = 24_000;
/**
 * 長い記録の分析で受け付ける本文の上限（発言JSON。180分の文字起こしの約1.6倍・約14区間）。
 * これを超える記録は AI を呼ばずに止め、分けて登録してもらう（抽出の回数と費用が本文に比例して増えるため）。
 */
export const LONG_ANALYSIS_MAX_SOURCE_TURNS_JSON_BYTES = 320_000;
/** これより長い行は、文末（。！？）で原文どおりの断片に分けて抽出・抜粋の単位にする。 */
export const LONG_LINE_UNIT_CHARS = 200;
/** 1回あたりの入力上限（vertex-policy.ts の VERTEX_MAX_INPUT_BYTES と同じ値。値を変える場合は両方）。 */
const SINGLE_CALL_INPUT_BYTES = 65_536;
/** 議事録生成の固定部分（system と会社名など）の下限。これと本文だけで上限を超えるなら、全文では必ず失敗する。 */
const MINUTES_FIXED_LOWER_BOUND_BYTES = 8_500;
const MAX_SELECTIONS_PER_CHUNK = 80;

export const EXTRACT_TOPICS = [
  "budget", "authority", "need", "timeline", "condition", "decision", "proposal", "next_action", "change", "uncertainty",
] as const;
export type ExtractTopic = (typeof EXTRACT_TOPICS)[number] | "keep" | "guard" | "context";

export type LongChunk = { index: number; startId: number; endId: number };
export type LineSelection = { id: number; topics: ExtractTopic[] };
export type SelectionStats = { accepted: number; relocated: number; rejected: { invalid_id: number; not_verbatim: number; duplicate: number } };

/** 抽出・抜粋の単位。通常は空でない1行で、長い行だけ文末で分けた原文どおりの断片。id は全文の通し番号。 */
export type AnalysisUnit = TimelineSourceTurn & { line: number; start: number; end: number; lineLength: number; run: number };

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function turnJsonBytes(turn: TimelineSourceTurn) {
  // JSON.stringify(turns, null, 2) の1要素ぶん（区切りの ",\n" を含む）。
  return Buffer.byteLength(`  {\n    "id": ${turn.id},\n    "text": ${JSON.stringify(turn.text)}\n  },\n`, "utf8");
}

export function turnsJsonBytes(turns: TimelineSourceTurn[]) {
  return Buffer.byteLength(JSON.stringify(turns, null, 2), "utf8");
}

/** 全文のままでは議事録生成（パイプラインの最初の呼出し）が確実に入力上限を超えるか。 */
export function exceedsSinglePassLimit(sourceText: string) {
  return turnsJsonBytes(timelineSourceTurns(sourceText)) + MINUTES_FIXED_LOWER_BOUND_BYTES > SINGLE_CALL_INPUT_BYTES;
}

/** 長い記録の分析の上限を超えるか（超える場合は AI を呼ばずに止める）。 */
export function exceedsLongAnalysisLimit(sourceText: string) {
  return turnsJsonBytes(timelineSourceTurns(sourceText)) > LONG_ANALYSIS_MAX_SOURCE_TURNS_JSON_BYTES;
}

const SENTENCE_END = /[。！？!?]/u;
const SENTENCE_TRAILING = /[」』）)】〕”’\s]/u;

/** 1行を、文末で maxChars 以下の連続した区間に分ける（連結すると元の行に戻る）。 */
export function lineUnitRanges(line: string, maxChars = LONG_LINE_UNIT_CHARS): Array<[number, number]> {
  if (line.length <= maxChars) return [[0, line.length]];
  const breaks: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (!SENTENCE_END.test(line[i])) continue;
    let end = i + 1;
    while (end < line.length && (SENTENCE_END.test(line[end]) || SENTENCE_TRAILING.test(line[end]))) end++;
    breaks.push(end);
    i = end - 1;
  }
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (line.length - start > maxChars) {
    let cut = 0;
    for (const at of breaks) if (at > start && at - start <= maxChars) cut = at;
    if (!cut) {
      // 文末の無い長い文は字数で切る（サロゲートペアの途中では切らない）。
      cut = start + maxChars;
      const code = line.charCodeAt(cut);
      if (code >= 0xdc00 && code <= 0xdfff) cut--;
    }
    ranges.push([start, cut]);
    start = cut;
  }
  ranges.push([start, line.length]);
  // 空白だけの断片は前の断片に含める（断片が連続したままになるように）。
  return ranges.reduce<Array<[number, number]>>((merged, range) => {
    if (merged.length && !line.slice(range[0], range[1]).trim()) merged[merged.length - 1] = [merged[merged.length - 1][0], range[1]];
    else merged.push(range);
    return merged;
  }, []);
}

/** issue-evidence.ts の labelledLine と同じ判定（話者ラベル。数字だけの「10:00」などは除く）。 */
function speakerLabel(line: string): string | null {
  const match = line.match(/^\s*([^:：。！？!?]{1,40})\s*[:：]/u);
  return match && !/^[\d０-９\s]+$/u.test(match[1]) ? match[1].trim() : null;
}

/**
 * 抽出・抜粋の単位と話者の塊（run）。塊は、空行で区切られ、同じ話者ラベルの連続した行と
 * ラベルなしの継続行をまとめたもの（後段の撤回判定・時期の根拠・課題の原文引用の塊と同じ区切り）。
 */
export function analysisUnits(sourceText: string): AnalysisUnit[] {
  const units: AnalysisUnit[] = [];
  let run = -1;
  let runLabel: string | null = null;
  let inRun = false;
  sourceText.split(/\r?\n/u).forEach((line, lineIndex) => {
    if (!line.trim()) {
      inRun = false;
      return;
    }
    const label = speakerLabel(line);
    if (!inRun || (label !== null && label !== runLabel)) {
      run++;
      runLabel = label;
      inRun = true;
    }
    for (const [start, end] of lineUnitRanges(line)) {
      units.push({ id: units.length + 1, text: line.slice(start, end), line: lineIndex, start, end, lineLength: line.length, run });
    }
  });
  return units;
}

/** 選んだ単位を元の順序・元の文字どおりに並べる。同じ行の連続した断片はつなぎ、隣り合わない所には空行を1行入れる。 */
export function renderUnits(units: AnalysisUnit[], ids: Iterable<number>): string | null {
  const parts: string[] = [];
  let previous: AnalysisUnit | null = null;
  let current = "";
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const unit = units[id - 1];
    if (!unit) return null;
    if (previous && unit.line === previous.line && unit.start === previous.end) {
      current += unit.text;
    } else {
      if (previous) {
        parts.push(current);
        const nextLine = unit.line === previous.line + 1 && unit.start === 0 && previous.end === previous.lineLength;
        if (!nextLine) parts.push("");
      }
      current = unit.text;
    }
    previous = unit;
  }
  if (previous) parts.push(current);
  return parts.join("\n");
}

/** 連続する単位を、発言JSONが maxBytes 以内になるように区間へまとめる（番号は全文の通し番号）。 */
export function planLongChunks(sourceText: string, maxBytes = LONG_ANALYSIS_CHUNK_TURNS_JSON_BYTES): LongChunk[] {
  const units = analysisUnits(sourceText);
  const chunks: LongChunk[] = [];
  let start = 0;
  let bytes = 4;
  for (let i = 0; i < units.length; i++) {
    const cost = turnJsonBytes(units[i]);
    if (i > start && bytes + cost > maxBytes) {
      chunks.push({ index: chunks.length, startId: units[start].id, endId: units[i - 1].id });
      start = i;
      bytes = 4;
    }
    bytes += cost;
  }
  if (units.length) chunks.push({ index: chunks.length, startId: units[start].id, endId: units[units.length - 1].id });
  return chunks;
}

/** 区間を半分に分ける（出力・入力上限に達した場合）。1単位だけの区間は分けられない。 */
export function splitLongChunk(chunk: LongChunk): [LongChunk, LongChunk] | null {
  if (chunk.endId <= chunk.startId) return null;
  const middle = Math.floor((chunk.startId + chunk.endId) / 2);
  return [
    { index: chunk.index, startId: chunk.startId, endId: middle },
    { index: chunk.index + 1, startId: middle + 1, endId: chunk.endId },
  ];
}

export function chunkTurns(sourceText: string, chunk: LongChunk): TimelineSourceTurn[] {
  return analysisUnits(sourceText).filter(unit => unit.id >= chunk.startId && unit.id <= chunk.endId).map(({ id, text }) => ({ id, text }));
}

// gemini-3.5-flash-lite rejects an array maxItems here with HTTP 400 INVALID_ARGUMENT (confirmed on Vertex on
// 2026-09-29), so the schema has no maxItems. The prompt asks for at most MAX_SELECTIONS_PER_CHUNK and
// parseExtraction keeps only that many.
export const EXTRACT_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          topics: { type: "array", items: { type: "string", enum: [...EXTRACT_TOPICS] } },
          quote: { type: "string" },
        },
        required: ["id", "topics", "quote"],
      },
    },
  },
  required: ["selections"],
} as const;

const EXTRACT_SYSTEM = [
  "あなたは商談の文字起こしから、議事録・BANT・次の対応の根拠になる発言を選ぶ担当です。",
  "入力は長い商談の一部の区間で、各発言に全体の通し番号 id が付いています。長い発言は文の区切りで複数に分け、それぞれに id を付けています。",
  "次に当てはまる発言を選び、その id と、その発言の本文から8〜40字を一字一句そのまま写した quote を返してください。",
  "- budget：予算・金額・費用・見積",
  "- authority：決裁者・承認・稟議・関係者の役割",
  "- need：顧客の課題・目的・要望・困りごと",
  "- timeline：時期・期限・日付・日程・納期・公開",
  "- condition：条件付きの希望・前提（〜なら、〜次第など）",
  "- decision：決まったこと・合意したこと",
  "- proposal：営業からの提案内容",
  "- next_action：次に誰が何をいつまでにするか",
  "- change：撤回・取り下げ・訂正・条件の変更（変更前の条件の発言も選ぶ）",
  "- uncertainty：未確認・未定・未集計・未合意・分からないこと",
  "短い返事（はい・そうです等）を選ぶ場合は、直前の質問の発言も選んでください。",
  "雑談・あいさつ・重複した言い直しは選ばないでください。要約・言い換え・補足は書かず、選択だけを返してください。",
  `選ぶのは最大${MAX_SELECTIONS_PER_CHUNK}件です。重要度の高い発言を優先してください。`,
].join("\n");

export function extractionPrompt(turns: TimelineSourceTurn[], chunk: LongChunk, total: number) {
  return {
    system: EXTRACT_SYSTEM,
    user: [
      `区間 ${chunk.index + 1}/${total}（発言 ${chunk.startId}〜${chunk.endId}）`,
      "発言（JSON）:",
      JSON.stringify(turns, null, 2),
    ].join("\n"),
  };
}

function normalizeTopics(value: unknown): ExtractTopic[] {
  const topics = Array.isArray(value) ? value.filter((topic): topic is ExtractTopic => (EXTRACT_TOPICS as readonly string[]).includes(topic as string)) : [];
  return topics.length ? [...new Set(topics)] : ["need"];
}

/**
 * モデルの選択を原文と照合する。番号が区間内で、その発言の本文が quote を文字どおり含むものだけを採る。
 * 番号がずれていても、quote（8字以上）が区間内の1つの発言だけにある場合はその発言に付け替える。
 */
export function verifySelections(raw: unknown, turns: TimelineSourceTurn[]): { selections: LineSelection[]; stats: SelectionStats } {
  const stats: SelectionStats = { accepted: 0, relocated: 0, rejected: { invalid_id: 0, not_verbatim: 0, duplicate: 0 } };
  const byId = new Map(turns.map(turn => [turn.id, turn]));
  const chosen = new Map<number, Set<ExtractTopic>>();
  const items = raw && typeof raw === "object" && Array.isArray((raw as { selections?: unknown }).selections)
    ? (raw as { selections: unknown[] }).selections.slice(0, MAX_SELECTIONS_PER_CHUNK)
    : [];
  for (const item of items) {
    const record = item && typeof item === "object" ? item as { id?: unknown; topics?: unknown; quote?: unknown } : {};
    const quote = typeof record.quote === "string" ? record.quote.trim() : "";
    let id = typeof record.id === "number" && Number.isSafeInteger(record.id) ? record.id : null;
    const turn = id !== null ? byId.get(id) : undefined;
    if (!turn || quote.length < 4 || !turn.text.includes(quote)) {
      const matches = quote.length >= 8 ? turns.filter(candidate => candidate.text.includes(quote)) : [];
      if (matches.length === 1) {
        id = matches[0].id;
        stats.relocated++;
      } else {
        if (!turn) stats.rejected.invalid_id++;
        else stats.rejected.not_verbatim++;
        continue;
      }
    }
    const topics = chosen.get(id!) ?? new Set<ExtractTopic>();
    if (chosen.has(id!)) stats.rejected.duplicate++;
    else stats.accepted++;
    for (const topic of normalizeTopics(record.topics)) topics.add(topic);
    chosen.set(id!, topics);
  }
  return { selections: [...chosen].map(([id, topics]) => ({ id, topics: [...topics] })).sort((a, b) => a.id - b.id), stats };
}

/**
 * AI の選択とは別に、決定論的な根拠補正が実際に読む顧客の発言を「必ず残す」（層0。予算を超えても外さない）。
 * これらの判定は「顧客/先方/お客様」の単独ラベルの行だけを読むので、層0 もその行に限り、行そのものだけを含める
 * （話者の塊・前後の行は、外せる別の種として含める）。撤回・現在の未定・後の置き換えは bant-withdrawal.ts と
 * 同じ判定で、撤回から未定・置き換えまでを続けて選ぶ（bantWithdrawalEvidenceLines）。ほかは、訂正・金額の訂正、
 * 否定形の未確認・未定・判断できない、原因の未調査と確認（causal-evidence）、「導入するなら」の条件付きの希望、
 * 予算・費用と金額、期限（後の言及が判定を変える）、次回の面談の日程・確定・合意（customer-conditions）。
 */
const WITHDRAWN_OR_UNCERTAIN = new RegExp([
  "撤回|取り下げ|取り消|白紙に戻|訂正|言い直|誤り|間違い(?:でした|です|があり|って)",
  "円[^。！？!?]*(?:は|を|から)[^。！？!?]*(?:修正|変更)(?:します|しました|する|した|いたします)",
  "未合意|未確認|未確定|未集計|未調査|未定|不明|分から|分かりません|わから|わかりません|判断でき(?:ない|ません|ず)",
  "(?:決めて|決まって|確定して|検討して)(?:い)?(?:な|ません)",
].join("|"), "u");
/** 顧客の行で、後の言及が判定を変える語（条件付きの希望・提出期限）。 */
const CUSTOMER_STATE = /導入するなら|期限|までに|以内に/u;
const BUDGET_WORD = /予算|制作費|導入費用|費用/u;
const MONEY = /[\d０-９一二三四五六七八九十百千万億兆,.，．]+(?:億|万|千)?円|[¥￥][\d０-９,.，．]+/u;
const CUSTOMER_LINE = /^\s*(?:顧客|先方|お客様)\s*[:：]\s*(.+)$/u;
/** 話者の判定が曖昧な行（1行に別の話者の表記がある）は、判定側と同じく読まない。 */
const EXTRA_SPEAKER = /(?:営業|顧客|先方|お客様|話者\s*\d+)\s*[:：]/u;
/** 根拠補正の判定には直接使わないが、BANT・次の対応の手がかりになる一般的な語（分量に余裕がある場合だけ含める）。 */
const HINT_LINE = /見積|期限|までに|候補日|承認|決裁|稟議|予算|制作費|費用|変更|修正|見送|集計|まだ[^。！？!?]{0,20}(?:ません|ない)/u;

function sentencesOf(body: string) {
  return body.match(/[^。！？!?]+[。！？!?]?/gu) ?? [];
}

/** 決定論的な根拠補正が読む顧客の行か（層0）。 */
function mustKeepCustomerLine(line: string): boolean {
  const customer = line.match(CUSTOMER_LINE);
  if (!customer || EXTRA_SPEAKER.test(customer[1])) return false;
  return sentencesOf(customer[1]).some(sentence => WITHDRAWN_OR_UNCERTAIN.test(sentence) || CUSTOMER_STATE.test(sentence)
    || causalUninvestigated.test(sentence) || causalVerified.test(sentence)
    || (BUDGET_WORD.test(sentence) && MONEY.test(sentence))
    || (nextMeetingMention.test(sentence) && /日程|予定|確定|合意/u.test(sentence)));
}

/**
 * 必ず残す行（topics: keep。行の最初の単位で表す）と、手がかりの行（guard）。顧客以外の話者（話者N・営業・ラベルなし）の
 * 未確認・訂正などの行は、決定論的な判定が読まないので手がかりとして扱う（AI の選択より後に外す）。
 */
export function guardSelections(sourceText: string): LineSelection[] {
  const units = analysisUnits(sourceText);
  const withdrawalLines = new Set(bantWithdrawalEvidenceLines(sourceText));
  const lineText = new Map<number, string>();
  for (const unit of units) lineText.set(unit.line, (lineText.get(unit.line) ?? "") + unit.text);
  const keepLines = new Set([...lineText].filter(([line, text]) => withdrawalLines.has(line) || mustKeepCustomerLine(text)).map(([line]) => line));
  const firstOfLine = new Set<number>();
  return units.flatMap((unit): LineSelection[] => {
    const first = !firstOfLine.has(unit.line);
    firstOfLine.add(unit.line);
    if (keepLines.has(unit.line)) return first ? [{ id: unit.id, topics: ["keep"] }] : [];
    return HINT_LINE.test(unit.text) || WITHDRAWN_OR_UNCERTAIN.test(unit.text) || causalUninvestigated.test(unit.text)
      ? [{ id: unit.id, topics: ["guard"] }] : [];
  });
}

function priorityOf(topics: Iterable<ExtractTopic>) {
  const set = new Set(topics);
  if (set.has("keep")) return 0;
  if (set.has("change") || set.has("uncertainty")) return 1;
  // 条件は日付・金額の意味を限定するので、日付・金額と同じ順位で扱う。
  if (["budget", "authority", "timeline", "decision", "next_action", "condition"].some(topic => set.has(topic as ExtractTopic))) return 2;
  if (set.has("proposal") || set.has("need")) return 3;
  // 一般的な手がかりの語（guard）は判定には使わないので、AI の選択より後に外す。
  return 4;
}

/** 優先度の数値から、要約の保存・再構成で使う代表の話題（priorityOf で同じ優先度に戻る）。 */
export const PRIORITY_TOPIC: Record<number, ExtractTopic> = { 1: "change", 2: "decision", 3: "need", 4: "context" };

export type CondensedSource = {
  text: string;
  /** 抜粋に含めた単位の番号（全文の通し番号）。rebuildCondensedSource で同じ抜粋を作り直せる。 */
  sourceLineIds: number[];
  /** AI が選び、原文と一致した発言（番号と優先度）。抜粋を小さくして作り直すときに使う。 */
  selectedUnits: Array<[number, number]>;
  condensedTurnsJsonBytes: number;
  /** 抜粋に入らなかった種（AI の選択・手がかりの語）の数。必ず残す発言（層0）は含まない。 */
  droppedForBudget: number;
  /** 抜粋に入らなかった AI の選択の数（画面の注記に使う）。 */
  aiDropped: number;
  /** そのうち、AI が撤回・訂正・未確認として選んだ発言の数。 */
  guardDropped: number;
  /** 行が長すぎて話者ラベルと一緒に入れられず、抜粋に入らなかった種（層0を除く）の数。 */
  skippedLongLines: number;
  /** 行が長すぎて抜粋に入らなかった必ず残す発言（層0）の数。 */
  mustKeepMissing: number;
  /** 必ず残す発言（層0）の発言JSONのバイト数。これより小さい抜粋は作れない。 */
  mustKeepBytes: number;
  guardAdded: number;
  contextAdded: number;
};

type RunInfo = {
  lines: AnalysisUnit[][];
  /** lines[0..i) の発言JSONのバイト数 */
  prefixBytes: number[];
  /** i 以前で最も近いラベル付きの行（無ければ i 自身） */
  labelledFrom: number[];
  lineIndex: Map<number, number>;
};

function runInfos(units: AnalysisUnit[]): Map<number, RunInfo> {
  const infos = new Map<number, RunInfo>();
  for (const unit of units) {
    let info = infos.get(unit.run);
    if (!info) infos.set(unit.run, info = { lines: [], prefixBytes: [0], labelledFrom: [], lineIndex: new Map() });
    const last = info.lines.at(-1);
    if (last && last[0].line === unit.line) last.push(unit);
    else {
      info.lineIndex.set(unit.line, info.lines.length);
      info.lines.push([unit]);
      info.prefixBytes.push(info.prefixBytes.at(-1)!);
      const index = info.lines.length - 1;
      info.labelledFrom.push(speakerLabel(unit.text) !== null || index === 0 ? index : info.labelledFrom[index - 1]);
    }
    info.prefixBytes[info.prefixBytes.length - 1] += turnJsonBytes(unit);
  }
  // ラベル付きの行が塊の中に無い場合は、さかのぼらない。
  for (const info of infos.values()) {
    info.labelledFrom = info.labelledFrom.map((from, index) => speakerLabel(info.lines[from][0].text) !== null ? from : index);
  }
  return infos;
}

/** issue-evidence.ts の役割の判定と同じ語（「山田（顧客）」のような括弧書きも含む）。 */
const ROLE_LABEL = /^(?:営業(?:担当者?)?|当社|弊社|売り手|セールス|顧客|先方|お客様)(?:$|[（(\s])/u;
function roleLabel(text: string) {
  const label = speakerLabel(text);
  if (!label) return false;
  return ROLE_LABEL.test(label) || ROLE_LABEL.test(label.match(/[（(]([^（）()]+)[）)]\s*$/u)?.[1] ?? "");
}

/** 話者の塊を丸ごと含める上限。これを超える塊では、種の前後の行（話者ラベルの行から）だけを含める。 */
const RUN_INCLUDE_MAX_BYTES = 3_000;
/** 塊が大きい場合に、種の前後の行として含める上限。 */
const LINE_INCLUDE_MAX_BYTES = 6_000;
/** 必ず残す発言（層0）の行は、この大きさまで行ごと含める（抽出の1区間と同じ大きさ）。 */
const MUST_KEEP_LINE_MAX_BYTES = LONG_ANALYSIS_CHUNK_TURNS_JSON_BYTES;
/** 同じ塊の中の種どうしの隙間がこれ以下なら、間の行も含めて1つの続いた発言にする（日付と留保など）。 */
const GAP_FILL_MAX_BYTES = 2_000;

/**
 * 種の発言に対して抜粋へ含める単位（話者の塊。塊が大きい場合は種の前後の行を話者ラベルの行から）。
 * 話者ラベルから切り離した断片は出さない（役割の判定と、同じ行の後に続く留保の判定が変わるため）。
 */
function includedUnitsForSeed(info: RunInfo, seed: AnalysisUnit): number[] {
  const windowBytes = (from: number, to: number) => info.prefixBytes[to + 1] - info.prefixBytes[from];
  const windowIds = (from: number, to: number) => info.lines.slice(from, to + 1).flat().map(unit => unit.id);
  const last = info.lines.length - 1;
  if (windowBytes(0, last) <= RUN_INCLUDE_MAX_BYTES) return windowIds(0, last);
  const at = info.lineIndex.get(seed.line)!;
  // ラベルなしの継続行には、塊の中で直前のラベル付きの行までさかのぼって話者を付ける。
  for (const [from, to] of [[info.labelledFrom[Math.max(0, at - 1)], Math.min(last, at + 1)], [info.labelledFrom[at], Math.min(last, at + 1)], [info.labelledFrom[at], at]]) {
    if (windowBytes(from, to) <= LINE_INCLUDE_MAX_BYTES) return windowIds(from, to);
  }
  const line = info.lines[at];
  // 営業・顧客などの役割のラベルは、切り離すと役割の判定が変わる。話者N などの役割の無いラベルは、切り離しても判定は同じ。
  const roleLabelled = roleLabel(info.lines[info.labelledFrom[at]][0].text);
  // 役割のラベルの継続行で、ラベルの行から種までが大きすぎる場合は含めない（ラベルの無い断片にしない）。
  if (info.labelledFrom[at] !== at && roleLabelled) return [];
  // 1行が大きすぎる場合は、役割のラベルの行なら行の先頭から種と次の文まで、それ以外は種と次の文。
  const seedIndex = line.findIndex(unit => unit.id === seed.id);
  const pieces = line.slice(roleLabelled && info.labelledFrom[at] === at ? 0 : seedIndex, Math.min(line.length, seedIndex + 2));
  return pieces.reduce((total, unit) => total + turnJsonBytes(unit), 0) <= LINE_INCLUDE_MAX_BYTES ? pieces.map(unit => unit.id) : [];
}

type Seed = { id: number; value: number; chunk: number; included: number[]; companion?: boolean };

/**
 * 種（AI の選択・必ず残す発言・手がかりの語・短い返事の前の質問）から抜粋を作る。
 * 必ず残す発言（層0）はその行だけを含め、外さない。その行の話者の塊・前後の行は、外せる別の種（優先度1）にする。
 * ほかの種は話者の塊を含め、同じ塊の近い種の間は続けて含める。予算を超える場合は優先度の低い種から外す。
 * 同じ優先度では、撤回・訂正・未確認の種は古いものから（後の発言が前の発言を訂正するため）、
 * それ以外は種の多い区間から、区間の中では古いものから外す。
 */
export function buildCondensedSource(
  sourceText: string,
  modelSelections: LineSelection[],
  chunks: LongChunk[],
  targetBytes = LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES,
): CondensedSource {
  const units = analysisUnits(sourceText);
  const runs = runInfos(units);
  const priority = new Map<number, number>();
  const seed = (id: number, value: number) => priority.set(id, Math.min(priority.get(id) ?? 5, value));
  const modelPriority = new Map<number, number>();
  for (const selection of modelSelections) {
    if (selection.id < 1 || selection.id > units.length) continue;
    const value = Math.max(1, priorityOf(selection.topics));
    modelPriority.set(selection.id, Math.min(modelPriority.get(selection.id) ?? 5, value));
    seed(selection.id, value);
  }
  let guardAdded = 0;
  for (const guard of guardSelections(sourceText)) {
    if (!modelPriority.has(guard.id)) guardAdded++;
    seed(guard.id, priorityOf(guard.topics));
  }
  // 短い返事の種には、直前の発言（質問）を加える。判定は質問の行を読まないので、必ず残す層にはしない。
  let contextAdded = 0;
  const context = new Set<number>();
  for (const [id, value] of [...priority]) {
    if (id > 1 && units[id - 1].text.replace(/^[^:：]{1,20}[:：]\s*/u, "").trim().length <= 20 && !priority.has(id - 1)) {
      seed(id - 1, Math.max(1, value));
      context.add(id - 1);
      contextAdded++;
    }
  }

  const chunkOf = new Map<number, number>();
  chunks.forEach((chunk, index) => { for (let id = chunk.startId; id <= chunk.endId; id++) chunkOf.set(id, index); });
  const lineUnits = new Map<number, AnalysisUnit[]>();
  for (const unit of units) {
    const list = lineUnits.get(unit.line);
    if (list) list.push(unit);
    else lineUnits.set(unit.line, [unit]);
  }
  const seeds: Seed[] = [];
  for (const [id, value] of priority) {
    const unit = units[id - 1];
    const info = runs.get(unit.run)!;
    const chunk = chunkOf.get(id) ?? -1;
    if (value === 0) {
      const line = lineUnits.get(unit.line)!;
      const lineBytes = line.reduce((total, piece) => total + turnJsonBytes(piece), 0);
      seeds.push({ id, value, chunk, included: lineBytes <= MUST_KEEP_LINE_MAX_BYTES ? line.map(piece => piece.id) : [] });
      seeds.push({ id, value: 1, chunk, included: includedUnitsForSeed(info, unit), companion: true });
    } else {
      seeds.push({ id, value, chunk, included: includedUnitsForSeed(info, unit) });
    }
  }

  // 同じ塊の中の近い種の間の行を、手前の種に加える（手前の種はラベルの行から始まるので、続いた発言として残る。
  // 後ろの種だけが残った場合も、後ろの種は自分のラベルの行から始まる）。
  const byRun = new Map<number, Seed[]>();
  for (const item of seeds) {
    if (!item.included.length || item.value === 0) continue;
    const run = units[item.id - 1].run;
    const list = byRun.get(run);
    if (list) list.push(item);
    else byRun.set(run, [item]);
  }
  for (const [run, items] of byRun) {
    const info = runs.get(run)!;
    const lineOf = (id: number) => info.lineIndex.get(units[id - 1].line)!;
    const spans = items.map(item => ({ item, from: Math.min(...item.included.map(lineOf)), to: Math.max(...item.included.map(lineOf)) }))
      .sort((a, b) => a.from - b.from || a.to - b.to);
    let previous = spans[0];
    for (let i = 1; i < spans.length; i++) {
      const current = spans[i];
      if (current.from <= previous.to + 1) {
        if (current.to > previous.to) previous = current;
        continue;
      }
      const gapBytes = info.prefixBytes[current.from] - info.prefixBytes[previous.to + 1];
      if (gapBytes <= GAP_FILL_MAX_BYTES) previous.item.included.push(...info.lines.slice(previous.to + 1, current.from).flat().map(unit => unit.id));
      previous = current;
    }
  }

  // 外す順（静的）：優先度の低い順。層0は外さない。優先度1（撤回・訂正・未確認）は古い順、それ以外は「区間に残る種の多い順・古い順」。
  const rankInChunk = new Map<Seed, number>();
  const chunkCount = new Map<string, number>();
  for (const item of [...seeds].sort((a, b) => a.id - b.id)) {
    const key = `${item.value}:${item.chunk}`;
    rankInChunk.set(item, chunkCount.get(key) ?? 0);
    chunkCount.set(key, (chunkCount.get(key) ?? 0) + 1);
  }
  const remainingAtRemoval = (item: Seed) => chunkCount.get(`${item.value}:${item.chunk}`)! - rankInChunk.get(item)!;
  const removal = seeds.filter(item => item.value > 0).sort((a, b) => b.value - a.value
    || (a.value === 1 ? 0 : remainingAtRemoval(b) - remainingAtRemoval(a))
    || a.id - b.id);

  const coverage = new Map<number, number>();
  let bytes = 4;
  const mustKeepUnits = new Set(seeds.filter(item => item.value === 0).flatMap(item => item.included));
  const mustKeepBytes = mustKeepUnits.size ? 4 + [...mustKeepUnits].reduce((total, id) => total + turnJsonBytes(units[id - 1]), 0) : 0;
  for (const item of seeds) {
    for (const id of new Set(item.included)) {
      if (!coverage.has(id)) bytes += turnJsonBytes(units[id - 1]);
      coverage.set(id, (coverage.get(id) ?? 0) + 1);
    }
  }
  for (const item of removal) {
    if (bytes <= targetBytes) break;
    for (const id of new Set(item.included)) {
      const count = coverage.get(id)! - 1;
      if (count === 0) {
        coverage.delete(id);
        bytes -= turnJsonBytes(units[id - 1]);
      } else coverage.set(id, count);
    }
  }
  // 数は最終的な抜粋から数える（他の種の範囲に含まれて残った発言は、落ちたとは数えない）。
  const own = seeds.filter(item => item.value > 0 && !item.companion && !context.has(item.id));
  const missing = own.filter(item => !coverage.has(item.id));
  const ids = [...coverage.keys()].sort((a, b) => a - b);
  const text = renderUnits(units, ids) ?? "";
  return {
    text,
    sourceLineIds: ids,
    selectedUnits: [...modelPriority].sort((a, b) => a[0] - b[0]),
    condensedTurnsJsonBytes: turnsJsonBytes(timelineSourceTurns(text)),
    droppedForBudget: missing.length,
    aiDropped: [...modelPriority.keys()].filter(id => !coverage.has(id)).length,
    guardDropped: [...modelPriority].filter(([id, value]) => value === 1 && !coverage.has(id)).length,
    skippedLongLines: missing.filter(item => !item.included.length).length,
    mustKeepMissing: seeds.filter(item => item.value === 0 && !coverage.has(item.id)).length,
    mustKeepBytes,
    guardAdded,
    contextAdded,
  };
}

/** 必ず残す発言（層0）だけの発言JSONのバイト数（AI を使わずに本文だけから決まる）。 */
export function longAnalysisMustKeepBytes(sourceText: string) {
  return buildCondensedSource(sourceText, [], planLongChunks(sourceText), 0).mustKeepBytes;
}

/** 保存済みの番号から、同じ抜粋を作り直す（抜粋の本文は保存しない）。 */
export function rebuildCondensedSource(sourceText: string, sourceLineIds: number[]) {
  return renderUnits(analysisUnits(sourceText), sourceLineIds);
}
