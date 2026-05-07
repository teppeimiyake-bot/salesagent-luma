# Re;easy Sales Agent — 営業AIエージェントSaaS（MVP）

> **「営業が考えなくても、勝ち筋と次の一手が出る」**
>
> 商談録画 → 文字起こし → 7段推論 → 受注確度を最大化する Next Action 生成 → ToDo化

リージーの新規事業「営業エージェント事業」のMVP。Re;easy HR と同じ「案件ごと専属AIエージェント」モデルを営業ドメインに横展開。

## 主要機能

- **商談録画／議事録の取り込み**（mp3/m4a/wav/mp4 対応、Whisper文字起こし）
- **AI多段推論パイプライン（7段＋自己改善）**
  1. 構造化（事実整理）
  2. 営業分析（課題・BANT抽出）
  3. トップ営業思考（本音・意思決定構造・失注リスク・勝ち筋）
  4. 戦略設計（戦略・差別化・クロージングプラン）
  5. Next Action生成（即実行可能なアクション3〜6個）
  6. スコアリング（actionability / specificity / impact 各1-5）
  7. 自己改善（スコア4未満は具体性を上げて再生成）
- **CRM**：企業／商談／ToDo CRUD、商談ステータス・確度・金額・担当
- **3カラム商談詳細**：左に議事録／BANT編集、右にAIパネル（要約・課題・勝ち筋・Next Action）
- **「ToDoに追加」ボタン**：AI提案を1クリックでToDo化
- **学習機構**：ユーザーがAI生成ToDoやBANTを編集すると ai_logs に差分が保存され、次回プロンプトに反映
- **KPIダッシュボード**：受注率・ToDo消化率・Next Action率・AI活用率・パイプライン額・受注額／週次推移
- **認証**：email/password、JWTセッション、Edge middlewareで保護

## 技術スタック

- Next.js 16 (App Router) / TypeScript / React 19
- Tailwind CSS v4
- shadcn/ui パターンの自前コンポーネント（@radix-ui ベース）
- Prisma ORM + PostgreSQL
- Anthropic Claude（コア推論：claude-sonnet-4-6）
- OpenAI Whisper（音声→テキスト：whisper-1）
- OpenAI Embeddings（ナレッジ検索用：text-embedding-3-small）
- recharts（KPIグラフ）
- jose（JWT）/ bcryptjs（パスワード）/ zod（バリデーション）

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. 環境変数

`.env.example` を `.env` にコピーして埋める。

```bash
cp .env.example .env
```

最低限必要なもの：
- `DATABASE_URL`：PostgreSQL接続URL（Neon / Supabase / ローカルDocker など）
- `JWT_SECRET`：32文字以上のランダム文字列

AI機能を実際に動かすには：
- `ANTHROPIC_API_KEY`：Claude
- `OPENAI_API_KEY`：Whisper / embeddings

> **キーが無くても動く**：パイプラインは決定論的フォールバックを内蔵しているため、APIキー無しでもUI動作確認＋意味のある出力が出ます。

#### Googleログイン（招待制・任意）

Google OAuthによるログインを有効化したい場合：

- `AUTH_SECRET`：NextAuth のJWT署名鍵（未設定時は `JWT_SECRET` にフォールバック）
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`：Google Cloud Console で発行
- `NEXTAUTH_URL`：`http://localhost:3002`（dev）／本番は `https://...`

**Google Cloud Console での発行手順**

1. [https://console.cloud.google.com/](https://console.cloud.google.com/) にログイン
2. プロジェクトを選択（または新規作成）
3. 「APIとサービス」→「OAuth同意画面」
   - User Type: **External**（一般のGoogleアカウント許可）
   - アプリ名: `Re;easy Sales Agent` 等
   - サポートメール: 自分のメール
   - 公開ステータス: テスト中（自分のメールを「テストユーザー」に追加）でOK
4. 「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」
   - アプリケーションの種類: **ウェブアプリケーション**
   - 承認済みのリダイレクトURI:
     - dev: `http://localhost:3002/api/auth/callback/google`
     - prod: `https://<your-domain>/api/auth/callback/google`
5. 発行された **クライアントID** と **クライアントシークレット** を `.env` の `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` に設定
6. dev server を再起動 → ログイン画面に「Googleでログイン」ボタンが表示される

**招待制ロジック**

- 既存 `User.email` と一致するアカウントは紐付けてログイン
- `Invite` テーブルの未使用・未期限切れの招待 email と一致 → 自動的にUser作成（Inviteの permission/role を継承）
- どちらでもない → ログイン拒否（`/login?error=AccessDenied`）

→ admin が `/admin/users` から事前に Invite を発行することでログイン許可リストを管理。

### 3. DB マイグレーション + シード

```bash
npm run db:push      # schema を DB に反映（初回／開発時）
npm run db:seed      # デモユーザー＋商談6件＋ToDo＋議事録1件を投入
```

### 4. 起動

```bash
npm run dev
```

`http://localhost:3000` を開き、`demo@salesagent.local` / `demo1234` でログイン。

## 主要画面

| URL | 内容 |
| --- | --- |
| `/dashboard` | AI ToDo（最上部）／KPI 6カード／進行中の商談 |
| `/deals` | 商談一覧（ステータス・金額・確度・担当） |
| `/deals/[id]` | 商談詳細（左：議事録／BANT、右：AIパネル） |
| `/companies` | 企業一覧 |
| `/kpi` | KPIダッシュボード（週次推移＋アラート） |
| `/login` `/register` | 認証 |

## AIパイプライン使い方

1. 商談詳細で「録画ファイル or 議事録テキスト」を取り込む
2. 「保存してAI分析」を押すと、Whisper → 7段パイプラインが走る（30〜90秒）
3. 右パネルにサマリ／課題／勝ち筋／Next Action が出る
4. 各 Next Action の「ToDoに追加」で ToDo化
5. AI生成ToDoをユーザーが編集すると、差分が `ai_logs` に保存され、**次回の再分析時にプロンプトに織り込まれる**

## ディレクトリ構成

```
src/
├─ app/
│  ├─ (app)/                  # 認証必須レイアウト（サイドバー付）
│  │  ├─ dashboard/page.tsx
│  │  ├─ deals/page.tsx
│  │  ├─ deals/[id]/page.tsx  # 商談詳細（最重要画面）
│  │  ├─ companies/page.tsx
│  │  └─ kpi/page.tsx
│  ├─ login/page.tsx
│  ├─ register/page.tsx
│  ├─ api/
│  │  ├─ auth/{login,register,logout}/route.ts
│  │  ├─ companies/route.ts
│  │  ├─ deals/{route.ts,[id]/route.ts}
│  │  ├─ tasks/{route.ts,[id]/route.ts}
│  │  └─ meetings/{route.ts,[id]/route.ts,[id]/analyze/route.ts}  # ← AIパイプライン入口
│  ├─ layout.tsx
│  └─ page.tsx
├─ components/
│  ├─ ui/                     # shadcn風の自前UI（button/card/input/...）
│  ├─ layout/{sidebar,header}.tsx
│  ├─ dashboard/{ai-todo,kpi-cards,deals-table}.tsx
│  ├─ deals/{ai-panel,bant-editor,transcript-view,upload-recording,tasks-list,deal-status,new-deal-dialog}.tsx
│  └─ kpi/charts.tsx
├─ lib/
│  ├─ ai/
│  │  ├─ pipeline.ts          # 7段パイプライン（最重要）
│  │  ├─ anthropic.ts         # Claude呼び出し
│  │  ├─ openai.ts            # Whisper / embeddings
│  │  └─ fewshot.ts           # 営業現場のFew-shot
│  ├─ auth.ts                 # JWT / bcrypt
│  ├─ db.ts                   # Prisma client
│  ├─ queries.ts              # ダッシュボード集計 / KPI 時系列
│  └─ utils.ts
└─ middleware.ts              # 全画面・全API の認証ガード
prisma/
├─ schema.prisma              # users/companies/deals/meetings/tasks/ai_logs
└─ seed.ts                    # デモデータ
```

## 設計メモ

### 「行動を生むアウトプット」を出すために

- **Few-shot**（`src/lib/ai/fewshot.ts`）に、現場でNG解釈とNG Actionを5パターン明示。「待つ」「様子を見る」「フォロー」だけのアクションは禁止
- **STEP5の制約**：必ず「動詞＋目的語＋期限」、必ず「決裁者を巻き込む系」「失注リスクを潰す系」を1つずつ含める
- **STEP6→7**：自前でスコアリング→4未満は再生成。妥協しない

### 学習機構

- AI生成 ToDo にユーザーが編集を入れると `ai_logs.user_edit` に保存
- BANT編集も同様に記録
- 同じ案件で再分析する際、過去5件の編集差分を `pastEdits` としてプロンプトに埋め込む

### フォールバック設計

- ANTHROPIC_API_KEY / OPENAI_API_KEY が無くても、各stepはローカルなヒューリスティックで意味のある出力を返す
- 文字起こしも、Whisper無しなら「キー未設定」プレースホルダで保存（議事録テキスト直貼りに切り替え可）
- これにより、APIキー無しでも UI/操作フロー検証ができる

## 開発スクリプト

```bash
npm run dev          # 起動
npm run build        # 本番ビルド
npm run db:generate  # Prisma client生成
npm run db:push      # schema適用（migrationを残さない）
npm run db:migrate   # マイグレーション作成
npm run db:seed      # シード
npm run db:studio    # Prisma Studio
npm run lint
```

## 既知の制約（MVP）

- アップロードはローカルファイルシステム（`./uploads`）保存。本番はS3等に置き換え
- 文字起こしは同期処理（録画15分以下推奨）。長時間音声はジョブキュー化が必要
- 認証は単一テナント。ワークスペース／チーム機能は今後
- CRM連携（Salesforce/HubSpot）は未実装
- リアルタイム文字起こしは未実装（GA向け）
