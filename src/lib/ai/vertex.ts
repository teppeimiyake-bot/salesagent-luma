import { measureAiCall, type AiFeature } from "./usage";
import { finishVertexAttempt, reserveVertexAttempt, type VertexLedger, type VertexLedgerStore } from "./vertex-budget";
import { VertexError, vertexConfiguration, vertexFailure, VERTEX_BUDGET_KEY, VERTEX_MAX_INPUT_BYTES, VERTEX_MAX_OUTPUT } from "./vertex-policy";

// Cloud Run は ADC（メタデータサーバー）、Vercel は Workload Identity（Vercel OIDC → サービスアカウント）で認証する。
// どちらを使うかは google-auth.ts が実行環境で切り替える。取れなければ null（呼び出し側が認証エラーにする）。
async function defaultToken() {
  try {
    const { getGoogleAccessToken } = await import("./google-auth");
    return await getGoogleAccessToken();
  } catch (e) {
    console.error("[vertex] access token unavailable", e instanceof Error ? e.message : e);
    return null;
  }
}
export type VertexResponse = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean; thoughtSignature?: string }> }; groundingMetadata?: Record<string, unknown>; safetyRatings?: Array<{ blocked?: boolean }> }>;
  usageMetadata?: Record<string, unknown>;
  promptFeedback?: Record<string, unknown>;
};
export type VertexOptions = {
  system: string; user: string; feature?: AiFeature; json?: boolean; maxTokens?: number;
  audio?: { data: string; mimeType: string }; search?: boolean;
  responseSchema?: Record<string, unknown>;
  /** Generation attempts including 429 retries (1-3, default 3). Each attempt is its own reservation; an optional
   * call (e.g. a transcription completeness retry) passes 1 so a 429 fails at once instead of reserving again. */
  maxAttempts?: number;
};
// Dependency boundary for offline safety tests. Runtime uses ADC (Cloud Run) or Workload Identity (Vercel) + fixed Google endpoints.
export function vertexTransport(getToken: () => Promise<string | null> = defaultToken, fetchImpl: typeof fetch = fetch) {
  return async (url: string, init: RequestInit = {}) => {
    const timeout = AbortSignal.timeout(120000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    signal.throwIfAborted();
    // Bound ADC refresh as well as fetch. A delayed token must never start a
    // Google request after the caller's deadline has already elapsed.
    let abortTokenWait: (() => void) | undefined;
    let token: string | null;
    try {
      token = await Promise.race([
        Promise.resolve().then(getToken),
        new Promise<never>((_, reject) => {
          abortTokenWait = () => reject(signal.reason);
          signal.addEventListener("abort", abortTokenWait, { once: true });
        }),
      ]);
    } finally {
      if (abortTokenWait) signal.removeEventListener("abort", abortTokenWait);
    }
    signal.throwIfAborted();
    if (!token) throw new VertexError("authentication", "AIの認証を確認できませんでした。");
    return fetchImpl(url, { ...init, cache: "no-store", redirect: "error", headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal });
  };
}
export type VertexTransport = ReturnType<typeof vertexTransport>;
// GCS allows about one write per second to one object; faster writes get 429 and are not applied.
// Reserve/finish writes of back-to-back fast calls can exceed that, so a 429 waits and retries.
const LEDGER_RATE_LIMIT_WAIT_MS = 1100;
// QG26-03: the data read names the generation from the metadata read. A write landing in between
// replaces that generation (GCS answers 404, or 412 for a failed precondition), which is a read race,
// not a missing ledger. Wait briefly and read both again, a bounded number of times.
const LEDGER_READ_ATTEMPTS = 4;
const LEDGER_READ_RACE_STATUSES = new Set([404, 412, 429]);
const LEDGER_READ_RETRY_WAIT_MS = 300;
export function vertexLedgerStore(bucket: string, request: VertexTransport,
  sleep: (ms: number) => Promise<void> = ms => new Promise<void>(resolve => setTimeout(resolve, ms))): VertexLedgerStore {
  const objectUrl = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(VERTEX_BUDGET_KEY)}`;
  return {
    async read() {
      for (let attempt = 1; ; attempt++) {
        const meta = await request(objectUrl + "?fields=generation");
        // Missing ledger is not a fresh budget: only an operator can initialize it.
        if (meta.status !== 200) throw new VertexError("ledger_unavailable", "AI利用記録を確認できないため、呼び出しを停止しました。");
        const { generation } = await meta.json();
        if (typeof generation !== "string" || !/^\d+$/.test(generation)) throw new VertexError("ledger_invalid", "AI利用記録が不正です。");
        const data = await request(`${objectUrl}?alt=media&generation=${generation}`);
        if (data.status === 200) return { generation, ledger: await data.json() as VertexLedger };
        if (!LEDGER_READ_RACE_STATUSES.has(data.status) || attempt >= LEDGER_READ_ATTEMPTS) {
          throw new VertexError("ledger_unavailable", "AI利用記録を取得できませんでした。");
        }
        console.error(`[vertex] ledger read raced with a write (${data.status}); reading again`);
        await sleep(LEDGER_READ_RETRY_WAIT_MS * attempt);
      }
    },
    async write(generation, ledger) {
      const result = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(VERTEX_BUDGET_KEY)}&ifGenerationMatch=${generation}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ledger),
      });
      if (result.status === 412) return false;
      if (result.status === 429) {
        // Not written: wait, then the caller re-reads the ledger and writes again (bounded by its retry count).
        console.error("[vertex] ledger write rate-limited (429); retrying");
        await sleep(LEDGER_RATE_LIMIT_WAIT_MS);
        return false;
      }
      if (!result.ok) {
        console.error(`[vertex] ledger write failed (${result.status})`);
        throw new VertexError("ledger_unavailable", "AI利用記録を保存できないため、呼び出しを停止しました。");
      }
      return true;
    },
  };
}
export type VertexDependencies = {
  request: VertexTransport;
  store: VertexLedgerStore;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

function retryDelay(header: string | null, attempt: number, random: () => number) {
  const backoff = 2000 * 2 ** attempt + Math.floor(random() * 1000);
  if (!header) return backoff;
  const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : null;
  const requested = seconds !== null ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(requested) ? Math.max(backoff, requested) : backoff;
}

// Gemini 3 bills grounding per search query ($14 per 1,000). The fixed 100 JPY search reservation covers the
// worst-case tokens of one request (32,768 in, 8,192 out: about 6 JPY at the conservative 200 JPY/USD factor) plus
// this many queries at about 2.8 JPY each. Google publishes no per-request query limit, so a larger or unknown
// count is recorded in the ledger and logged (metadata only) for review.
export const SEARCH_QUERIES_WITHIN_RESERVATION = 33;
const SEARCH_USAGE_KEYS = ["promptTokenCount", "candidatesTokenCount", "totalTokenCount", "thoughtsTokenCount", "toolUsePromptTokenCount", "cachedContentTokenCount"] as const;
const SEARCH_FINISH_REASONS = new Set(["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "MODEL_ARMOR", "UNEXPECTED_TOOL_CALL", "NO_IMAGE", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "IMAGE_OTHER"]);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function hasBlockOrInvalidSafety(value: unknown): boolean {
  const response = record(value);
  if (!response) return true;
  const safeRatings = (ratings: unknown) => ratings === undefined || (Array.isArray(ratings) && ratings.every(rating => {
    const item = record(rating);
    return item && (item.blocked === undefined || item.blocked === false);
  }));
  if (response.promptFeedback !== undefined) {
    const feedback = record(response.promptFeedback);
    if (!feedback || (feedback.blockReason !== undefined && feedback.blockReason !== "BLOCKED_REASON_UNSPECIFIED")
      || (feedback.blockReasonMessage !== undefined && feedback.blockReasonMessage !== "")
      || !safeRatings(feedback.safetyRatings)) return true;
  }
  return Array.isArray(response.candidates) && response.candidates.some(candidate => {
    const item = record(candidate);
    return !item || !safeRatings(item.safetyRatings);
  });
}

/** Metadata only: never include prompts, response text, URLs, names, or raw enums. */
function logSearchResponse(value: unknown, httpStatus: number, attemptId: string) {
  const response = record(value);
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const usage = record(response?.usageMetadata);
  const parts = candidates.flatMap(candidate => {
    const content = record(record(candidate)?.content);
    return Array.isArray(content?.parts) ? content.parts : [];
  });
  console.info("[vertex-search-response] " + JSON.stringify({
    attemptId, httpStatus, candidateCount: candidates.length,
    finishReasons: candidates.slice(0, 4).map(candidate => {
      const reason = record(candidate)?.finishReason;
      return typeof reason === "string" && SEARCH_FINISH_REASONS.has(reason) ? reason : "UNKNOWN_OR_MISSING";
    }),
    partCount: parts.length,
    textCharacters: parts.reduce((total, part) => {
      const item = record(part);
      return total + (typeof item?.text === "string" && item.thought !== true ? item.text.length : 0);
    }, 0),
    hasThoughtPart: parts.some(part => record(part)?.thought === true),
    blockedOrInvalidSafety: hasBlockOrInvalidSafety(value),
    inferredZeroOutput: zeroOutputSearchUsage(value as VertexResponse) !== null,
    usage: Object.fromEntries(SEARCH_USAGE_KEYS.map(key => [key, {
      present: !!usage && Object.prototype.hasOwnProperty.call(usage, key),
      value: tokenCount(usage?.[key]) ? usage[key] : null,
    }])),
  }));
}

/** Search-only no-result response. Missing usage is never generally treated as zero.
 * With a single unblocked STOP candidate and no output parts, the documented
 * total = prompt + candidates + tool + thoughts identity proves zero output only
 * when total equals a positive prompt count plus the reported thoughts, and the
 * candidate and tool-use counts are absent/zero. Gemini 3 may think a little even at
 * the MINIMAL level (billed as output, kept in the usage) and may attach an opaque
 * thoughtSignature to an empty part; neither is response text.
 */
function zeroOutputSearchUsage(result: VertexResponse): Record<string, number> | null {
  if (!Array.isArray(result?.candidates) || result.candidates.length !== 1 || hasBlockOrInvalidSafety(result)) return null;
  const candidate = record(result.candidates[0]);
  if (candidate?.finishReason !== "STOP") return null;
  if (candidate.content !== undefined) {
    const content = record(candidate.content);
    if (!content || Object.keys(content).some(key => key !== "role" && key !== "parts")) return null;
    if (content.role !== undefined && content.role !== "model") return null;
    if (content.parts !== undefined && (!Array.isArray(content.parts) || !content.parts.every(part => {
      const item = record(part);
      return item && item.text === "" && (item.thought === undefined || item.thought === false)
        && (item.thoughtSignature === undefined || (typeof item.thoughtSignature === "string" && item.thoughtSignature !== ""))
        && Object.keys(item).every(key => key === "text" || key === "thought" || key === "thoughtSignature");
    }))) return null;
  }
  const usage = record(result.usageMetadata);
  if (!usage || !tokenCount(usage.promptTokenCount) || usage.promptTokenCount === 0) return null;
  if (SEARCH_USAGE_KEYS.some(key => usage[key] !== undefined && !tokenCount(usage[key]))) return null;
  if (["candidatesTokenCount", "toolUsePromptTokenCount"].some(key => usage[key] !== undefined && usage[key] !== 0)) return null;
  if (usage.totalTokenCount !== usage.promptTokenCount + ((usage.thoughtsTokenCount as number | undefined) ?? 0)) return null;
  if (typeof usage.cachedContentTokenCount === "number" && usage.cachedContentTokenCount > usage.promptTokenCount) return null;
  const promptTokens = usage.promptTokenCount;
  for (const key of ["promptTokensDetails", "cacheTokensDetails", "candidatesTokensDetails", "toolUsePromptTokensDetails"]) {
    if (usage[key] !== undefined && (!Array.isArray(usage[key]) || !usage[key].every(detail => {
      const item = record(detail);
      return item && tokenCount(item.tokenCount) && (["candidatesTokensDetails", "toolUsePromptTokensDetails"].includes(key)
        ? item.tokenCount === 0 : item.tokenCount <= promptTokens);
    }))) return null;
  }
  return safeVertexUsage({ ...usage, candidatesTokenCount: 0 });
}

export async function vertexGenerate(opts: VertexOptions, dependencies?: VertexDependencies) {
  const config = vertexConfiguration();
  const schemaBytes = opts.responseSchema ? Buffer.byteLength(JSON.stringify(opts.responseSchema), "utf8") : 0;
  if (Buffer.byteLength(opts.system + opts.user, "utf8") + schemaBytes > VERTEX_MAX_INPUT_BYTES) throw new VertexError("input_limit", "今回のAI検証では入力が長すぎます。文章を短くして再実行してください。");
  if (opts.audio && (!["audio/wav", "audio/webm", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac"].includes(opts.audio.mimeType) || Buffer.byteLength(opts.audio.data, "base64") > 6 * 1024 * 1024)) throw new VertexError("audio_limit", "AI接続検証では6MB以下の音声ファイルを使用してください。");
  const maxOutputTokens = Math.min(opts.maxTokens ?? 2000, VERTEX_MAX_OUTPUT);
  const maxAttempts = opts.maxAttempts ?? 3;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
    || (opts.responseSchema && !opts.json) || (opts.search && (opts.audio || opts.json))) throw new VertexError("request_invalid", "AIリクエストの設定を確認してください。");
  const request = dependencies?.request ?? vertexTransport();
  const store = dependencies?.store ?? vertexLedgerStore(config.bucket, request);
  const sleep = dependencies?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = dependencies?.random ?? Math.random;
  // Count + all generation attempts share one deadline. Unknown transport/timeouts
  // are never replayed; only an explicit 429 can be retried, at most maxAttempts - 1 (default twice).
  const deadline = Date.now() + 120000;
  const remainingSignal = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new VertexError("timeout", "AIの応答待ちが制限時間を超えました。少し待ってから再実行してください。");
    return AbortSignal.timeout(remaining);
  };
  const contents = [{ role: "user", parts: [{ text: opts.user }, ...(opts.audio ? [{ inlineData: opts.audio }] : [])] }];
  let countedInput = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    vertexConfiguration();
    // Each actual retry consumes a new reservation; prior failures are retained.
    const id = await reserveVertexAttempt(store, opts.feature ?? "other", config.model, opts.search);
    let retryAfter: string | null = null;
    // Set once a successful search response arrives (null until its query list is read): its queries are billed
    // even if the response is later rejected or its body cannot be read. Failures before a response leave it unset.
    let searchQueries: number | null | undefined;
    let searchQueriesFlagged = false;
    const searchRecord = () => searchQueries === undefined ? {} : { searchQueries };
    const flagSearchQueries = () => {
      if (searchQueriesFlagged || searchQueries === undefined || (searchQueries !== null && searchQueries <= SEARCH_QUERIES_WITHIN_RESERVATION)) return;
      searchQueriesFlagged = true;
      console.error("[vertex-search-queries] " + JSON.stringify({ attemptId: id, searchQueries, withinReservation: SEARCH_QUERIES_WITHIN_RESERVATION }));
    };
    try {
      if (!countedInput) {
        const counted = await request(`https://aiplatform.googleapis.com/v1/projects/${config.project}/locations/global/publishers/google/models/${config.model}:countTokens`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: remainingSignal(),
          body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: opts.system }] } }),
        });
        if (!counted.ok) throw new VertexError(`count_${counted.status}`, "AIの入力サイズを確認できないため、生成を停止しました。");
        const { totalTokens } = await counted.json();
        // countTokens covers the source/system. Reserve one token per schema byte
        // as additional headroom instead of omitting schema input from the cap.
        if (!Number.isSafeInteger(totalTokens) || totalTokens < 0 || totalTokens + schemaBytes > 32768) throw new VertexError("input_limit", "今回のAI検証では入力が長すぎます。短い文章・音声で再実行してください。");
        countedInput = true;
      }
      const result = await measureAiCall({ provider: "vertex", model: config.model, feature: opts.feature, search: opts.search === true }, async () => {
        const response = await request(`https://aiplatform.googleapis.com/v1/projects/${config.project}/locations/global/publishers/google/models/${config.model}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Vertex-AI-LLM-Request-Type": "shared" }, signal: remainingSignal(),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: opts.system }] },
            contents: [{ role: "user", parts: [{ text: opts.user }, ...(opts.audio ? [{ inlineData: opts.audio }] : [])] }],
            // Gemini 3.5 Flash-Lite: thinking is set by level (a numeric thinkingBudget is not supported on Gemini 3 and
            // is rejected together with thinkingLevel). MINIMAL is the lowest level and cannot guarantee zero thinking;
            // thinking tokens count toward maxOutputTokens and are billed as output. The model ignores custom
            // temperature/topP/topK and Google recommends the defaults for Gemini 3, so sampling parameters and
            // candidateCount (default 1) are not sent.
            generationConfig: { maxOutputTokens, thinkingConfig: { thinkingLevel: "MINIMAL" }, ...(opts.json ? { responseMimeType: "application/json", ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}) } : {}) },
            ...(opts.search ? { tools: [{ googleSearch: {} }] } : {}),
            labels: { application: "luma-platform-development", purpose: "verification" },
          }),
        });
        if (!response.ok) {
          if (opts.search) logSearchResponse(undefined, response.status, id);
          if (response.status === 429) {
            retryAfter = response.headers.get("retry-after");
            throw new VertexError("http_429", "AIサービスが混み合っているか、呼び出し制限に達しています（429）。少し待ってから再実行してください。");
          }
          throw new VertexError(`http_${response.status}`, [401, 403].includes(response.status)
            ? `AI接続の認証・権限を確認してください（${response.status}）。`
            : `AIサービスとの通信に失敗しました（${response.status}）。時間をおいて再実行してください。`);
        }
        if (opts.search) searchQueries = null;
        let payload: VertexResponse;
        try {
          payload = await response.json() as VertexResponse;
        } catch (error) {
          if (opts.search) logSearchResponse(undefined, response.status, id);
          throw error;
        }
        if (opts.search) logSearchResponse(payload, response.status, id);
        return payload;
      }, r => (opts.search ? zeroOutputSearchUsage(r) : null) ?? r.usageMetadata, opts.search ? searchQueryCount : undefined);
      if (opts.search) {
        searchQueries = searchQueryCount(result);
        flagSearchQueries();
      }
      const noSearchResultUsage = opts.search ? zeroOutputSearchUsage(result) : null;
      // Thinking counts toward maxOutputTokens, so a response cut off while thinking may omit candidatesTokenCount.
      // It is incomplete (callers can split the input), not missing usage; the reservation is kept either way.
      if (!noSearchResultUsage && result.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new VertexError("incomplete", "AIの応答が完了しませんでした。入力を短くして再実行してください。");
      const usage = noSearchResultUsage ?? safeVertexUsage(result.usageMetadata);
      if (!usage) throw new VertexError("usage_missing", "AIの利用量を確認できませんでした。追加実行前に利用記録を確認してください。");
      if (noSearchResultUsage) {
        await finishVertexAttempt(store, id, { status: "success", usage, ...searchRecord() });
        return { text: "", usage, model: config.model, groundingMetadata: result.candidates![0].groundingMetadata, noSearchResult: true };
      }
      const candidate = result.candidates?.[0];
      if (candidate?.finishReason !== "STOP") throw new VertexError("incomplete", "AIの応答が完了しませんでした。入力を短くして再実行してください。");
      const text = candidate.content?.parts?.filter(p => !p.thought).map(p => p.text ?? "").join("").trim();
      if (!text) throw new VertexError("empty", "AIから文章を取得できませんでした。");
      await finishVertexAttempt(store, id, { status: "success", usage, ...searchRecord() });
      return { text, usage, model: config.model, groundingMetadata: candidate.groundingMetadata, noSearchResult: false };
    } catch (error) {
      const code = error instanceof VertexError ? error.code : "transport";
      flagSearchQueries();
      let finalized = false;
      try {
        await finishVertexAttempt(store, id, { status: "error", errorCode: code, ...searchRecord() });
        finalized = true;
      } catch {
        console.error("[vertex] ledger finalization failed; reservation retained");
      }
      if (code === "http_429" && finalized && attempt < maxAttempts - 1) {
        const delay = retryDelay(retryAfter, attempt, random);
        if (Date.now() + delay < deadline) {
          await sleep(delay);
          if (Date.now() < deadline) continue;
        }
      }
      throw error instanceof VertexError ? error : new VertexError(code, vertexFailure(error));
    }
  }
  throw new VertexError("retry_exhausted", "AIへの再試行回数の上限に達しました。少し待ってから再実行してください。");
}
/** Gemini 3 grounding is billed per search query the model ran (groundingMetadata.webSearchQueries), and one
 * request can run several. Without that list the count is unknown (null), never zero. */
export function searchQueryCount(result: VertexResponse): number | null {
  if (!Array.isArray(result?.candidates) || result.candidates.length !== 1) return null;
  const queries = record(record(result.candidates[0])?.groundingMetadata)?.webSearchQueries;
  return Array.isArray(queries) && queries.every(query => typeof query === "string") ? queries.length : null;
}
export function safeVertexUsage(raw?: Record<string, unknown>): Record<string, number> | null {
  if (!raw || !["promptTokenCount", "candidatesTokenCount", "totalTokenCount"].every(k => typeof raw[k] === "number" && Number.isSafeInteger(raw[k]) && (raw[k] as number) >= 0)) return null;
  return Object.fromEntries(["promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "cachedContentTokenCount", "totalTokenCount"].flatMap(k => typeof raw[k] === "number" && Number.isSafeInteger(raw[k]) && (raw[k] as number) >= 0 ? [[k, raw[k]]] : []));
}
