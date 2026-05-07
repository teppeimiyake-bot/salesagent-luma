# Re;easy Sales Agent for Luma — フェーズ2 デプロイ手順書

- **作成日**: 2026-05-07
- **作成**: luma-sales-engineer
- **対象**: 株式会社Luma 社長（三宅）
- **対象フェーズ**: フェーズ2-A 完了 → フェーズ2-B（社長作業：GitHub / Vercel / Neon の実セットアップ）
- **前提**: フェーズ1（Gemini化）完了。ローカル `localhost:3003` で7段推論まで実APIで動作確認済み。

---

## 0. このハンドブックの読み方

フェーズ2-A（ローカル準備）は本書作成時点で**エンジニア側の作業はすべて完了**しています。
ここから先は**社長アカウントでの認証が必要**な作業のみが残っており、本書はそのチェックリストです。

各セクション末に「**所要**」「**コスト**」「**判断ポイント**」を明記。判断が要る箇所は飛ばさず読んでください。

順序：
1. **GitHub リポジトリ作成**（10〜15分）
2. **Vercel プロジェクト作成 + Neon 統合**（20〜30分）
3. **Vercel Blob 統合**（5分）
4. **環境変数登録**（10分）
5. **初回デプロイ**（自動・5〜10分）
6. **デプロイ後の動作確認**（15分）
7. **データ移行はフェーズ3**（本書範囲外）

トータル**実働1〜2時間**で `https://salesagent-luma-xxxx.vercel.app` が立ち上がる想定。

---

## 1. GitHub リポジトリ作成

### 1.1 推奨：GitHub Organization「reagey-inc」配下にPrivateで作る

理由：
- Vercel 組織もリージー法人で作るので、リポジトリも揃えた方が後の権限管理が楽
- Lumaの社員がリポジトリを直接見ることはない（営業ツールの**利用者**に過ぎないため）
- Pricing：GitHub Free でも Private リポジトリは無制限

### 1.2 手順

1. https://github.com/organizations/new で Organization を作る（既にあるならスキップ）
   - Org 名（例）: `reagey-inc`
   - プラン: **Free**
2. https://github.com/organizations/reagey-inc/repositories/new で新規リポジトリ
   - Repository name: `salesagent-luma`
   - Visibility: **Private**
   - Initialize: **すべてチェックを外す**（ローカルからpushするため）
3. 「Create repository」後、表示される URL をコピー（例: `git@github.com:reagey-inc/salesagent-luma.git`）

### 1.3 ローカルからpush

エンジニアがローカル `C:\dev\salesagent-luma\` で `git init` 済み。`.gitignore` に `.env` 系は除外済み。
社長は次のコマンドだけ実行：

```bash
cd /c/dev/salesagent-luma
git remote add origin git@github.com:reagey-inc/salesagent-luma.git
git branch -M main
git push -u origin main
```

**所要**: 10〜15分（GitHubアカウント認証含む）
**コスト**: 無料

---

## 2. Vercel プロジェクト作成 + Neon DB 統合

### 2.1 Vercel Team「リージー法人」を作成

1. https://vercel.com/signup で個人アカウントを作成（or 既存ログイン）
2. ダッシュボード上部の組織切替メニュー → **Create Team**
3. Team Name: `reagey-inc`（GitHub Org と揃える）
4. プラン: **Hobby（無料）でスタート**
   - フェーズ4 で社員配布する直前に **Pro $20/月** に切替（理由: 7段推論の60秒上限を300秒に拡張するため）
5. メンバー招待: 当面は社長のみ（エンジニア席は後追加）

### 2.2 GitHub リポジトリ連携

1. Vercel Team `reagey-inc` のダッシュボード → **Add New... → Project**
2. **Import Git Repository**
3. 初回は「Install GitHub App」を求められる → `reagey-inc` org に GitHubアプリをインストール（リポジトリ範囲は `salesagent-luma` のみ許可で OK）
4. `salesagent-luma` を選んで **Import**

### 2.3 Project 設定

- Framework Preset: **Next.js**（自動検出）
- Build Command: `prisma generate && next build`（`vercel.json` で指定済みだがUIでも確認）
- Install Command: 既定（`npm install` で OK、postinstallでprisma generateが走る）
- Root Directory: `./`（既定）
- **「Deploy」はまだ押さない**。先に DB と Blob を繋ぐ。

### 2.4 Neon DB 統合（Marketplace 1クリック）

1. Vercel プロジェクト画面 → **Storage** タブ → **Create Database**
2. **Neon** を選択 → **Continue**
3. Database Name: `salesagent-luma-db`
4. Region: **AWS Singapore (ap-southeast-1)** または **Tokyo（hnd1相当）が選べれば Tokyo**
5. Plan: **Free**（0.5GB DB、月191時間compute、1ブランチで十分）
6. Connect to Project: チェック ON、Environment は **Production / Preview / Development の全て** を選択
7. **Create**

→ `DATABASE_URL` `DATABASE_URL_UNPOOLED` `POSTGRES_*` 系の環境変数が**自動で全環境にセットされる**。手動入力不要。

**注意**：自動セットされる `DATABASE_URL` は pooler 経由 URL。Prisma はこのままでOK。
`DATABASE_URL_UNPOOLED` は migration 専用（Vercel ビルドコマンドで `prisma migrate deploy` を使う場合のみ参照）。今は `db push` 派なので使わない。

### 2.5 Neon の接続文字列を確認

Storage → Neon DB → **`.env.local` Tab** で接続文字列が見られる。
ローカルから本番DBを覗くデバッグが要る時はこれをコピーして使う（普段は不要）。

**所要**: 20〜30分
**コスト**: 無料（Neon Free Tier）

---

## 3. Vercel Blob 統合

### 3.1 手順

1. Vercel プロジェクト画面 → **Storage** タブ → **Create Database**（同じ画面）
2. **Blob** を選択 → **Continue**
3. Store Name: `salesagent-luma-blob`
4. Connect to Project: ON（Production / Preview / Development 全て）
5. **Create**

→ `BLOB_READ_WRITE_TOKEN` が自動セット。

### 3.2 動作モード（コード側の自動分岐）

`src/lib/storage.ts` 抽象化済み：
- `BLOB_READ_WRITE_TOKEN` あり → Vercel Blob（CDN URL を返す）
- `BLOB_READ_WRITE_TOKEN` なし → ローカル `./uploads/` に保存（dev fallback）

ローカル開発時は `BLOB_READ_WRITE_TOKEN` を `.env` に書かなければそのまま `./uploads/` を使い続けるので、開発環境は壊れない。

**所要**: 5分
**コスト**: 無料（Hobby = 1GB Blob 込み、1万 ops/月込み）

---

## 4. 環境変数の登録

Vercel プロジェクト → **Settings** → **Environment Variables**

DB と Blob は前ステップで自動セット済み。**手動で追加するのは下表のみ**。

### 4.1 必須（Required）

| 変数名 | 値 | Environment | 取得元 |
|---|---|---|---|
| `JWT_SECRET` | 64文字ランダム（`openssl rand -hex 32` で生成） | All（Prod/Preview/Dev 全て同じでOK、別値推奨） | 自前生成 |
| `AUTH_SECRET` | 64文字ランダム（同上） | All | 自前生成。空でも JWT_SECRET にfallbackするが**設定推奨** |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `AIzaSy...` | All（同じキー） | フェーズ1 で発行済み（`.env` の値をコピーすればOK） |
| `AI_PROVIDER` | `gemini` | All | 固定値 |

### 4.2 推奨（Optional）

| 変数名 | 値 | 用途 |
|---|---|---|
| `GEMINI_MODEL_DEFAULT` | `gemini-2.5-flash-lite` | チャット・軽い推論用モデル |
| `GEMINI_MODEL_HEAVY` | `gemini-2.5-pro` | 7段推論 STEP3/7 用（品質重視）|
| `GEMINI_MODEL_TRANSCRIBE` | `gemini-2.5-flash-lite` | 音声書き起こし |
| `GEMINI_MODEL_EMBED` | `gemini-embedding-001` | 将来の類似度検索 |
| `NEXTAUTH_URL` | `https://<vercel-domain>.vercel.app` | NextAuth が cookie 書込み時に参照（Google認証無効でも設定しておくと安心）|

### 4.3 設定不要（空のまま）

| 変数名 | 理由 |
|---|---|
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google 認証使わない方針 |
| `NOTION_API_KEY` / `NOTION_LUMA_YOMI_DB_ID` | 取り込み済みなので本番不要 |
| `UPLOAD_DIR` | Blob モードでは無視される |
| `OPENAI_*` / `ANTHROPIC_*` | Gemini に全置換済み（緊急ロールバック時のみ追加）|

### 4.4 機密度別の管理ポリシー

- **超機密（漏洩=即被害）**: `JWT_SECRET` `AUTH_SECRET` `DATABASE_URL` `BLOB_READ_WRITE_TOKEN` `GOOGLE_GENERATIVE_AI_API_KEY`
  - Vercel ダッシュボードの「Sensitive」フラグを ON にして登録（一度設定後は値が見られなくなる）
- **機密**: `NEXTAUTH_URL`（漏洩しても直接被害は小さい）
- **公開可**: `AI_PROVIDER` `GEMINI_MODEL_*`（コード読めば分かる、隠す意味なし）

**所要**: 10分
**コスト**: 0

---

## 5. 初回デプロイ

### 5.1 デプロイ実行

環境変数を保存すると、Vercel ダッシュボード上部に「Redeploy」ボタンが出る。
- もしくは GitHub の `main` ブランチに何かコミット → push すれば自動デプロイ

### 5.2 ビルドログの確認ポイント

- `npm install` → `postinstall: prisma generate` が走る ✓
- `prisma generate && next build` が完了 ✓
- "Compiled successfully" の表示 ✓
- 失敗時の典型エラー：
  - "PrismaClientInitializationError"：DATABASE_URL 未設定 or 接続不可（Neon の region 確認）
  - "Module not found: @vercel/blob"：postinstall失敗。`npm install` ログを再確認
  - "Function exceeded duration limit"：Hobby plan の60秒に当たった。Pro へ切替 or `vercel.json` の maxDuration を下げる

### 5.3 初回デプロイ後

- URL は `https://salesagent-luma-<random>.vercel.app` 形式で発行される
- 開いても**まだログインできない**（DB が空＝ユーザーが居ない）
- これは正常。**フェーズ3でデータ移行する**。

---

## 6. デプロイ後の動作確認（データ移行前）

### 6.1 まず確認すること

- `/login` 画面が表示される（CSS 崩れなし、ロゴ表示OK）
- `/register` 画面が表示される
- /api/health（あれば）→ 200 OK

### 6.2 仮ユーザーで疎通テスト

社員配布前に最小限の疎通確認：

1. `/register` でメール `test@reagey-inc.com` / パスワード `Test1234567890!` で登録
2. 登録後ログイン → ダッシュボード表示
3. ダッシュボードが「データなし」状態で正常表示
4. 確認後、Neon Console で `DELETE FROM "User" WHERE email='test@reagey-inc.com';` で削除（フェーズ3前にDBを綺麗に保つ）

### 6.3 一貫性チェック

- ブラウザのコンソールに 500 エラーが出ない
- Vercel ダッシュボード → **Functions** タブで赤いエラーが無い
- Vercel ダッシュボード → **Logs** で WARN/ERROR が出ても許容ライン（Notion 連携なし系のwarnは無視OK）

---

## 7. データ移行（フェーズ3、本書範囲外）

フェーズ3で実施する内容（参考）：

1. ローカル `salesagent_luma` を `pg_dump --data-only --format=custom` でダンプ
2. Neon Production DB に `prisma db push` でスキーマ適用
3. `pg_restore --data-only` で Neon にデータ流し込み
4. 件数確認：users 8 / companies 1654 / deals 1654 / contacts 4840 / deal_products 2555
5. 仮パスワード一括発行スクリプト実行（`scripts/issue-initial-passwords.ts`、要追加実装）
6. 社員8名に Slack DM で初回ログイン情報を配布

詳細は `docs/production-rollout-plan.md` のフェーズ3セクションを参照。

---

## 8. カスタムドメイン設定（任意・後回し可）

- **当面**：`xxx.vercel.app` のままで運用。社員8名なら URL ブックマークで十分
- **将来**：`salesagent.luma-create.com` 等を当てる場合、Vercel → Settings → Domains から追加 → DNS の CNAME に Vercel の値を設定 → SSL 自動発行

**判断不要**。導入後 1〜3ヶ月のうちで決めれば OK。

---

## 9. 緊急ロールバック手順

### 9.1 デプロイをロールバックする

Vercel ダッシュボード → Deployments → 過去の安定版を選択 → **Promote to Production**

### 9.2 DB を時点復元する

Neon Console → Branches → 特定時点（最大7日前）から **Restore Branch**

### 9.3 全部投げ捨てる

GitHub の `main` を revert → 自動再デプロイ。最悪 Vercel プロジェクト自体を削除して再作成しても、Neon DB は残るので再リンクすれば復旧。

---

## 10. 社長が次に手を動かすべき具体的なコマンド／操作 トップ3

| 順序 | 操作 | 想定所要 | 備考 |
|---|---|---|---|
| **①** | **GitHub Organization `reagey-inc`（または既存org）を確認・作成し、Private リポジトリ `salesagent-luma` を新規作成**（コードはまだ push しない） | 5分 | https://github.com/organizations/new |
| **②** | **作成した GitHub リポジトリの clone URL を社長からエンジニア（このAI）に渡す** | 1分 | URL を Slack でも本対話でもOK。エンジニア側で `git remote add origin <url>` → `git push -u origin main` を実行する |
| **③** | **Vercel アカウントにログインし、`reagey-inc` Team を作成**（or 既存Teamの確認）。GitHub App のインストール先 org として `reagey-inc` を選ぶ準備をする | 10分 | https://vercel.com/teams/create |

①②③ が終われば、エンジニアがコード push → Vercel Project Import → Neon/Blob 統合 → 環境変数登録 → 初回デプロイ までを社長立会のもとで一気通貫で進められる。

---

## 付録 A: フェーズ2-A で実装した内容（エンジニア作業ログ）

| 作業 | ファイル | 状態 |
|---|---|---|
| `git init` + `.gitignore` 整備 | `.gitignore` | 完了 |
| `.env.example` 整備（Gemini/Blob/NextAuth 全項目） | `.env.example` | 完了 |
| Vercel Blob 抽象レイヤー新設 | `src/lib/storage.ts` | 新規 |
| 録音アップロード Blob 化 | `src/app/api/meetings/route.ts` | 改修 |
| 書類アップロード Blob 化 | `src/app/api/documents/route.ts` | 改修 |
| 書類削除 Blob 対応 | `src/app/api/documents/[id]/route.ts` | 改修 |
| アバター Blob 化 | `src/app/api/auth/avatar/route.ts` | 改修 |
| `vercel.json` 作成（hnd1リージョン、関数 maxDuration、ビルドコマンド） | `vercel.json` | 新規 |
| `next.config.ts` 調整（Blob host許可、prisma external） | `next.config.ts` | 改修 |
| `package.json` に postinstall 追加 | `package.json` | 改修 |
| `@vercel/blob` 導入 | `package.json` / `package-lock.json` | 完了 |

**動作確認**：
- `npx tsc --noEmit` PASS
- `npm run build` PASS
- ローカル dev（http://localhost:3003）で BLOB_READ_WRITE_TOKEN 未設定時に `./uploads/` フォールバック動作することを確認

---

以上。①②③ の社長作業を待って、エンジニアが残りを一気通貫で進めます。
