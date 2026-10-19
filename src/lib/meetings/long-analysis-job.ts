/**
 * T04/T22: 長時間の記録の分析ジョブ（原文抜粋の抽出→分析）の状態。純関数のみ。
 * 抽出の進捗は meeting.meta.analysisJob、完了後の抜粋の記録は meeting.meta.analysisInput に置く。
 * 抜粋の本文は保存しない（行番号から作り直す）。meta は画面側にも渡るため、本文を重ねて持たない。
 */
import {
  LONG_ANALYSIS_EXTRACT_PROMPT_VERSION,
  LONG_ANALYSIS_MIN_TARGET_TURNS_JSON_BYTES,
  LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES,
  planLongChunks,
  PRIORITY_TOPIC,
  sha256,
  type LineSelection,
  type LongChunk,
  type SelectionStats,
} from "@/lib/ai/long-transcript";

export type AnalysisChunk = LongChunk & {
  status: "pending" | "done" | "error";
  attempts: number;
  selections?: LineSelection[];
  stats?: SelectionStats;
  usage?: Record<string, number>;
  elapsedMs?: number;
  error?: string;
};

export type AnalysisJob = {
  version: 1;
  /** extract: 区間ごとに関係する発言を抽出中／pipeline: 抜粋で議事録・BANTを生成する段階 */
  state: "extract" | "pipeline";
  sourceField: "transcript" | "minutes";
  sourceSha256: string;
  promptVersion: string;
  chunks: AnalysisChunk[];
  vertexAttempts: number;
  /**
   * 抽出の呼び出し回数の上限。作成時は区間数の2倍（最低4回）。1回の操作の中では区間を分割しても増やさない。
   * 人の再実行（resumeOrCreateAnalysisJob）ごとに、完了済みの回数に未完了の区間（分割後の断片を含む）の2倍（最低4回）を足して付け直す。
   */
  attemptLimit: number;
  /** 抜粋の発言JSONの目安。分析が入力上限に達したら小さくして作り直す。 */
  targetBytes: number;
  /** 入力上限による抜粋の作り直しの回数。 */
  pipelineAttempts: number;
  /** 議事録・BANT の生成を始めた回数（処理が打ち切られた後の取り直しも数える）。 */
  pipelineRuns: number;
  /** 抜粋をこれ以上小さくできずに入力上限で止まった（同じ本文の再実行は AI を呼ばずに同じ結果を返す）。 */
  stopped?: "input_limit";
  createdAt: string;
  updatedAt: string;
};

export type AnalysisInputSummary = {
  version: 1;
  mode: "condensed";
  promptVersion: string;
  sourceField: "transcript" | "minutes";
  sourceSha256: string;
  originalChars: number;
  condensedChars: number;
  condensedTurnsJsonBytes: number;
  chunks: number;
  /** 抜粋に含めた単位（発言。長い行は文の区切りの断片）の通し番号。 */
  sourceLineIds: number[];
  /** AI が選び原文と一致した発言の番号と優先度。抜粋を小さくして作り直すときに使う。 */
  selectedUnits: Array<[number, number]>;
  selection: {
    accepted: number; relocated: number; rejected: number; guardAdded: number; contextAdded: number;
    /** 分量の上限で抜粋に入らなかった AI の選択・手がかりの語の数（必ず残す発言は含まない）。 */
    droppedForBudget: number; guardDropped: number; skippedLongLines?: number;
    /** 抜粋に入らなかった AI の選択の数と、行が長すぎて入らなかった必ず残す発言の数（画面の注記に使う）。 */
    aiDropped?: number; mustKeepMissing?: number;
    /** 必ず残す発言（撤回・訂正・未確認など）の発言JSONのバイト数。これより小さい抜粋は作れない。 */
    mustKeepBytes?: number;
  };
  completedAt: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readAnalysisJob(meta: unknown): AnalysisJob | null {
  const job = record(record(meta)?.analysisJob) as Partial<AnalysisJob> | null;
  if (!job || job.version !== 1 || !["extract", "pipeline"].includes(job.state as string) || !Array.isArray(job.chunks) || !job.chunks.length
    || typeof job.sourceSha256 !== "string" || (job.sourceField !== "transcript" && job.sourceField !== "minutes")) return null;
  const valid = job.chunks.every(chunk => chunk && Number.isSafeInteger(chunk.startId) && Number.isSafeInteger(chunk.endId)
    && chunk.endId >= chunk.startId && ["pending", "done", "error"].includes(chunk.status) && Number.isSafeInteger(chunk.attempts));
  if (!valid) return null;
  return {
    version: 1,
    state: job.state as AnalysisJob["state"],
    sourceField: job.sourceField,
    sourceSha256: job.sourceSha256,
    promptVersion: typeof job.promptVersion === "string" ? job.promptVersion : "",
    chunks: job.chunks.map((chunk, index) => ({ ...chunk, index })),
    vertexAttempts: Number.isSafeInteger(job.vertexAttempts) ? job.vertexAttempts! : 0,
    attemptLimit: Number.isSafeInteger(job.attemptLimit) && job.attemptLimit! > 0 ? job.attemptLimit! : initialAttemptLimit(job.chunks.length),
    targetBytes: Number.isSafeInteger(job.targetBytes) && job.targetBytes! > 0 ? job.targetBytes! : LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES,
    pipelineAttempts: Number.isSafeInteger(job.pipelineAttempts) ? job.pipelineAttempts! : 0,
    pipelineRuns: Number.isSafeInteger(job.pipelineRuns) ? job.pipelineRuns! : 0,
    ...(job.stopped === "input_limit" ? { stopped: "input_limit" as const } : {}),
    createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date(0).toISOString(),
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date(0).toISOString(),
  };
}

export function readAnalysisInput(meta: unknown): AnalysisInputSummary | null {
  const input = record(record(meta)?.analysisInput) as Partial<AnalysisInputSummary> | null;
  if (!input || input.version !== 1 || input.mode !== "condensed" || typeof input.sourceSha256 !== "string"
    || !Array.isArray(input.sourceLineIds) || !input.sourceLineIds.every(id => Number.isSafeInteger(id) && id > 0)) return null;
  const selectedUnits = Array.isArray(input.selectedUnits)
    ? input.selectedUnits.filter((pair): pair is [number, number] => Array.isArray(pair) && Number.isSafeInteger(pair[0]) && pair[0] > 0 && [1, 2, 3, 4].includes(pair[1]))
    : [];
  return { ...input, selectedUnits } as AnalysisInputSummary;
}

export function withAnalysisJob(meta: unknown, job: AnalysisJob | null): Record<string, unknown> {
  const base = { ...(record(meta) ?? {}) };
  if (job) base.analysisJob = job;
  else delete base.analysisJob;
  return base;
}

export function withAnalysisInput(meta: unknown, input: AnalysisInputSummary | null): Record<string, unknown> {
  const base = { ...(record(meta) ?? {}) };
  if (input) base.analysisInput = input;
  else delete base.analysisInput;
  return base;
}

function initialAttemptLimit(chunks: number) {
  return Math.max(4, chunks * 2);
}

export function createAnalysisJob(sourceText: string, sourceField: AnalysisJob["sourceField"], now: Date): AnalysisJob {
  const chunks = planLongChunks(sourceText);
  return {
    version: 1,
    state: "extract",
    sourceField,
    sourceSha256: sha256(sourceText),
    promptVersion: LONG_ANALYSIS_EXTRACT_PROMPT_VERSION,
    chunks: chunks.map(chunk => ({ ...chunk, status: "pending", attempts: 0 })),
    vertexAttempts: 0,
    attemptLimit: initialAttemptLimit(chunks.length),
    targetBytes: LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES,
    pipelineAttempts: 0,
    pipelineRuns: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * 保存済みの抜粋の記録から、分析の段階のジョブを作る（抽出は繰り返さない）。保存済みの抜粋での再分析が
 * 入力上限に達したとき、抜粋を targetBytes まで小さくして作り直すために使う。
 */
export function analysisJobFromInput(sourceText: string, input: AnalysisInputSummary, targetBytes: number, now: Date): AnalysisJob {
  const job = createAnalysisJob(sourceText, input.sourceField, now);
  const topicOf = (priority: number) => PRIORITY_TOPIC[priority] ?? "need";
  return {
    ...job,
    state: "pipeline",
    chunks: job.chunks.map(chunk => ({
      ...chunk,
      status: "done",
      attempts: 0,
      selections: input.selectedUnits
        .filter(([id]) => id >= chunk.startId && id <= chunk.endId)
        .map(([id, priority]) => ({ id, topics: [topicOf(priority)] })),
    })),
    targetBytes,
    pipelineAttempts: 1,
  };
}

/**
 * 同じ本文・同じ抽出版の既存ジョブがあれば、完了済みの区間を残して再開する（「分析を実行」での再実行）。
 * 人が再実行を指示したので、失敗した区間と呼び出し回数の上限は数え直す。
 */
export function resumeOrCreateAnalysisJob(existing: AnalysisJob | null, sourceText: string, sourceField: AnalysisJob["sourceField"], now: Date): AnalysisJob {
  const fresh = createAnalysisJob(sourceText, sourceField, now);
  if (!existing || existing.sourceSha256 !== fresh.sourceSha256 || existing.promptVersion !== fresh.promptVersion) return fresh;
  const chunks = existing.chunks.map(chunk => chunk.status === "done" ? chunk : { ...chunk, status: "pending" as const, attempts: 0, error: undefined });
  const doneAttempts = chunks.filter(chunk => chunk.status === "done").reduce((total, chunk) => total + chunk.attempts, 0);
  return {
    ...existing,
    state: chunks.every(chunk => chunk.status === "done") ? "pipeline" : "extract",
    chunks,
    vertexAttempts: doneAttempts,
    // 人の再実行では、残りの区間に見合う回数を付け直す（完了済みの区間の回数は数えたまま。1回の操作の中では分割しても増えない）。
    attemptLimit: doneAttempts + initialAttemptLimit(chunks.filter(chunk => chunk.status !== "done").length),
    // 入力上限で小さくした抜粋の目安は残す（既に失敗した大きさからやり直さない）。
    targetBytes: Math.min(existing.targetBytes, LONG_ANALYSIS_TARGET_TURNS_JSON_BYTES),
    pipelineAttempts: 0,
    pipelineRuns: 0,
    updatedAt: now.toISOString(),
  };
}

/** 抽出の呼び出し回数の上限（AnalysisJob.attemptLimit。1回20円の予約）。 */
export function analysisAttemptLimit(job: AnalysisJob) {
  return job.attemptLimit;
}

/** 抜粋でも入力上限を超えたときの最終のエラー文（long-analysis.ts と analysis.ts で同じ文を使う）。 */
export function excerptLimitMessage(originalChars: number, canShrink: boolean) {
  const size = `元の記録 約${originalChars.toLocaleString("ja-JP")}文字`;
  return canShrink
    ? `記録は保存済みです。長い記録のため関係する発言を原文のまま抜粋して分析しましたが、抜粋を小さくしても現在のAI検証の1回あたりの入力上限を超えたため、議事録・BANTを作成できませんでした（${size}）。「分析を実行」を押すと、さらに小さい抜粋で再試行します（分析に使える発言は減ります）。`
    : `記録は保存済みです。長い記録のため関係する発言を原文のまま抜粋して分析しましたが、これ以上抜粋を小さくできず、現在のAI検証の1回あたりの入力上限を超えたため、議事録・BANTを作成できませんでした（${size}）。この状態では再実行しても同じ結果になります。上限の見直しが必要です。`;
}

/** 抜粋をどこまで小さくするか。実際の大きさの0.75倍、ただし必ず残す発言の大きさ未満にはしない。 */
export function nextExcerptTarget(currentTarget: number, actualBytes: number, mustKeepBytes: number) {
  const next = Math.max(Math.floor(Math.min(currentTarget, actualBytes) * 0.75), mustKeepBytes);
  // 8,000 バイト未満、またはほとんど小さくならない場合は、作り直しても結果は変わらない。
  return { next, canShrink: next >= LONG_ANALYSIS_MIN_TARGET_TURNS_JSON_BYTES && next < actualBytes * 0.95 };
}

export function analysisProgress(job: AnalysisJob | null) {
  if (!job) return null;
  return { state: job.state, completed: job.chunks.filter(chunk => chunk.status === "done").length, total: job.chunks.length };
}

export function analysisChunkLabel(job: AnalysisJob, index: number) {
  const chunk = job.chunks[index];
  return `区間${index + 1}/${job.chunks.length}（発言${chunk.startId}〜${chunk.endId}）`;
}
