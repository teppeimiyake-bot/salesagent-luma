/** Fixed verification policy for this Luma service only. */
export const VERTEX_PROJECT = "lumaagentlist";
export const VERTEX_SERVICE = "luma-platform-development";
export const VERTEX_BUCKET = "lumaagentlist-luma-dev-uploads";
// 2026-09-28 ユーザー承認で gemini-2.5-flash（2026-10-20 終了予定）から、公式の後継 gemini-3.5-flash-lite へ切替。
// 公開単価は 2.5 Flash と同じ（入力 $0.30・出力 $2.50/100万token、音声入力は 2.5 の $1.00 から $0.30）で、1回20円の予約は据え置く。
export const VERTEX_MODEL = "gemini-3.5-flash-lite";
export const VERTEX_BUDGET_KEY = "verification/vertex-budget-20260923.json";
export const VERTEX_MAX_INPUT_BYTES = 65536;
export const VERTEX_MAX_OUTPUT = 8192;
// Pessimistic reservation, never refunded: at most 45,000 JPY reserved.
// Includes all previous allowances; historical attempts are carried forward.
// 2026-10-19 ユーザー承認で、Vercel の検証環境（Preview）での UAT のため上限を 2 万円上げた（25,000 → 45,000 JPY）。
// The 5,000 JPY of the original 30,000 JPY envelope for app infrastructure is unchanged.
// Actual token usage is recorded separately. This is not a Cloud Billing total.
export const VERTEX_RESERVATION_JPY = 20;
export const VERTEX_BUDGET_JPY = 45000;
// 利用期間の期限は設けない（費用は上の予算で止める）。
// Vercel の検証用 Preview でも同じ Vertex 経路を使う（Production では使わない）。
export const VERTEX_VERCEL_ENV = "preview";

export class VertexError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "VertexError"; }
}
/**
 * 検証用の実行先か。Cloud Run は検証用サービス名（K_SERVICE）で、Vercel は Preview（VERCEL_ENV）で判定する。
 * Vercel の Production（本番）と、どちらでもない環境では使わない。
 */
function onVerificationHost(env: NodeJS.ProcessEnv): boolean {
  if (env.K_SERVICE !== undefined) return env.K_SERVICE === VERTEX_SERVICE;
  return env.VERCEL === "1" && env.VERCEL_ENV === VERTEX_VERCEL_ENV;
}
export function vertexConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.LUMA_CLOUD_AI_MODE !== "vertex" || env.AI_PROVIDER !== "vertex" || env.AI_PROVIDER_HEAVY !== "vertex"
    || env.LUMA_DEPLOYMENT_ENV !== "development" || !onVerificationHost(env)
    || env.GOOGLE_CLOUD_PROJECT !== VERTEX_PROJECT || env.LUMA_DEVELOPMENT_PROJECT_ID !== VERTEX_PROJECT
    || env.VERTEX_LOCATION !== "global" || env.VERTEX_MODEL !== VERTEX_MODEL
    || env.LUMA_DEVELOPMENT_UPLOAD_BUCKET !== VERTEX_BUCKET || env.LUMA_VERTEX_BUDGET_JPY !== String(VERTEX_BUDGET_JPY)) {
    throw new VertexError("configuration", "AI接続設定が未完了です。検証用の接続設定を確認してください。");
  }
  return { project: VERTEX_PROJECT, location: "global", model: VERTEX_MODEL, bucket: VERTEX_BUCKET };
}
export function vertexConfigured() { try { vertexConfiguration(); return true; } catch { return false; } }
export function vertexFailure(error: unknown): string {
  return error instanceof VertexError ? error.message : "AIとの通信に失敗しました。時間をおいて接続状況を確認してください。";
}
