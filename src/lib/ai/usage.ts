import { randomUUID } from "node:crypto";

export type AiFeature = "brief" | "minutes" | "bant" | "context" | "transcription" | "meeting_extract" | "other";
export type AiMeasurement = {
  id: string; feature: AiFeature; provider: string; model: string;
  startedAt: string; elapsedMs: number; status: "success" | "error";
  // Vertex: whether the request carried the Google Search tool.
  search?: boolean;
  // Vertex Gemini 3+: search queries the model ran (grounding is billed per query). null = unknown.
  searchQueries?: number | null;
  // A missing usage response is unknown, never zero cost.
  usage: Record<string, unknown> | null;
};

/** One record per provider request/turn; no prompts, output, credentials, or customer names. */
export async function measureAiCall<T>(
  info: { feature?: AiFeature; provider: string; model: string; search?: boolean },
  call: () => Promise<T>,
  getUsage: (result: T) => unknown,
  getSearchQueries?: (result: T) => number | null,
): Promise<T> {
  const started = Date.now();
  const record: AiMeasurement = {
    ...info, feature: info.feature ?? "other", id: randomUUID(),
    startedAt: new Date(started).toISOString(), elapsedMs: 0, status: "error", usage: null,
  };
  try {
    const result = await call();
    record.status = "success";
    const usage = getUsage(result);
    if (usage && typeof usage === "object") record.usage = JSON.parse(JSON.stringify(usage));
    if (getSearchQueries) record.searchQueries = getSearchQueries(result);
    return result;
  } finally {
    record.elapsedMs = Date.now() - started;
    console.info("[ai-usage] " + JSON.stringify(record));
  }
}

export type TokenRates = {
  input: number; output: number; cacheRead: number; cacheWrite: number; search: number;
  // Vertex AUDIO-modality input, JPY/1M tokens. Unset/null means unverified: audio calls stay unknown.
  audioInput?: number | null;
};
const REQUIRED_RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "search"] as const;
/** Vertex Google Search grounding is billed per grounded request up to Gemini 2.x and per search query from Gemini 3. */
export function vertexSearchBilledPerQuery(model: string): boolean {
  const major = /^gemini-(\d+)(?:[.-]|$)/.exec(model)?.[1];
  // An unrecognized model name is priced the stricter way: it needs a recorded query count.
  return major === undefined || Number(major) >= 3;
}
/** Caller supplies JPY/1M token rates and JPY/search, verified for this model/date. Vertex search is JPY per
 * grounded request for Gemini 2.x and JPY per search query for Gemini 3+ (see vertexSearchBilledPerQuery).
 * Every key except audioInput is required (Vertex has no cache write: set cacheWrite to 0).
 * Audio is priced only for Vertex AUDIO-modality tokens with audioInput; other audio/multimodal billing is excluded.
 */
export function estimateTextCost(record: AiMeasurement, rates: TokenRates): number | null {
  if (!rates || typeof rates !== "object") throw Error("Invalid rates");
  const { audioInput, ...tokenRates } = rates;
  const valid = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  // A missing key is invalid too: an omitted rate (e.g. Vertex cacheWrite) would otherwise price as NaN.
  if (!REQUIRED_RATE_KEYS.every(key => valid(tokenRates[key])) || !Object.values(tokenRates).every(valid)
    || (audioInput != null && !valid(audioInput))) throw Error("Invalid rates");
  const u = record.usage;
  if (!u || record.status !== "success" || (record.feature === "transcription" && record.provider !== "vertex")) return null;
  const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  // AUDIO tokens in a Vertex *TokensDetails list. Undefined when the list is malformed, has an unknown modality,
  // or does not add up to `count`: an unexplained remainder could be audio, so it is never priced as text.
  const audioTokens = (details: unknown, count: unknown) => {
    if (!Array.isArray(details) || !numeric(count)) return undefined;
    let total = 0, audio = 0;
    for (const detail of details as Array<{ modality?: unknown; tokenCount?: unknown } | null>) {
      if (!detail || typeof detail !== "object" || !numeric(detail.tokenCount)) return undefined;
      if (typeof detail.modality !== "string" || detail.modality === "MODALITY_UNSPECIFIED") return undefined;
      total += detail.tokenCount;
      if (detail.modality === "AUDIO") audio += detail.tokenCount;
    }
    return total === count ? audio : undefined;
  };
  let input: unknown, output: unknown, read: unknown, write: unknown, search: unknown = 0, audio: unknown = 0;
  if (record.provider === "anthropic") {
    input = u.input_tokens; output = u.output_tokens;
    read = u.cache_read_input_tokens ?? 0; write = u.cache_creation_input_tokens ?? 0;
    // Web search without a usage counter is not free; await a complete measurement.
    search = (u.server_tool_use as { web_search_requests?: number } | undefined)?.web_search_requests
      ?? (record.feature === "brief" ? undefined : 0);
  } else if (record.provider === "gemini") {
    const details = u.inputTokenDetails as Record<string, unknown> | undefined;
    read = details?.cacheReadTokens ?? u.cachedInputTokens ?? 0;
    write = details?.cacheWriteTokens ?? 0;
    input = details?.noCacheTokens ?? (numeric(u.inputTokens) && numeric(read) && numeric(write) ? u.inputTokens - read - write : undefined);
    output = u.outputTokens;
  } else if (record.provider === "vertex") {
    // promptTokenCount includes cached tokens. Thinking is output. Tool-use (search result) tokens are input up to
    // Gemini 2.x; from Gemini 3 the search results given to the model are not charged.
    // Explicit context-cache storage is billed by time and unused here, so there is no cache write.
    const perQuery = vertexSearchBilledPerQuery(record.model);
    const prompt = u.promptTokenCount, cached = u.cachedContentTokenCount ?? 0, tool = perQuery ? 0 : u.toolUsePromptTokenCount ?? 0;
    const candidates = u.candidatesTokenCount, thoughts = u.thoughtsTokenCount ?? 0;
    const reportedAudio = u.promptTokensDetails === undefined ? 0 : audioTokens(u.promptTokensDetails, prompt);
    // Transcription always sends audio: a missing breakdown or one without AUDIO tokens would price the audio as text.
    const promptAudio = record.feature === "transcription" && !(numeric(reportedAudio) && reportedAudio > 0) ? undefined : reportedAudio;
    // Cached audio has its own discounted price, which is not configured: unknown, not the text cache rate.
    const cachedAudio = u.cacheTokensDetails === undefined ? (cached === 0 || promptAudio === 0 ? 0 : undefined) : audioTokens(u.cacheTokensDetails, cached);
    read = cached; write = 0; audio = cachedAudio === 0 ? promptAudio : undefined;
    input = numeric(prompt) && numeric(cached) && numeric(audio) && numeric(tool) && prompt >= cached + audio ? prompt - cached - audio + tool : undefined;
    output = numeric(candidates) && numeric(thoughts) ? candidates + thoughts : undefined;
    // Gemini 2.x: charged per grounded request; every request with the search tool is counted (upper bound, no free quota).
    // Gemini 3+: charged per search query; a search request without a recorded query count is unknown, never zero.
    // No free quota is assumed either way. Older records lack the flag, and only brief uses search.
    search = typeof record.search === "boolean"
      ? (!record.search ? 0 : perQuery ? (numeric(record.searchQueries) && Number.isSafeInteger(record.searchQueries) ? record.searchQueries : undefined) : 1)
      : record.feature === "brief" ? undefined : 0;
  } else return null;
  if (!numeric(input) || !numeric(output) || !numeric(read) || !numeric(write) || !numeric(search) || !numeric(audio)) return null;
  // Audio without a verified audio rate is unknown, never zero.
  if (audio > 0 && audioInput == null) return null;
  return (input * rates.input + output * rates.output + read * rates.cacheRead + write * rates.cacheWrite + audio * (audioInput ?? 0)) / 1_000_000 + search * rates.search;
}

/** Unknown measurements prevent a misleading zero-cost monthly forecast. */
export function forecastMonthly(unitJpy: Array<number | null>, counts: number[], fixedJpy: number | null): number | null {
  if (unitJpy.length !== counts.length || counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw Error("Invalid volume");
  if (fixedJpy === null || unitJpy.some(n => n === null)) return null;
  if (![fixedJpy, ...unitJpy].every(n => n !== null && Number.isFinite(n) && n >= 0)) throw Error("Invalid cost");
  return fixedJpy + unitJpy.reduce<number>((sum, n, i) => sum + n! * counts[i], 0);
}
