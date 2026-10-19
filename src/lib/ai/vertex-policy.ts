/** Fixed, short-lived verification policy for this Luma service only. */
export const VERTEX_PROJECT = "lumaagentlist";
export const VERTEX_SERVICE = "luma-platform-development";
export const VERTEX_BUCKET = "lumaagentlist-luma-dev-uploads";
// 2026-09-28 ユーザー承認で gemini-2.5-flash（2026-10-20 終了予定）から、公式の後継 gemini-3.5-flash-lite へ切替。
// 公開単価は 2.5 Flash と同じ（入力 $0.30・出力 $2.50/100万token、音声入力は 2.5 の $1.00 から $0.30）で、1回20円の予約は据え置く。
export const VERTEX_MODEL = "gemini-3.5-flash-lite";
export const VERTEX_BUDGET_KEY = "verification/vertex-budget-20260923.json";
export const VERTEX_MAX_INPUT_BYTES = 65536;
export const VERTEX_MAX_OUTPUT = 8192;
// Pessimistic reservation, never refunded: at most 25,000 JPY reserved.
// Includes all previous allowances; historical attempts are carried forward.
// The remaining 5,000 JPY of the user's 30,000 JPY envelope is for app infrastructure.
// Actual token usage is recorded separately. This is not a Cloud Billing total.
export const VERTEX_RESERVATION_JPY = 20;
export const VERTEX_BUDGET_JPY = 25000;
// 2026-09-28 ユーザー承認で延長（旧期限 2026-09-26 00:00 JST）。当時のモデル gemini-2.5-flash の終了予定（2026-10-20）の前日の終わり＝2026-10-20 00:00 JST まで。
// モデル切替後も値は据え置き（さらに延ばす場合は別途の承認で変える）。
export const VERTEX_POLICY_EXPIRES = "2026-10-19T15:00:00.000Z";
// 延長は LUMA_VERTEX_POLICY_EXPIRES（ISO 8601）で行う。設定する人が期間と費用の承認を取ってから入れる。
// 読めない値は期限切れとして扱う（fail closed）。
export const VERTEX_POLICY_EXPIRES_ENV = "LUMA_VERTEX_POLICY_EXPIRES";
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
export function vertexConfiguration(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (env.LUMA_CLOUD_AI_MODE !== "vertex" || env.AI_PROVIDER !== "vertex" || env.AI_PROVIDER_HEAVY !== "vertex"
    || env.LUMA_DEPLOYMENT_ENV !== "development" || !onVerificationHost(env)
    || env.GOOGLE_CLOUD_PROJECT !== VERTEX_PROJECT || env.LUMA_DEVELOPMENT_PROJECT_ID !== VERTEX_PROJECT
    || env.VERTEX_LOCATION !== "global" || env.VERTEX_MODEL !== VERTEX_MODEL
    || env.LUMA_DEVELOPMENT_UPLOAD_BUCKET !== VERTEX_BUCKET || env.LUMA_VERTEX_BUDGET_JPY !== String(VERTEX_BUDGET_JPY)) {
    throw new VertexError("configuration", "AI接続設定が未完了です。検証用の接続設定を確認してください。");
  }
  const expires = Date.parse(env[VERTEX_POLICY_EXPIRES_ENV] ?? VERTEX_POLICY_EXPIRES);
  if (!Number.isFinite(expires) || now >= expires) throw new VertexError("expired", "AI検証の利用期間が終了しました。費用と接続設定を確認してください。");
  return { project: VERTEX_PROJECT, location: "global", model: VERTEX_MODEL, bucket: VERTEX_BUCKET };
}
export function vertexConfigured() { try { vertexConfiguration(); return true; } catch { return false; } }
export function vertexFailure(error: unknown): string {
  return error instanceof VertexError ? error.message : "AIとの通信に失敗しました。時間をおいて接続状況を確認してください。";
}
