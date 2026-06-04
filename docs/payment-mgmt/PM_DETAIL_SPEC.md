# PMタブ拡張仕様（Phase 3.5 / 社長フィードバック 2026-06-04）

Phase 3 の `/pm`（ProductionProject）に対する社長フィードバックを反映する。映像とSNSで管理項目を作り分ける。

## 共通：商談・顧客DBへの紐付け（最重要）
- **プロジェクト名／顧客名は商談（Deal）・顧客DB（Company）に紐づける**。PM上の自由文字列ではなく、`companyId`（FK→Company）／`dealId`／`dealProductId` を正とし、表示名は `Company.name`、プラン名は `DealProduct.planName` を引く。手動上書き用の任意フィールドは残してよい。
- **顧客名はクリック可能**。クリックで **詳細ページ `/pm/[id]` が新規に開く**（`target=_blank` もしくは別ルート）。
- 詳細ページに以下を格納・表示：
  - 各種ステータス（映像/SNSそれぞれの管理項目／インライン編集）
  - **打ち合わせ議事録**：紐づくDealの `Meeting`（minutes/summary/transcript）を一覧表示。詳細ページから参照（できれば新規メモ追加も）。
  - **絵コンテ・香盤表のリンク**（スプレッドシートで作成済のものをURL格納）。映像＝絵コンテURL/香盤表URL、SNS＝管理シートURL（スケジュール・企画書・香盤表を1スプシで管理）。
  - **提案企画書**：紐づくDealの `Document`（category=proposal, scope=deal）を一覧表示・リンク。商談から自動で引く。

## 映像（既存項目を維持＋詳細ページ）
- 一覧カラムは現状維持：ステータス／PM／撮影日／仮納品予定日／納品予定日／ディレクター／カメラ／編集／備考／納品済。
- 詳細ページに 絵コンテURL・香盤表URL・議事録・提案企画書 を追加。

## SNS（項目を作り替え）
- **撮影日・仮納品予定日・納品予定日 は不要**（SNSカードでは非表示）。
- 代わりに以下を格納（元データ `docs/payment-mgmt/SNS運用管理.csv`、12クライアント）：
  - **プラン名**（ライト/スタンダード/プレミアム/イレギュラー）→ **商談に紐付け**（DealProduct.planName）
  - **会社名** → **顧客DB／商談に紐付け**（Company）
  - **総投稿本数**（例「24本（月4本）」テキスト）
  - **提供開始月 / 提供終了月**（date）
  - **管理シートリンク**（スケジュール・企画書・香盤表のスプシURL）
  - **媒体別アカウント**（YouTube / Instagram / TikTok ごとに）：ID／pass／プロフリンク／三宅PCログイン(bool)
- 媒体アカウントは新モデル `SnsAccount`（productionProjectId × platform 一意、accountId/password/profileUrl/miyakePcLogin）。
- セキュリティ：passwordは内部ツール用に平文保存だが、UIは伏字＋表示トグル、参照は権限（user以上）でガード。将来の暗号化はTODOコメント。

## スキーマ変更（追加）
`ProductionProject` に追加：
- `companyId String?`（FK→Company・逆リレーション）※既存dealProduct経由でも辿れるが、表示/フィルタ用に明示FK
- 映像：`storyboardUrl String?` / `shootingScheduleUrl String?`
- SNS：`totalPosts String?` / `serviceStartMonth DateTime?` / `serviceEndMonth DateTime?` / `mgmtSheetUrl String?`
新モデル `SnsAccount`（id / productionProjectId FK / platform enum(YOUTUBE/INSTAGRAM/TIKTOK) / accountId / password / profileUrl / miyakePcLogin Boolean）。`@@unique([productionProjectId, platform])`。

`scripts/sql/add-payment-pm-tables.sql`（本番反映用）に ALTER/CREATE を追記（冪等：`ADD COLUMN IF NOT EXISTS`／`CREATE TABLE IF NOT EXISTS`）。

## シード
`scripts/seed-sns-pm.ts`：`SNS運用管理.csv` をパースし、会社名で既存SNS ProductionProject（受注バックフィル済）にマッチして 総投稿本数/提供期間/管理シートリンク を補完、`SnsAccount` を upsert（platform単位）。重複企業注意（正規化名で一意に絞れる時のみ紐付け、曖昧は手動FK送り）。

## 完了条件
- `/pm` 映像タブ＝現状項目、SNSタブ＝新項目。顧客名クリックで `/pm/[id]` 詳細ページ。
- 詳細ページに 議事録（deal.meetings）・提案企画書（deal proposal documents）・絵コンテ/香盤表(映像)/管理シート(SNS)・SNSアカウント表 が出る。
- `tsc` / `build` PASS。dev DBで動作確認。push・本番反映はしない。
