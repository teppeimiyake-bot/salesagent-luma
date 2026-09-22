/**
 * Vertex AI を呼ぶための Google 認証クライアント（鍵レス）
 *
 * 組織ポリシー `iam.disableServiceAccountKeyCreation` により SA 鍵が発行できず、
 * Vercel のサーバレス環境には鍵ファイルも置けない。そのため
 * Workload Identity Federation + Vercel OIDC で SA になりすます。
 *
 * この方式は `agent-proxy/lib/gcp.ts` で既に本番稼働している。ここはその移植で、
 * 違いは「Cloud Run 用の ID トークンを返す」のではなく「Vertex AI SDK に渡す
 * AuthClient を返す」ことだけ。
 *
 * ローカル開発では WIF が使えないので ADC にフォールバックする
 * （禁止されているのは *SA 鍵* であって、ユーザーの application-default 資格情報は問題ない）。
 *
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project lumaagentlist
 *
 * 必要な環境変数（WIF 時）:
 *   GCP_PROJECT_NUMBER / GCP_WORKLOAD_IDENTITY_POOL_ID /
 *   GCP_WORKLOAD_IDENTITY_PROVIDER_ID / GCP_SERVICE_ACCOUNT_EMAIL
 */

import type { AuthClient } from "google-auth-library";
import { ExternalAccountClient, GoogleAuth, Impersonated } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/functions/oidc";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// クライアントはモジュールスコープで保持する。Impersonated はアクセストークンを
// 内部でキャッシュするので、保持さえすれば cold start 以外の追加レイテンシは無い。
let cachedClient: AuthClient | null = null;

export type VertexAuthMode = "wif" | "adc";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です`);
  return v;
}

/** WIF（Vercel 上）と ADC（ローカル）のどちらで認証するか。 */
export function vertexAuthMode(): VertexAuthMode {
  if (process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL) return "wif";
  return "adc";
}

/** WIF に必要な環境変数が揃っているか。 */
export function hasWifConfig(): boolean {
  return Boolean(
    process.env.GCP_PROJECT_NUMBER &&
      process.env.GCP_WORKLOAD_IDENTITY_POOL_ID &&
      process.env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID &&
      process.env.GCP_SERVICE_ACCOUNT_EMAIL,
  );
}

function buildImpersonated(): Impersonated {
  const projectNumber = env("GCP_PROJECT_NUMBER");
  const poolId = env("GCP_WORKLOAD_IDENTITY_POOL_ID");
  const providerId = env("GCP_WORKLOAD_IDENTITY_PROVIDER_ID");
  const saEmail = env("GCP_SERVICE_ACCOUNT_EMAIL");

  const audience =
    `//iam.googleapis.com/projects/${projectNumber}` +
    `/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // 連携（federated）クライアント: Vercel OIDC トークンを subject token として STS に渡す
  const source = ExternalAccountClient.fromJSON({
    type: "external_account",
    audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    subject_token_supplier: {
      getSubjectToken: async () => await getVercelOidcToken(),
    },
  });
  if (!source) throw new Error("WIF 認証クライアントの構築に失敗しました");

  return new Impersonated({
    sourceClient: source,
    targetPrincipal: saEmail,
    lifetime: 3600,
    targetScopes: [CLOUD_PLATFORM_SCOPE],
  });
}

/** Vertex AI SDK に渡す認証クライアントを返す。 */
export async function getGoogleAuthClient(): Promise<AuthClient> {
  if (cachedClient) return cachedClient;

  if (vertexAuthMode() === "wif") {
    cachedClient = buildImpersonated();
  } else {
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    cachedClient = await auth.getClient();
  }
  return cachedClient;
}

/**
 * アクセストークンを直接取る。
 * `@ai-sdk/google-vertex` が authClient を受け付けなかった場合の
 * フォールバック経路（custom fetch で Authorization ヘッダを付ける）で使う。
 */
export async function getGoogleAccessToken(): Promise<string> {
  const client = await getGoogleAuthClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("Google アクセストークンを取得できませんでした");
  return token;
}

/**
 * Vercel OIDC トークンの `sub` クレーム。
 * WIF のバインド（principal://.../subject/owner:TEAM:project:APP:environment:ENV）を
 * 実値で確定させるために /api/health/ai で返す。失敗しても null を返すだけ。
 */
export function peekOidcSubject(): string | null {
  const raw = process.env.VERCEL_OIDC_TOKEN;
  if (!raw) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(raw.split(".")[1], "base64").toString("utf-8"),
    );
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** テスト用: キャッシュしたクライアントを捨てる。 */
export function resetAuthCache(): void {
  cachedClient = null;
}
