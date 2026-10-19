# 開発環境セットアップ手順

このリポジトリを自分のPCで動かし、ブラウザからログインして商談画面を触れるようにするまでの手順です。
所要時間は初回で30〜40分（うち待ち時間が大半）を見込んでください。

開発は各自のPCで行い、DBはクラウド（Neon）の無料枠を各自1つ持ちます。
**Vercel のアカウントを作る必要はありません。** ブランチを push すると、共用のVercelプロジェクトが
そのブランチ専用の Preview URL を自動で払い出します（詳細は「13. Vercel Preview での確認」）。

---

## 0. 事前に必要なもの

| 必要なもの | 確認コマンド | 無い場合 |
| --- | --- | --- |
| Node.js 20 以上（推奨 22） | `node -v` | [nodejs.org](https://nodejs.org/) から LTS をインストール |
| npm 10 以上 | `npm -v` | Node.js に同梱 |
| Git | `git --version` | macOS は `xcode-select --install` |
| GitHubアカウント | — | リポジトリへのアクセス権をもらう |
| Neonアカウント | — | [neon.tech](https://neon.tech/) で GitHub 連携サインアップ（無料） |

Postgres をPCにインストールする必要はありません。DBは Neon 上に置きます。

---

## 1. リポジトリを取得する

```bash
git clone <リポジトリURL>
cd salesagent-luma
```

## 2. 依存パッケージをインストールする

```bash
npm install
```

`postinstall` で `prisma generate` が自動実行され、Prisma のクライアント型が生成されます。
完了まで1〜2分かかります。

## 3. Neon にデータベースを作る

1. [console.neon.tech](https://console.neon.tech/) にログインし、**Create project** を押す
2. 設定は以下にする
   - **Project name**: `salesagent-luma-dev-<自分の名前>`（誰のものか分かるように）
   - **Postgres version**: 17
   - **Region**: `Asia Pacific (Singapore)` または `AWS ap-northeast-1`（近ければどこでもよい）
   - **Database name**: `salesagent_luma`
3. 作成後に表示される **Connection string** をコピーする

> **Database name を `salesagent_luma` にする理由**
> Neon の既定のDB名は `neondb` ですが、リポジトリ内の一部のシードスクリプト
> （`seed-luma.ts` / `seed-luma-admin.ts`）が「接続先に `salesagent_luma` が含まれること」を
> 安全装置として検査しており、名前が違うと実行時に止まります。
> あとで作り直す手間を避けるため、最初からこの名前にしてください。

接続文字列はこういう形をしています。パスワードが含まれるので、Slack等に貼らないこと。

```
postgresql://<user>:<password>@ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech/salesagent_luma?sslmode=require
```

## 4. `.env` を作る

```bash
cp .env.example .env
```

`.env` を開き、最低限この2つを埋めます。`.env` は `.gitignore` 済みで、コミットされません。

```bash
# 手順3でコピーした Neon の接続文字列
DATABASE_URL="postgresql://...neon.tech/salesagent_luma?sslmode=require"

# セッションJWTの署名鍵。下のコマンドで生成した文字列を貼る
JWT_SECRET="..."
```

`JWT_SECRET` はこれで生成できます。

```bash
openssl rand -base64 32
```

**AIのAPIキーは、最初は空のままで構いません。** このアプリのAIパイプラインは
キーが無いときに決定論的なフォールバック出力を返すため、画面の動作確認はキー無しで完結します。
AIの出力そのものを検証したくなった段階で `GOOGLE_GENERATIVE_AI_API_KEY` を設定してください。

## 5. スキーマをDBに反映する

```bash
npm run db:push
```

`prisma/schema.prisma` の内容が Neon 側にテーブルとして作られます。
このプロジェクトは `prisma migrate` を使わず `db push` で運用しています。

> `db push` はテーブルを作るだけで、**中身のデータは1行も入りません**。次の手順が必須です。

## 6. 開発用データを投入する

```bash
npm run db:seed:dev
```

`prisma/seed-dev.ts` が、ログインと画面表示に必要な最小セットを投入します。

- テナント 2件（Luma / リージー）
- 開発用ユーザー 4件（後述のログイン情報）
- マスタ（リード獲得経由 6件・パイプラインステージ 14件・業種 8件・プロダクト 3件＋プラン 6件）
- 架空の顧客企業 8社・担当者 8名
- 架空の商談 10件・商談プロダクト 11件
- 架空の議事録 3件・ToDo 5件

投入されるのは**すべて架空データ**です。実在の顧客名・金額は一切含まれません。

何度実行しても同じ状態になります（全レコードを固定IDで upsert しているため）。
データをぐちゃぐちゃにしてしまったら、もう一度実行すれば初期状態に戻せます。

> **`npm run db:seed`（`:dev` なし）は使わないでください。**
> こちらは本番DB向けのマスタ投入専用です。書き込み時に `tenant_id` を指定しないため、
> 開発用DBでは `tenant_id` が空文字の行ができ、**コマンドは成功したように見えるのに
> 画面には何も出ない**、という一番気づきにくい壊れ方をします。
> （本番DBには手書きSQLで外部キー制約が張られているのでその場で失敗しますが、
> `db push` で作った開発用DBには制約が無いため、素通りしてしまいます）

## 7. 起動してログインする

```bash
npm run dev
```

ブラウザで **http://localhost:3003** を開きます（3000番ではありません）。

| メールアドレス | パスワード | 権限 |
| --- | --- | --- |
| `admin@dev.test` | `dev1234` | admin（管理画面も触れる） |
| `manager@dev.test` | `dev1234` | user（マネージャー） |
| `sales1@dev.test` | `dev1234` | user（営業） |
| `sales2@dev.test` | `dev1234` | user（営業） |

普段は `admin@dev.test` を使ってください。権限による表示の違いを確認したいときだけ他を使います。

---

## 8. 動作確認チェックリスト

ここまで通れば環境構築は完了です。順に確認してください。

- [ ] `http://localhost:3003` を開くとログイン画面が出る
- [ ] `admin@dev.test` / `dev1234` でログインでき、ダッシュボードに遷移する
- [ ] サイドバーの「商談」から `/deals` を開き、商談が **8件** 表示される
- [ ] 商談を1件クリックすると詳細画面 `/deals/[id]` が開く
- [ ] 詳細画面に「これまでの流れ」「次の一手」「AIチャット」が表示される
      （ウィンドウ幅が1280px以上なら右カラムに、それ未満なら下に積まれて表示されます）
- [ ] 「サンプル製菓／採用動画の新規提案」の商談に、議事録が1件ぶら下がっている

### 商談が8件しか出ないのは正常です

投入した商談は10件ですが、一覧のデフォルト表示はヨミ（受注確度）で絞り込まれており、
`A+ヨミ / Aヨミ / Bヨミ / Cヨミ` の4区分だけが対象です。
「ネタ」の1件と「受注」の1件は初期表示から外れます。
画面上部のヨミバッジをクリックすれば表示に加えられます。

---

## 9. よくある詰まり

### `db:push` で SSL 関連のエラーが出る

接続文字列の末尾に `?sslmode=require` が付いているか確認してください。
Neon がコピー時に `&channel_binding=require` を付けることがありますが、これは付いたままで構いません。

### シードは成功したのに、ログイン後の画面が全部空

`tenant_id` が空文字のまま書き込まれています。
`npm run db:seed:dev` ではなく `npm run db:seed` を実行していないか確認してください。
その場合はテーブルを作り直すのが早いです。

```bash
npx prisma db push --force-reset
npm run db:seed:dev
```

`--force-reset` は接続先のデータを全消しします。**必ず自分のNeonプロジェクトに向いていることを確認してから**実行してください。

### シードが `[safety] 既存の企業が N 件あります` で止まる

実データが入っているDBに向いている可能性があります。**`DATABASE_URL` が本番を指していないか必ず確認してください。**
自分のNeonプロジェクトで間違いなく、単に前のデータが残っているだけなら、
`FORCE_DEV_SEED=1 npm run db:seed:dev` で続行できます。

### シードが `[safety] DATABASE_URL does not point to salesagent_luma` で止まる

`seed-luma.ts` / `seed-luma-admin.ts` の安全装置です。
Neon のDB名が `neondb` のままになっています。手順3に戻ってDB名を作り直すか、
Neon コンソールの **Databases** から `salesagent_luma` を追加して接続文字列を差し替えてください。

### 商談一覧が空になる

商談は表示されるが0件、という場合はヨミフィルタです（前述）。
ログインはできるのに何も見えない場合は、`user_tenants` の紐付けが無い可能性があるので
`npm run db:seed:dev` をもう一度実行してください。

### ポート3003が既に使われている

```bash
lsof -ti:3003 | xargs kill
```

### DBの中身を目で見たい

```bash
npm run db:studio
```

Prisma Studio がブラウザで開き、全テーブルを直接閲覧・編集できます。

---

## 10. AI機能を実際に動かす場合（任意）

`.env` に以下を設定します。既定のプロバイダは Gemini です。

```bash
AI_PROVIDER="gemini"
GOOGLE_GENERATIVE_AI_API_KEY="..."
```

キーは [Google AI Studio](https://aistudio.google.com/apikey) で発行できます。
無料枠にはレート制限があるため、連続実行すると 429 が返ることがあります。

**キーは各自のものを使い、共有しないでください。** 使用量が誰の操作によるものか追えなくなります。

---

## 11. Googleログイン・Google Meet連携（任意）

エンハンス機能①（Meet URL自動発行・録画取得）に関わる作業をする場合のみ必要です。
検証には**本番とは別のテスト用Googleアカウント**を使ってください。

`.env` に以下を追加します。

```bash
AUTH_SECRET="..."          # 未設定時は JWT_SECRET にフォールバック
AUTH_GOOGLE_ID="..."
AUTH_GOOGLE_SECRET="..."
NEXTAUTH_URL="http://localhost:3003"
```

Google Cloud Console でのOAuthクライアント発行手順は README を参照してください。
ただし **リダイレクトURIは `http://localhost:3003/api/auth/callback/google`** です
（READMEには 3002 と書かれていますが、現在の dev サーバーは 3003 で起動します）。

---

## 12. 開発を進めるときのルール

### ブランチを切って作業する

`main` に直接コミットしないでください。

```bash
git switch -c feat/<やることの短い説明>
# 作業してコミット
git push -u origin HEAD
```

### 絶対にやってはいけないこと

- **`.env` をコミットしない。** DBのパスワードとAPIキーが含まれます。
- **本番のDATABASE_URLを自分の `.env` に書かない。** シードスクリプトを流すと実データが壊れます。
- **実在の顧客名・担当者名・金額をコミットしない。** テストデータは架空のものだけを使ってください。
- **`npx prisma migrate` を使わない。** このプロジェクトは `db push` と手書きSQLで運用しています。

---

## 13. Vercel Preview での確認

ローカルで動いたら、ブランチを push してください。共用のVercelプロジェクトが自動でビルドし、
**そのブランチ専用のURL**を払い出します。GitHubのPR画面にURLが表示されます。

- **Vercelのアカウントは要りません。** push するだけで動きます。
- Preview は本番とは**別のデータベース**に接続されています。ここで何をしても実顧客データには影響しません。
- 逆に言えば、Preview のデータは他の人と共有です。壊しても構いませんが、他の人の検証中かもしれない点は意識してください。

**ローカルで動いた = 本番で動く、ではありません。** 次章の制約に当てはまる変更を入れたときは、
必ず Preview まで確認してからレビューを依頼してください。

---

## 14. ローカルでは気づけない Vercel の制約

`npm run dev` は制限のないただのNode.jsプロセスですが、Vercelはサーバーレス関数です。
以下はローカルでは100%成功し、Vercelでだけ失敗します。**エラーにならず結果だけ変わるものもあります。**

### アップロードは4.5MBを超えられない

Vercelの関数はリクエストボディが4.5MBを超えると、関数に到達する前に413を返します。
設定では変更できないインフラ側の固定値です。

ファイルをAPIルートのFormDataで受け取る実装は、4.5MB以下と分かっているもの（アバター画像など）に限ってください。
音声・動画・大きなPDFは、ブラウザから Vercel Blob へ直接アップロードし
（`@vercel/blob/client` の `upload()`）、APIには保存先のキーだけを渡します。

> 現在の録音機能（`POST /api/meetings`）は音声をFormDataで関数に送っており、この制約に抵触します。
> エンハンス機能①で作り替える対象です。

### 実行時間は60秒で打ち切られる

`vercel.json` と各ルートの `maxDuration` で60秒に設定されています。
ローカルには上限が無いため、3分かかるAI処理も手元では完走します。

時間のかかる処理は、リクエストを即座に返して裏で続ける形（202を返して非同期実行）にするか、
処理を分割してください。

### タイムゾーンはUTC

Vercelのサーバーは常にUTCで動きます。手元のMacはJSTです。
タイムゾーンを指定せずに日付を整形すると、**エラーは出ずに日付が1日ずれます**。

```
保存値: 2026-08-07T15:30:00Z
  ローカル(JST) → 2026/08/08
  Vercel(UTC)   → 2026/08/07
```

日付を扱うときは `timeZone: "Asia/Tokyo"` を明示してください。
手元でも本番と同じ条件にするには、`TZ=UTC npm run dev` で起動します。

### ローカルのファイルシステムに書けない

Vercelの関数のファイルシステムは読み取り専用で、`/tmp` だけが書き込み可能ですが、
次のリクエストには残りません。ファイルの保存は必ず `src/lib/storage.ts` 経由で行ってください。
このモジュールはサーバーレス上でBlobトークンが無い場合に、黙ってローカルに書かず例外を投げるようになっています。

### メモリに状態を持てない

リクエストごとに別のインスタンスで実行される可能性があります。
モジュールスコープの変数やMapをキャッシュ・キューとして使うと、ローカルでは動いて本番では消えます。
状態はDBに置いてください。

### ファイル名の大文字小文字が区別される

macOSは区別しませんが、Vercelのビルドは Linux で動くため区別されます。
`import Button from "./button"` でファイルが `Button.tsx` の場合、手元では通ってVercelのビルドが落ちます。

### push する前に必ずビルドを通す

上記のうちビルド時に分かるものは、これで手元で潰せます。

```bash
npm run build
```

`npm run dev` は型エラーやimportの不整合を素通りさせることがあります。
push する前の習慣にしてください。

---

## 補足：READMEの記述が古い点

`README.md` の「セットアップ」節は現状と食い違っています。この手順書の方が正です。

| READMEの記述 | 実際 |
| --- | --- |
| `http://localhost:3000` を開く | `3003` |
| `npm run db:seed` でデモユーザー＋商談6件が入る | 現在の `db:seed` はマスタのみ。しかも `tenant_id` が空で入るため画面に出ない |
| `demo@salesagent.local` / `demo1234` でログイン | このユーザーは作られない。`admin@dev.test` / `dev1234` を使う |
| AIキーは `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 既定は Gemini（`GOOGLE_GENERATIVE_AI_API_KEY`） |
| リダイレクトURIは `localhost:3002` | `localhost:3003` |
