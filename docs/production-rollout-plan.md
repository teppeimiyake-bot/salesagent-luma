# Re;easy Sales Agent for Luma 本番ロールアウト計画書

- **作成日**: 2026-05-07
- **作成**: luma-sales-engineer
- **対象**: 株式会社Luma 社長（三宅）
- **位置づけ**: 実装着手前の調査・計画。社長承認を取ってからフェーズ1着手。

---

## 0. エグゼクティブサマリ（社長向け）

Luma版（`C:\dev\salesagent-luma`）はリージー版からフォーク済みで、ローカル `localhost:3003` で全機能が動作している。Notionから取り込んだ users 8件 / companies 1654件 / deals 1654件 / contacts 4840件 / deal_products 2555件のデータが既にDBに入っており、移行対象として準備完了。

本番化には大きく **3つの作業** が必要：

1. **AIをGeminiに全面置換**（Claude / OpenAI Whisper / OpenAI Embeddings → Gemini）
   現状AIキー未設定でフォールバック動作しているが、本番では必須。Geminiの無料枠は社員8名 × 月100商談 × 7段推論の試算で**ほぼ収まる見込み**だが、Whisperの代替（Gemini音声入力）は現行コードの大改修が必要。
2. **Vercel + マネージドPostgreSQL へのデプロイ**
   DBは **Neon を第一推奨**（Vercel Marketplace から1クリックで連携・無料枠で十分・Prismaとの相性◎）。次点 Vercel Postgres（中身はNeon）、Supabaseは認証機能が被るので非推奨。**ファイルアップロード（録音/書類）はローカル `uploads/` から Vercel Blob への移行が必須**（Vercelはサーバーレスでファイルシステムが書込み不可）。
3. **データ移行と社員配布**
   ローカルDB（15MB）を pg_dump → Neon に restore、所要1〜2時間。社員8名のパスワードは admin が初期発行 → 各員が初回ログインで強制変更する **「admin初期設定 → 共有 → 自己変更」フロー**を提案（現状はパスワードリセットAPI未実装、要追加実装）。

**全体所要：実働2〜3週間（フェーズ1=Gemini化2〜3日 / フェーズ2=Vercel構築2日 / フェーズ3=データ移行1日 / フェーズ4=配布・運用開始0.5日 + バッファ）**。

**社長判断が必要なポイント**：
- A. Gemini SDK採用方針（Vercel AI SDK経由 vs `@google/generative-ai` 直叩き → **AI SDK経由推奨**）
- B. DB選定（**Neon推奨**）
- C. ファイル保存先（**Vercel Blob 必須**）
- D. パスワード配布方式（**admin初期発行+強制変更 推奨**、招待リンク発行APIは既存）
- E. Vercelプラン（**Hobby枠で開始 → Pro $20/月への切替時期判断**）

---

## 1. 現状コードベース調査

### 1.1 影響範囲：Anthropic / OpenAI SDK 利用ファイル

#### Anthropic SDK 利用（Claude直叩き）

`src/lib/ai/anthropic.ts` がラッパー。以下の関数を提供：
- `callClaude(opts)`: テキスト返却
- `callClaudeJSON<T>(opts)`: JSON返却（パース失敗時null）
- `tryParseJSON<T>(text)`: 共通JSONパーサ（```json``` / `{...}` を剥がす）

**呼び出し元（要全置換）**：
- `src/lib/ai/pipeline.ts` — 7段推論パイプラインのSTEP1〜7すべて（`callClaudeJSON` を6回 + STEP7改善で1回）
- `src/app/api/chat/route.ts` — チャットAI応答（`callClaude`）
- `src/app/api/roleplay/route.ts` — ロープレ顧客役（`callClaude`）
- `src/app/api/companies/[id]/fetch-summary/route.ts` — 企業Webサイト要約（`callClaude`）
- `src/app/api/deals/[id]/summarize-bant/route.ts` — BANT集約（`callClaudeJSON`）
- `src/app/api/deals/[id]/suggest-next-action/route.ts` — Next Action提案（`callClaudeJSON`）
- `src/app/api/deals/[id]/preparation/route.ts` — 商談前準備（`callClaudeJSON`）
- `src/app/api/knowledge/search/route.ts` — ナレッジ意味検索（`callClaude`）

#### OpenAI SDK 利用

`src/lib/ai/openai.ts` がラッパー。以下の関数を提供：
- `transcribeFile(filepath)`: 音声→テキスト（Whisper）
- `embed(text)`: テキスト→ベクトル（text-embedding-3-small）

**呼び出し元（要全置換）**：
- `src/app/api/meetings/route.ts` — multipart録音POST後に `transcribeFile` を呼ぶ
- `embed()` はインポートされているが実際の呼び出し箇所は現時点ゼロ（コードベースでは未使用、将来の類似度検索用に置いてある）

#### プロンプト構造の互換性

現行プロンプトは **system + user の2ロール構成**で、すべて「JSONで出力せよ」と指示。Geminiは：
- **Gemini API は単一テキスト or マルチターンchat。systemInstruction が独立フィールドとして用意されている**ため、現行 system→`systemInstruction`、user→`contents[0].parts[0].text` にマッピングすればそのまま動く。
- **JSON モードは `responseMimeType: "application/json"` + `responseSchema` でClaudeより**厳密**に制御可能**。`tryParseJSON` のフェンス除去ロジックは保険として残しつつ、Geminiでは `responseSchema` 指定で「JSON以外を返さない」保証が取れる。
- **Few-shot（`SALES_FEWSHOT_INTERPRETATION`）はsystem内に埋め込み**になっており、Geminiでもそのまま動作。

→ **プロンプト本体の改修コストは小さい**。ラッパー関数 `callClaude` / `callClaudeJSON` のシグネチャを保ったまま、内部実装をGeminiに差し替えれば呼び出し元の変更は最小限で済む。

#### Whisper の置換（要設計）

- 現行：`audio.transcriptions.create({ file: ReadStream, model: "whisper-1", language: "ja" })`
- Gemini：**Files API で音声アップロード → `generateContent` に inlineData / fileData として渡す**
  - 対応形式：WAV / MP3 / AIFF / AAC / OGG / **WebM（OK）/ FLAC**
  - 現行 `meetings/route.ts` は `.webm` で保存している（Web Audio API の MediaRecorder のデフォルト）→ **そのまま使える**
  - 上限：Files API は単一ファイル2GB / 合計20GB / 48時間で自動削除
  - 長時間音声の扱い：**Geminiは音声1秒=32トークン換算**。30分商談 = 30×60×32 ≒ 57,600トークン。Gemini 2.0 Flash の入力上限100万トークンに対して余裕。
- 改修ポイント：`transcribeFile()` の中身を Gemini 用に書き換える。**戻り値の型（`Promise<string | null>`）は維持**するので呼び出し元無改修。

#### Embeddings の置換

- 現行：`text-embedding-3-small`（1536次元）→ 未使用なので影響なし
- Gemini：`text-embedding-004`（768次元）または `gemini-embedding-001`（3072次元、可変1536/768/256）
- 採用判断：**初期は `embed()` を Gemini text-embedding-004 で実装し直すだけで放置**。実利用が始まったら次元数を pgvector スキーマに合わせる。

### 1.2 ファイルアップロード箇所

| API | ファイル種別 | 保存先 | 用途 |
|---|---|---|---|
| `POST /api/meetings`（multipart） | 商談録音 `.webm` 等 | `./uploads/recordings/` | Gemini音声入力に渡す |
| `POST /api/documents`（multipart） | 契約書・提案書PDF等 | `./uploads/documents/` | ナレッジ・添付資料 |
| `POST /api/auth/avatar` | プロフィール画像（PNG/JPEG/WebP/GIF、5MB以下） | `./uploads/avatars/` | UI表示 |
| `DELETE /api/documents/[id]` | — | 削除 | `fs.unlink` |

**Vercelはサーバーレスでファイルシステムが**書き込み不可（一部 `/tmp` のみ可、ただし揮発）**。3カ所すべてを Vercel Blob に移行する必要あり**（詳細は 3.4 節）。

### 1.3 認証実装（既に多重化済み・整理が必要）

現状、認証経路が **2系統並存**：

1. **自前JWT + bcryptjs**（`src/lib/auth.ts`）
   - `POST /api/auth/login`（メール+パスワード）→ JWT署名 → Cookie `salesagent_session` にセット
   - `POST /api/auth/register`（招待トークン or 直接登録）→ User作成
   - `PATCH /api/auth/password`（自分のパスワード変更）
   - `middleware.ts` で全リクエストの認証チェック
2. **NextAuth v5（Auth.js）+ Google OAuth**（`src/auth.ts`）
   - `next-auth` パッケージ + `@auth/prisma-adapter`
   - 招待制ロジック（既存User or 未使用Invite に該当しなければ拒否）
   - signInイベントで自前JWT Cookieも発行する**ブリッジ実装**

**社長方針：Google認証は使わない** → NextAuth関連は本番ビルドでは無効化（`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` を空のままにすればプロバイダ無効化される設計済み）。**コードを削る必要はないが、依存パッケージの整理（next-auth削除）は判断ポイント**。当面は空のまま放置して問題なし。

### 1.4 タイムアウト設定（Vercel影響）

`export const maxDuration = N` 指定済みのAPI：

| API | maxDuration | 用途 |
|---|---|---|
| `meetings/[id]/analyze` | 120秒 | 7段AI推論（最大ボトルネック） |
| `companies/[id]/fetch-summary` | 60秒 | Webサイト取得+AI要約 |
| `deals/[id]/preparation` | 60秒 | 商談前準備生成 |
| `deals/[id]/summarize-bant` | 30秒 | BANT集約 |
| `deals/[id]/suggest-next-action` | 30秒 | Next Action 1個 |
| `companies/[id]/fetch-logo` | 30秒 | ロゴ取得 |

**Vercel Hobby プランの上限：60秒**（Function実行時間）→ **`meetings/[id]/analyze` の 120秒指定は Hobby では無視され60秒で打ち切られる**。Pro プラン（$20/月）なら **300秒（5分）まで**拡張可能。Fluid Compute（Pro/Enterprise）なら最大15分。

→ **判断ポイント E：Vercelプラン**（後述 6章）。

---

## 2. Gemini化方針（決定事項のうちGeminiの実装方法）

### 2.1 SDK選定（社長判断ポイント A）

#### A案：Vercel AI SDK 経由（**推奨**）

```ts
import { google } from "@ai-sdk/google";
import { generateText, generateObject } from "ai";

const result = await generateText({
  model: google("gemini-2.0-flash"),
  system, prompt: user, maxTokens, temperature,
});
```

**メリット**：
- プロバイダ抽象化されている（将来Claudeに戻すのも、OpenAIに移すのも `model` の差し替えだけ）
- `generateObject` で zod スキーマ準拠JSONを**100%保証**（現行 `tryParseJSON` の保険ロジック不要）
- ストリーミング、ツール呼び出し、構造化出力など共通インターフェース
- Vercelデプロイとの相性が公式に保証されている
- 環境変数 `GOOGLE_GENERATIVE_AI_API_KEY` で自動認識

**デメリット**：
- 依存パッケージが `ai` と `@ai-sdk/google` の2つ追加（軽量）
- 学習コスト（薄い）

#### B案：`@google/generative-ai` 直叩き

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
const result = await model.generateContent({ ... });
```

**メリット**：
- Google公式SDKで機能フル活用（Files API、マルチモーダル、長尺コンテキストキャッシング）
- 余計な抽象レイヤなし

**デメリット**：
- プロバイダロックイン
- JSONスキーマ準拠は `responseSchema` を自前で組む必要

#### 推奨

**Vercel AI SDK経由（A案）でテキスト生成系を全置換 + Whisper代替（音声書き起こし）だけは Files API 機能が必要なため `@google/generative-ai` 直叩きで補完**、というハイブリッド構成を推奨。

理由：
- 7段推論やチャットなど大半のユースケースは AI SDK の `generateObject` で zod スキーマ準拠出力が手に入り、現行コードがクリーンになる
- Files API（音声ファイルのアップロード→保持）は AI SDK のラッパーが薄いので、Whisper代替だけ直叩きの方が早い
- 将来「OpenAI Whisper APIにやっぱり戻す」「Deepgramに移す」となった時、`transcribeFile()` 関数の中身を差し替えるだけで済む（既にラッパー化済み）

### 2.2 Geminiモデル選定

| モデル | 用途 | 無料枠 | 有料 |
|---|---|---|---|
| **gemini-2.5-flash** | チャット・7段推論・Next Action提案 | RPM 10 / TPM 250K / RPD 250 | $0.30/1M in, $2.50/1M out |
| gemini-2.5-flash-lite | 軽量タスク（ロゴ、軽い要約） | RPM 15 / TPM 250K / RPD 1000 | $0.10/1M in, $0.40/1M out |
| **gemini-2.5-pro** | 最重要：7段推論のSTEP3トップ営業思考 / STEP7自己改善 | RPM 5 / TPM 250K / RPD 100 | $1.25/1M in, $10/1M out |
| **gemini-2.5-flash**（音声入力対応） | Whisper代替（Files API + 音声→テキスト） | 同上 | 同上 |
| text-embedding-004 | 将来の類似度検索 | RPM 100（未使用なので問題なし） | 無料 |

**初期方針**：
- 全段 `gemini-2.5-flash` から開始（コストと品質のスイートスポット）
- STEP3トップ営業思考とSTEP7自己改善のみ `gemini-2.5-pro` に切り替えるか、Few-shotを増やしてFlashで頑張るかは**初期データで品質確認後に判断**
- 環境変数 `GEMINI_MODEL_DEFAULT` / `GEMINI_MODEL_HEAVY` / `GEMINI_MODEL_TRANSCRIBE` を分けて、コード変更なしでチューニング可能にする

### 2.3 Gemini無料枠の運用試算

#### 想定利用量（社員8名・月100商談・繁忙期込み）

| 機能 | 1商談あたり呼出数 | 月間（100商談） | 備考 |
|---|---|---|---|
| 7段推論（meetings/analyze） | 7（自己改善発動時8） | 700〜800 | 最大ボリューム |
| BANT集約（summarize-bant） | 1〜3（再生成含む） | 100〜300 | |
| Next Action提案 | 3〜5（毎日でも回せる） | 300〜500 | |
| 商談前準備 | 1（商談前に1回） | 100 | |
| Webサイト要約 | 1（初回登録時のみ） | 100/月 | 既存1654社あるが新規のみ |
| ロープレ | 任意（社員1人月5回×8人=40） | 40セッション×平均20往復 = 800 | |
| チャット | 社員1人月50発話×8人 | 400 | |
| 音声書き起こし（Whisper代替） | 1商談1回 | 100 | 30分平均 |

**月合計（中央値）**：約 **2,500〜3,000 リクエスト/月** = **約 100リクエスト/日**

#### 無料枠との比較（gemini-2.5-flash）

- **RPM 10**: 1分10リクエスト = 1日 14,400リクエスト上限。100/日に対し**余裕**
- **RPD 250**: 1日250リクエスト上限 → **100/日なら収まるが、繁忙期や複数同時利用で詰まるリスクあり**
- **TPM 250,000**: 1分25万トークン。7段推論1回でinput 5K + output 3K = 8Kトークン × 7段 = 56K。1分間に同時2件回せば112K、3件で168K → **安全**

#### 詰まるリスクと有料切替パス

**主リスク：RPD 250**
- 試算では月3,000リクエスト = 100/日、月100商談仮定。1日に複数商談が立て込み +ロープレが集中する日に **250/日を超える可能性あり**
- 特に Vercel Functions のリトライ機構と組み合わせるとカウント消費が早まる

**対策**：
1. **段階的にPaid Tier 1（$5チャージで開放）に切替**：
   - Tier 1 = RPM 1000 / TPM 1M / RPD 10000（gemini-2.5-flash）
   - 100リクエスト/日でも実コスト 100×8K×$0.3/1M ≒ $0.24/日 = **月7ドル程度**
   - **無料枠卒業後の月額コスト試算：$10〜30/月**（普段使いで余裕、繁忙期でも$50切る）
2. **キャッシング活用**：Geminiのコンテキストキャッシュ（Pro Tier）で同じ案件を複数回参照する場合は約75%節約可能。ただし最低トークン数（Flash 1024 / Pro 2048）の制約あり
3. **7段推論のうち軽い段（STEP1構造化、STEP6スコアリング）を `gemini-2.5-flash-lite` に振り分け**

**ロールバック条件**：本番運用1〜2週で日次ログを見て、RPDが200を超える日が週3日以上 → 即Tier 1切替を社長承認なしで実施可。

---

## 3. Vercelデプロイ要件

### 3.1 Next.js 16 / App Router 構成での注意点

- **Next.js 16 + Tailwind 4 + Turbopack**：Vercel公式サポート済み、特殊設定不要
- **`prisma generate`**：`postinstall` スクリプトで自動実行されるよう `package.json` に追記が必要（現状なし）
  ```json
  "scripts": { "postinstall": "prisma generate" }
  ```
- **エッジランタイム vs Nodeランタイム**：
  - Prisma + pg は Node のみ。`middleware.ts` は jose（jwt-verify）でEdge互換 → そのままでOK
  - 各APIルートは `runtime` 指定なしでデフォルト Node が使われる → そのままでOK
- **PostCSS / lightningcss**：Tailwind 4の native binding 問題はVercelビルド環境では発生しない（Linux x64で安定）
- **環境変数**：Vercelの環境変数はビルド時とランタイム時で挙動が違う → `NEXT_PUBLIC_*` 以外はサーバー側でしか読めないことを確認済み（既存コードはOK）
- **ISR / SSG**：本プロジェクトはほぼ全ページが認証必須の動的ページ。SSG対象は実質ゼロでOK

### 3.2 Prismaマイグレーション on Vercel CI/CD

#### 現状

- `prisma/schema.prisma` あり、`migrations/` ディレクトリは**ない**（`db push` 運用）
- `package.json` の prisma 設定は `seed` のみ

#### 推奨フロー（本番化のために整備）

1. **本番初回のみ**：ローカルで `prisma migrate dev --name init` を実行し、`prisma/migrations/` を生成 → コミット
2. **Vercelビルドコマンド**：
   ```
   prisma generate && prisma migrate deploy && next build
   ```
   `migrate deploy` は本番用（既存マイグレーションを順に適用、対話なし）
3. **`vercel.json` または Vercel UI でビルドコマンドを上記に設定**

**注意**：現行の `db push` 派は移行後も使い続けるなら「ローカルで `db push` → スキーマ確定後に `migrate dev` で migration ファイルを起こす」という運用にする。社長承認得てから整備。

### 3.3 環境変数管理（Vercel側で設定する項目）

| 変数名 | 必須 | Production / Preview / Development | 備考 |
|---|---|---|---|
| `DATABASE_URL` | ★ | Prod=Neon本番接続文字列 / Preview=Neonのpreview branch | NeonインテグレーションでVercelが自動セット可 |
| `JWT_SECRET` | ★ | 全環境で別値 | 32文字以上 |
| `GEMINI_API_KEY` | ★ | 全環境共通でOK（Gemini側で月次クオータ管理） | Google AI Studioで発行 |
| `GEMINI_MODEL_DEFAULT` | 任意 | `gemini-2.5-flash` | |
| `GEMINI_MODEL_HEAVY` | 任意 | `gemini-2.5-pro` | STEP3 / STEP7 用 |
| `GEMINI_MODEL_TRANSCRIBE` | 任意 | `gemini-2.5-flash` | Whisper代替 |
| `BLOB_READ_WRITE_TOKEN` | ★ | 自動セット（Vercel Blob 統合時） | |
| `NOTION_API_KEY` | 任意 | 取り込み済みなのでProductionでは不要、ローカルにのみ残す | |
| `NOTION_LUMA_YOMI_DB_ID` | 任意 | 同上 | |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | 不要 | 空のまま | Google認証使わない方針 |
| `AUTH_SECRET` | 不要 | 空でOK（NextAuthが無効） | |
| `NEXTAUTH_URL` | 不要 | 空でOK | |
| `UPLOAD_DIR` | 不要 | Vercel Blobに移行後は廃止 | |
| `NODE_ENV` | 自動 | Vercelが自動セット | |

#### 削除すべき変数（現状の `.env` から）

- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `NEXTAUTH_URL` / `AUTH_SECRET`：本番不要（コードはそのまま）
- `OPENAI_API_KEY` / `OPENAI_TRANSCRIBE_MODEL` / `OPENAI_EMBED_MODEL`：Gemini化後に削除
- `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`：Gemini化後に削除

### 3.4 Vercel Functions タイムアウト

| プラン | 最大Duration | 月額 | 推奨 |
|---|---|---|---|
| Hobby | 60秒 | 無料 | **不可**（meetings/analyze 120秒に対応できない） |
| **Pro** | **300秒（5分、Functions）/ 800秒（Fluid Compute）** | **$20/社員月** | **本番開始時の標準** |
| Enterprise | 900秒（15分、Fluid Compute） | 要相談 | 不要 |

**社長判断ポイント E**：
- **A案：Hobby で開始 → meetings/analyze を非同期分割実装**：7段推論を Vercel Workflow （WDK）で分割、各STEP独立Function化。実装工数+3〜5日
- **B案：Pro $20で開始**：1ヶ月$20でメンバー1名分。**8名×$20=$160/月**（メンバーは「seat」として課金）。社員8名の場合 $160/月。**実装工数ゼロ、即動く**
- **C案：Pro $20 + 社員はseat数を絞る**：Vercelダッシュボードに入る人だけseat数を払う方式。実利用者（営業担当8名）はWebアプリにログインするだけなのでseat不要。**$20/月で完結**

**推奨：C案（Pro $20/月、seat=社長＋エンジニア1〜2名のみ）**。Vercelの「seat」は**ダッシュボードを使う管理者**にのみカウントされ、エンドユーザーが認証経由でアプリを使うだけならノーカウント。月$20で5分タイムアウトとFluid Compute機能が手に入る。

### 3.5 ファイルアップロード移行（Vercel Blob 必須）

**最重要：現行の `./uploads/` ローカル保存はVercelで動かない**。`POST /api/meetings`、`POST /api/documents`、`POST /api/auth/avatar` の3箇所を Vercel Blob API に書き換える。

#### Vercel Blob 概要

```ts
import { put } from "@vercel/blob";
const blob = await put("recordings/abc.webm", file, { access: "public" });
// blob.url = "https://xxxxxxxxxxxx.public.blob.vercel-storage.com/recordings/abc.webm"
```

- 環境変数 `BLOB_READ_WRITE_TOKEN` は Vercel Blob統合で自動セット
- 価格：**Hobby枠 1GB 無料 / 操作10K回/月無料**、Pro枠は **5GB 込み**、超過 $0.023/GB/月（容量）+ $0.40/100K writes
- **Luma想定使用量**：商談録音 30分=10MB × 月100件 = **1GB/月**、12ヶ月で12GB = $0.27/月
- ファイルアクセス：`fileUrl` カラムには **`https://...blob.vercel-storage.com/...` のURL**を保存。フロントエンドからは `<a href={blob.url}>` で直接DL可能（CDN経由・高速）

#### 移行に伴う改修

DBの既存カラム `recordingUrl`, `fileUrl`, `avatarUrl` は **VARCHAR で URLを保存しているだけ** → スキーマ変更不要。コード3箇所の writeFile 部分を `put()` に差し替え + `unlink` を `del()` に差し替えるだけ。実装工数 **半日〜1日**。

#### 既存データの扱い

- 現状 `uploads/recordings/` に1ファイル `1777849232934_8a9e005d.webm`（テスト録音、62KB）のみ → 本番移行時は削除して問題なし
- `uploads/documents/`, `uploads/avatars/` は実体ゼロ → 移行不要

### 3.6 セキュリティヘッダ／CORS

- **Cookie**: `secure: process.env.NODE_ENV === "production"` 設定済み（OK）
- **CORS**: 同一オリジン運用なら不要
- **CSP**: 未設定 → 本番化時に最小限のCSPを `next.config.ts` で追加推奨（任意）

---

## 4. DB移行プラン

### 4.1 マネージドPostgreSQL 比較

| サービス | Vercel連携 | 無料枠 | 有料 | 推奨度 |
|---|---|---|---|---|
| **Neon** | ◎ Marketplace 1クリック | 0.5 GB / 191時間compute/月 | $19/月で 10GB / 専用compute | **★★★ 第一推奨** |
| Vercel Postgres（中身Neon） | ◎ ネイティブ | Neonと同等 | 同等 | ★★ Neon直接の方がBranching等の機能フル活用可 |
| Supabase | ○ Marketplace あり | 500MB DB / 5GB Storage | $25/月 8GB | ★ 認証・Storage等が被る、過剰 |
| Railway | △ 手動連携 | $5クレジット | 従量課金 | × Vercel公式統合なし |

#### Neon を推す理由

1. **Vercel Marketplace から1クリックで接続**：`DATABASE_URL` が自動セット、Neon側のDB作成も Vercel UI から完結
2. **無料枠が運用に十分**：DB 0.5GB（Lumaの現状15MBに対して30倍余裕）+ compute 191時間/月（活発に使っても週末停止すれば収まる）
3. **Branching**：Vercel Preview環境ごとにDBブランチが切れる（Production DBに影響しないPRレビュー環境）
4. **Prisma連携実績豊富**：`@prisma/adapter-pg` + Pool構成（既存コード）はNeonにそのまま流せる
5. **PostgreSQL 17ネイティブサポート**：ローカルと完全一致

#### Vercel Postgres との違い

Vercel Postgres は内部実装がNeonに切り替わっているため、性能・互換性は同じ。ただしNeonダッシュボード（クエリエディタ、ブランチ管理、コネクションプーラー設定）をフル活用するなら**Neon直接契約のほうが管理しやすい**。Vercel Marketplace から Neon を入れれば、両方のメリット（自動環境変数セット + Neon UI）が手に入る。

#### コネクション数注意

- Neon無料枠：100同時接続（pooler経由なら数千）
- Vercel Functions は each invocation で新規接続を作りがち → **Prisma + pgBouncer (Neon内蔵) でコネクションプール**必須
- 接続文字列に `?sslmode=require&pgbouncer=true&connection_limit=1` 推奨

### 4.2 移行手順（ローカル → Neon）

#### 前提

- ローカルDB：`salesagent_luma` / 15MB / users 8 / companies 1654 / deals 1654 / contacts 4840 / deal_products 2555
- 目標DB：Neon Production branch

#### ステップ

1. **Neon プロジェクト作成**（Vercel Marketplace経由 or Neon直接）
2. **Vercel プロジェクトに Neon 統合追加** → `DATABASE_URL` 自動セット
3. **ローカルから schema 適用**：
   ```bash
   # ローカルから一時的に Neon URL を指定
   DATABASE_URL=<neon_url> npx prisma db push
   ```
   → テーブル構造（20テーブル）が Neon に作成される
4. **データ pg_dump → restore**：
   ```bash
   # ダンプ（カスタム形式、所要1分以内）
   pg_dump --host=localhost --port=5432 --username=postgres \
     --no-owner --no-acl --format=custom --data-only \
     --file=salesagent_luma.dump salesagent_luma
   # リストア（Neonへ、所要5〜10分）
   pg_restore --no-owner --no-acl --data-only \
     --dbname=<neon_url> salesagent_luma.dump
   ```
   `--data-only` でスキーマは触らず、データだけ流し込む
5. **シーケンス調整**（pg_dump --data-only ではシーケンスが進まないことがある）：
   ```sql
   -- 必要に応じて各テーブルの主キーシーケンスを max(id)+1 に
   -- ※Lumaのスキーマは主キーが UUID なので不要
   ```
6. **接続テスト**：ローカルから `DATABASE_URL=<neon_url> npx prisma studio` でデータ確認
7. **Vercelデプロイ → ステージング環境で動作確認**

**所要時間**：ステップ3〜6で**実働1〜2時間**。実データのバックアップを取ってからやれば失敗してもやり直し可。

### 4.3 ロールバック手順

- Neon側に問題が起きた場合：
  - **Neon Branching でPoint-in-Time復元**（無料枠でも7日以内のPITR可）
  - 最悪の場合 ローカル `salesagent_luma` を Source of Truth として再ダンプ・再投入
- ローカルDB は本番化後も**最低3ヶ月は破棄しない**ことを推奨

---

## 5. 認証・ユーザー配布フロー

### 5.1 現行実装の確認

| エンドポイント | 機能 | 実装状況 |
|---|---|---|
| `POST /api/auth/login` | メール+パスワードでログイン | ✅ 既存 |
| `POST /api/auth/register` | 新規登録（招待トークン or 直接） | ✅ 既存 |
| `PATCH /api/auth/password` | 自分のパスワード変更 | ✅ 既存 |
| `POST /api/invites` | 招待トークン発行 | ✅ 既存（admin専用想定） |
| `GET /api/invites/[token]` | 招待トークン検証 | ✅ 既存 |
| **管理者によるパスワードリセット** | admin が他ユーザーのパスワード強制リセット | ❌ **未実装** |
| **初回ログイン強制パスワード変更** | 仮パスワード→新パスワードへ強制変更 | ❌ **未実装** |

### 5.2 既存users 8件の初期パスワード配布（社長判断ポイント D）

#### A案：admin による初期パスワード一括設定 + 強制変更（**推奨**）

1. admin（社長）が Prisma Studio または専用スクリプト `scripts/issue-initial-passwords.ts` を実行
2. 各ユーザーに **8〜10桁のランダム仮パスワード**を生成し bcrypt ハッシュをDBに保存
3. CSV または Slack DM で各社員に「メール / 初回パスワード / ログインURL」を**個別配布**
4. 初回ログイン時、システムが `passwordResetRequired=true` を検出して `/account/password` に強制リダイレクト
5. ユーザーが新パスワード設定 → フラグを下ろして本利用開始

**実装作業**：
- `User` テーブルに `passwordResetRequired` Boolean カラム追加（migration 1本）
- `middleware.ts` でフラグ検出 → `/account/password` 以外はリダイレクト
- 初期パスワード発行スクリプト `scripts/issue-initial-passwords.ts` 新規作成（出力CSV）
- 工数：**0.5日**

#### B案：招待リンク方式（Inviteテーブル既存活用）

1. admin が `POST /api/invites` で社員8名分の招待トークンを発行
2. URL `https://luma.example.com/register?token=xxx` を Slack で配布
3. 各社員がアクセスし、自分でパスワードを設定して登録
4. 登録時に既存User（Notionから取り込み済み）と email でマージするロジックが必要

**問題点**：
- 既存users 8件は**Notion連携で既に作成済み**で `passwordHash=null` → 招待トークンでは「既存メールあり」エラーになる（registerAPIがチェック済み）
- マージロジックの追加実装が必要

**A案の方がシンプル**で既存データと整合性が取れる。

### 5.3 アクセス制限

社長方針：**IP制限・SSO等は不要、認証だけで運用**。

ただし以下の最小限のハードニングは実装推奨：
- **bcrypt rounds = 10**（既存）→ 12 に引き上げ（処理時間+50ms 程度、ログイン数十回/日なので問題なし）
- **JWT_SECRET を 64文字ランダム**で本番発行（`openssl rand -hex 32`）
- **Cookie: `secure=true`, `httpOnly=true`, `sameSite=lax`**（既存OK）
- **rate limit**：Vercel Functions に `@upstash/ratelimit` を導入（5回/分の login 試行制限）。**実装工数1〜2時間、推奨**

### 5.4 監査ログ

- 既存：`AiLog`テーブル（AI推論の入出力ログ） / `User.lastLoginAt`（ログイン時刻）
- 不足：**ログイン失敗ログ・パスワード変更ログ・admin操作ログ**

本番化必須ではないが、**個人情報を扱う以上、半年以内には監査ログテーブル追加**を社長と握っておきたい（社内利用なので法的な強制力はないが、社員間トラブル防止）。

---

## 6. 段階的ロールアウト計画

### フェーズ1: Gemini化（ローカル動作確認）

**所要：実働2〜3日**

#### 作業内容

1. パッケージ追加：`npm i ai @ai-sdk/google @google/generative-ai`
2. `.env` に `GEMINI_API_KEY` 追加（Google AI Studioで発行）
3. `src/lib/ai/anthropic.ts` を `src/lib/ai/gemini.ts` にリネーム＋中身置換
   - `callClaude` / `callClaudeJSON` のシグネチャは維持し中身を Gemini AI SDK に
   - JSON出力は `generateObject` で zod スキーマ準拠
4. `src/lib/ai/openai.ts` の `transcribeFile` を Gemini Files API + 直叩きSDKで再実装
5. 全呼び出し元（前掲リスト）の import 文を `@/lib/ai/gemini` に書き換え（機械的）
6. ローカルで動作確認：
   - 録音→7段推論→DB保存
   - チャット
   - ロープレ
   - BANT集約
   - Webサイト要約
7. 7段推論の品質確認：架空商談1〜3件で出力比較。STEP3/7のみ Pro モデルに切り替えるかの判断

#### 完了条件
- TypeScript型チェック PASS
- `npm run build` PASS
- ローカルで全AI機能が動作

#### ロールバック
- Anthropic SDKを残す → ENV変数 `AI_PROVIDER=anthropic|gemini` で切替可能にしておく（保険）
- このフェーズで詰んだら、Anthropic+OpenAI の現状実装に戻すだけ

### フェーズ2: Vercel + Neon ステージング構築

**所要：実働2日**

#### 作業内容

1. Vercel プロジェクト作成（GitHubリポジトリ連携）
2. Neon Marketplace 経由で接続（`DATABASE_URL` 自動セット）
3. Vercel Blob 統合追加
4. 環境変数を Vercel UI で設定（前掲表参照）
5. **uploadsコード3箇所を Vercel Blob 化**（前述3.5節）
6. `package.json` に `postinstall: prisma generate` 追加
7. `vercel.json` でビルドコマンドを `prisma generate && prisma migrate deploy && next build` に
8. ステージング（Preview）デプロイ → 動作確認
9. **maxDuration の設定見直し**：Pro plan前提で `meetings/analyze` を 300秒に
10. Vercel Functions ログ確認

#### 完了条件
- ステージングURLでログイン・案件閲覧・録音アップロード・7段推論まで全部通る
- Functions エラーログがクリーン

#### ロールバック
- Vercel デプロイは何度でもやり直し可（Production にプロモートしなければ影響なし）

### フェーズ3: データ移行

**所要：実働1日（うち実作業1〜2時間、確認バッファ多め）**

#### 作業内容

1. **本番直前バックアップ**：ローカル `salesagent_luma` を pg_dump（custom format）でバックアップ → 別パスに保存
2. Neon Production branch に schema を `prisma db push` で適用
3. ローカル → Neon に `pg_dump --data-only | pg_restore` でデータ流し込み
4. Prisma Studio で件数確認（users 8 / companies 1654 / deals 1654 / contacts 4840 / deal_products 2555）
5. Vercel本番ビルド（Production deployment）
6. 本番URLで管理者ログイン → 1案件開いて画面確認

#### 完了条件
- Neon上にローカルと同件数のデータが揃う
- 本番URLで案件詳細・パイプライン・ダッシュボードが正しく表示

#### ロールバック
- Neon Production branch を削除 → 再作成 → 再投入
- ローカルDBは無傷で残るのでやり直しは何度でも可能

### フェーズ4: 社員8名配布・本番開始

**所要：実働0.5日**

#### 作業内容

1. **管理者リセット機能の実装**（5.2 A案）
   - `User.passwordResetRequired` カラム追加
   - middleware で強制リダイレクト
   - `scripts/issue-initial-passwords.ts` で仮パスワード一括発行・CSV出力
2. 社長（社内エンジニア）が初期パスワードCSVを取得 → Slack DMで個別配布
3. 各社員が初回ログイン → 強制パスワード変更
4. Slackで「使い方ガイド」の URL を共有（要別途ドキュメント、本計画外）
5. 1週間モニタリング：Vercelログ・Geminiクオータ・Neon容量

#### 完了条件
- 社員8名全員が初回ログイン完了
- 本番1週間でエラー率1%未満

#### ロールバック
- 全ユーザーのパスワードハッシュを退避し、必要なら旧JWTを失効させて再配布

### フェーズ別所要・累積

| フェーズ | 内容 | 実働 | 累積 |
|---|---|---|---|
| 1 | Gemini化 | 2〜3日 | 〜3日 |
| 2 | Vercel+Neon ステージング | 2日 | 〜5日 |
| 3 | データ移行 | 1日（うち作業実2時間） | 〜6日 |
| 4 | 配布・本番開始 | 0.5日 | 〜7日（実働ベース） |
| **バッファ込み** | テスト・社長確認・調整 | +5〜7日 | **〜2週間** |

**最短ストーリー：5/8着手 → 5/22 本番開始**（GW明けすぐ着手すれば現実的）

---

## 7. リスク・懸念

### 7.1 既知のリスクと対策

| # | リスク | 影響度 | 対策 |
|---|---|---|---|
| 1 | **Gemini RPD 250制限** で営業繁忙期に詰まる | 中 | 無料枠で開始 → 200/日超え週3日でPaid Tier 1切替（社長承認なしで実施可） |
| 2 | **`meetings/analyze` 7段推論が60秒超過**（Hobby planで打ち切り） | 高 | **Pro plan $20/月で開始**（推奨）/ または Workflow分割（実装+5日） |
| 3 | **Vercel Blob 容量超過** | 低 | 月1GB試算、Pro $20で5GB込み。録音は3ヶ月で自動削除する cron 検討 |
| 4 | **既存ユーザー8件のメールタイポ・重複** | 低 | 移行直前に `SELECT email, count(*) FROM users GROUP BY email HAVING count(*)>1` で確認 |
| 5 | **Neon コネクション枯渇**（Vercel Functions 大量同時起動） | 中 | pgbouncer = on / connection_limit = 1 で対策。実装1行 |
| 6 | **Gemini 2.5 Flash の品質がClaude Sonnet 4より低い** | 中 | フェーズ1の品質確認で判定。STEP3/7 を `gemini-2.5-pro` に切替 / Few-shotを増やす |
| 7 | **音声書き起こしの精度劣化**（Whisper→Gemini） | 中 | 1〜3件の実商談で比較。劣化が大きければ OpenAI Whisper API を別途維持（**月$2程度**で済む） |
| 8 | **NextAuth+Auth.js依存パッケージ**（不要化） | 低 | 削除しなくても害なし。コード整理は本番後でOK |
| 9 | **本体・リージー版に Vercel/Gemini 移行の影響を波及させる** | 低 | フォーク済みなのでLuma単独で改修OK、本体・リージーには干渉しない |
| 10 | **個人情報（顧客企業名・連絡先）流出** | 高 | Vercel Functions のログに request body を出さない / Gemini APIへの送信ログは Google側のRetention設定で30日（Paid Tier 1以上）/ JWT_SECRETの厳格管理 |

### 7.2 公開後に追加で必要な運用作業

| 作業 | 頻度 | 備考 |
|---|---|---|
| **Vercel Functions ログ監視** | 週次 | エラー率・遅延 |
| **Gemini クオータ確認** | 週次 | 無料枠運用時は特に |
| **Neon DB 容量・クエリ性能** | 週次 | 1GBに迫ったら有料化 |
| **Vercel Blob 容量・操作数** | 月次 | 録音の自動削除cron検討 |
| **DBバックアップ** | 日次 | Neon無料枠でPITR 7日 / 月次でローカルにdump |
| **依存パッケージ脆弱性スキャン** | 月次 | `npm audit` |
| **Geminiモデル更新追従** | 四半期 | Google が新モデル出すたび評価 |
| **コスト確認** | 月次 | Vercel + Gemini + Neon 合算で予算管理 |

### 7.3 本番1ヶ月後コスト試算（中央値）

| 項目 | 月額 |
|---|---|
| Vercel Pro（seat 1名） | $20 |
| Gemini API（無料枠卒業後） | $10〜30 |
| Neon（無料枠運用 → Pro $19 切替） | $0〜19 |
| Vercel Blob | $0〜5 |
| **合計** | **$30〜75 / 月**（4,500〜11,000円） |

社員8名の社内利用ツールとしては妥当な水準。

---

## 8. 社長判断ポイント一覧（要承認）

| # | 判断ポイント | 推奨案 | 代替案 | 影響 |
|---|---|---|---|---|
| **A** | Gemini SDK採用方針 | **Vercel AI SDK + Files API直叩きハイブリッド** | 全部Vercel AI SDK / 全部直叩き | コードのプロバイダ抽象度 |
| **B** | DB選定 | **Neon（Vercel Marketplace経由）** | Vercel Postgres / Supabase | 月額・管理UI・Branching |
| **C** | ファイル保存先 | **Vercel Blob（必須）** | S3互換（AWS S3, R2） | 月額$0〜5 |
| **D** | パスワード配布方式 | **admin初期発行+強制変更（A案、要追加実装0.5日）** | 招待リンク方式（B案、既存マージロジック追加） | 既存データとの整合性 |
| **E** | Vercelプラン | **Pro $20/月（seat 1名構成）** | Hobby+Workflow分割（実装+5日） | 本番タイムアウト・初期実装工数 |
| F | 7段推論の品質モデル | **gemini-2.5-flash 全段 → 1週間で評価** | STEP3/7のみ Pro | 月額+$5〜10 / 品質+10〜20% |
| G | 監査ログ実装時期 | **本番1〜3ヶ月後** | フェーズ4と同時 | 工数+1日 |

**特に A〜E はフェーズ1着手前に承認を貰いたい**。F, G は本番後に判断可。

---

## 9. 着手前チェックリスト

- [ ] 本計画書を社長レビュー
- [ ] 判断ポイント A〜E を確定
- [ ] Google AI Studio で `GEMINI_API_KEY` 発行
- [ ] Vercel アカウントの所有権確認（個人 or 法人 / Pro契約は法人推奨）
- [ ] Neon アカウント / GitHub組織アカウントの確認
- [ ] 本番ドメイン（例: `salesagent.luma-create.com`）の確認 → DNS設定計画
- [ ] 移行リハーサル日程（フェーズ3）の確保

---

## 10. 補足：本体・リージー版との差分管理について

Luma版は **本書の判断でGemini化**するが、本体・リージー版は依然 Anthropic+OpenAI構成のはず。半年に1度、3者の差分棚卸しが必要（CLAUDE.md に明記済みポリシー）。

特に Gemini化で `src/lib/ai/anthropic.ts` `src/lib/ai/openai.ts` を `gemini.ts` に集約する場合、**呼び出し元のファイルが本体・リージーから差分発生する点**に注意。本体・リージーの新機能を取り込む際、AI呼び出し部分のマージが手間になる。

→ **対策**：`callClaude` / `callClaudeJSON` の関数名を維持し、内部実装だけ Gemini に差し替える方式を採用すれば、呼び出し側のdiffがゼロになり、本体・リージーからの新機能取り込みコストは最小化できる。

---

以上。承認後、フェーズ1から順次着手します。
