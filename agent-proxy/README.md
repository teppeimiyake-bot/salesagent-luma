# agent-proxy — 非公開 Cloud Run への認証付きリバースプロキシ

Luma サイドバー「エージェント」から、**手元でローカルプロキシを起動しなくても**
非公開の Cloud Run 上のエージェント UI（`sales-agent`）へオンラインで到達するための、
Vercel 上の小さなリバースプロキシです。

## 仕組み

```
Luma ログイン済み → /agent「エージェントを開く」
  → GET /api/agent/open (Luma: セッション確認 → 短命グラントJWT発行) → 302
  → https://<このプロキシ>/__grant?token=…  (グラント検証 → セッションCookie発行) → 302 /
  → キャッチオール (Cookie検証 → Google IDトークン付与 → 非公開 Cloud Run へ転送)
  → エージェントUI 表示
```

- Cloud Run は `--no-allow-unauthenticated`（非公開）のまま。公開しない。
- プロキシが **鍵レス（WIF + Vercel OIDC）**で SA になりすまし、Cloud Run 用の **ID トークン**を
  発行して呼ぶので、ブラウザは Cloud Run を直接叩かず、SA 鍵ファイルも存在しない。
- プロキシへの到達は **Luma のログイン**でガード（グラント引き換え方式）。
- `app.js` が絶対パス（`/api`, `/static`）で API を呼ぶため、**プロキシは専用ホストの
  ルートに丸ごと**割り当てる（サブパス配下では動かない）。無料の `*.vercel.app` で可。

## デプロイ手順

> 組織ポリシー `iam.disableServiceAccountKeyCreation` により SA 鍵は作成できないため、
> 鍵レスの **Workload Identity Federation（WIF）+ Vercel OIDC** を使う。

前提の変数（自分の値に置き換える）:

- `PROJECT_ID=lumaagentlist` / `PROJECT_NUMBER=1043562868701` / `REGION=asia-northeast1`
- `SA=agent-proxy-invoker@lumaagentlist.iam.gserviceaccount.com`
- `TEAM_SLUG` = Vercel チームの slug（ダッシュボードURL `vercel.com/<TEAM_SLUG>` の部分）
- `PROJECT_NAME` = Vercel 上の agent-proxy プロジェクト名

### 1. GCP: SA 作成と run.invoker 付与

```bash
gcloud iam service-accounts create agent-proxy-invoker \
  --project lumaagentlist --display-name "agent-proxy invoker"

# sales-agent への invoker 権限（Cloud Run は非公開のまま）
gcloud run services add-iam-policy-binding sales-agent \
  --project lumaagentlist --region asia-northeast1 \
  --member "serviceAccount:agent-proxy-invoker@lumaagentlist.iam.gserviceaccount.com" \
  --role roles/run.invoker
```

### 2. GCP: 必要 API を有効化

```bash
gcloud services enable iam.googleapis.com sts.googleapis.com \
  iamcredentials.googleapis.com --project lumaagentlist
```

### 3. GCP: Workload Identity Pool / OIDC Provider を作成

Vercel の発行者（issuer）を信頼するプールとプロバイダを作る。`<TEAM_SLUG>` `<PROJECT_NAME>` を置換。

```bash
# プール
gcloud iam workload-identity-pools create vercel-pool \
  --project lumaagentlist --location global --display-name "Vercel OIDC pool"

# OIDC プロバイダ（Vercel を信頼。project/environment で絞り込み）
gcloud iam workload-identity-pools providers create-oidc vercel-oidc \
  --project lumaagentlist --location global \
  --workload-identity-pool vercel-pool --display-name "Vercel" \
  --issuer-uri "https://oidc.vercel.com/<TEAM_SLUG>" \
  --allowed-audiences "https://vercel.com/<TEAM_SLUG>" \
  --attribute-mapping "google.subject=assertion.sub" \
  --attribute-condition "assertion.sub.startsWith('owner:<TEAM_SLUG>:project:<PROJECT_NAME>:')"
```

### 4. GCP: 連携アイデンティティに SA なりすまし権限を付与

Vercel の本番環境からだけ SA になりすませるよう、正確な subject に束ねる。

```bash
gcloud iam service-accounts add-iam-policy-binding \
  agent-proxy-invoker@lumaagentlist.iam.gserviceaccount.com \
  --project lumaagentlist \
  --role roles/iam.serviceAccountTokenCreator \
  --member "principal://iam.googleapis.com/projects/1043562868701/locations/global/workloadIdentityPools/vercel-pool/subject/owner:<TEAM_SLUG>:project:<PROJECT_NAME>:environment:production"
```

### 5. Vercel: 別プロジェクトとして作成 + OIDC 有効化

- 同じ `salesagent-luma` リポジトリを import し、**Root Directory = `agent-proxy`**。
- **Settings → Security → OIDC（Secure Backend Access）を有効化**（`VERCEL_OIDC_TOKEN` が注入される）。
- Environment Variables（`.env.example` 参照。鍵は無い）:
  - `CLOUD_RUN_URL` = `https://sales-agent-1043562868701.asia-northeast1.run.app`
  - `GCP_PROJECT_NUMBER` = `1043562868701`
  - `GCP_WORKLOAD_IDENTITY_POOL_ID` = `vercel-pool`
  - `GCP_WORKLOAD_IDENTITY_PROVIDER_ID` = `vercel-oidc`
  - `GCP_SERVICE_ACCOUNT_EMAIL` = `agent-proxy-invoker@lumaagentlist.iam.gserviceaccount.com`
  - `AGENT_PROXY_GRANT_SECRET` = `openssl rand -hex 32`（Luma と**同一値**）
  - `AGENT_PROXY_SESSION_SECRET` = `openssl rand -hex 32`（このプロキシ単独値）
- デプロイして払い出された URL（例 `https://salesagent-agent-proxy.vercel.app`）を控える。

### 6. Luma 側の環境変数（Luma の Vercel プロジェクト）

- `AGENT_PROXY_URL` = 手順2のプロキシ URL
- `AGENT_PROXY_GRANT_SECRET` = 手順2と**同一値**

## 検証

1. `sales-agent` の run.app URL を認証なしで直叩き → **403**（非公開維持）。
2. プロキシ URL を Cookie 無しで直叩き → 「ログインが必要です」HTML（401）。
3. Luma にログイン → サイドバー「エージェント」→「開く」→ **ローカルプロキシ未起動**の状態で
   エージェント UI が HTTPS 表示される。dry-run を実行してログが流れ、結果が出ることを確認。

## 既知の制限

- Vercel 関数の実行時間上限（plan 次第で 60〜300 秒）で SSE 接続が定期的に切れるが、
  `EventSource` が自動再接続し、サーバ側（`web/run_manager.py`）が既存ログを replay して続きを
  配信するため実行は継続する。ログ枠に重複行が出る程度の見た目劣化のみ。
