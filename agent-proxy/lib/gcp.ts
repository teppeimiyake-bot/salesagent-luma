import { ExternalAccountClient, Impersonated } from "google-auth-library";
import { getVercelOidcToken } from "@vercel/functions/oidc";

// 非公開 Cloud Run を呼ぶための Google ID トークンを発行する。
// 鍵レス（Workload Identity Federation + Vercel OIDC）方式:
//   Vercel の OIDC トークン → GCP STS で連携 → SA(agent-proxy-invoker) になりすまし
//   → Cloud Run URL を audience とする ID トークンを generateIdToken で取得。
// SA 鍵ファイルは一切使わない。トークンは期限5分前までメモリキャッシュ。

let cachedToken: string | null = null;
let cachedExp = 0; // epoch 秒
let impersonatedClient: Impersonated | null = null;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です`);
  return v;
}

function cloudRunUrl(): string {
  return env("CLOUD_RUN_URL").replace(/\/+$/, "");
}

function buildImpersonated(): Impersonated {
  if (impersonatedClient) return impersonatedClient;

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

  // 連携アイデンティティで SA になりすまし、その SA として ID トークンを発行する
  impersonatedClient = new Impersonated({
    sourceClient: source,
    targetPrincipal: saEmail,
    lifetime: 3600,
    targetScopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return impersonatedClient;
}

function decodeExp(jwt: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf-8"),
    );
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

export async function getIdToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedExp - now > 300) return cachedToken;

  const client = buildImpersonated();
  const token = await client.fetchIdToken(cloudRunUrl(), { includeEmail: true });

  cachedToken = token;
  cachedExp = decodeExp(token);
  return token;
}

export { cloudRunUrl };
