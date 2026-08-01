# 実行手順（Luma / リージー 統合）

対象ブランチ: `feat/multi-tenant`
前提: このブランチのコードは型チェック・ビルドともに通っているが、**DBにはまだ何も適用していない**。
`tenants` / `user_tenants` テーブルが無いので、いま `npm run dev` しても画面は動かない。

---

## 全体の流れ

```
1. テスト用DBを用意（Neon ブランチ）
2. マイグレーション台本を流す        ← ここで初めてタブが出る
3. テナント境界の自動検証を通す
4. ローカルで画面を確認
5. 問題なければ本番DBに同じ台本を流す
6. Vercel にデプロイ
```

所要はおおむね30分。**2〜4はテスト用DBに対して行い、本番には触れない。**

---

## 1. テスト用DBを用意する（Neon ブランチ）

本番データのコピーが一瞬で作れて、壊しても本番に影響しない。

1. https://console.neon.tech を開き、`salesagent-luma` のプロジェクトを選ぶ
2. 左メニュー **Branches** → **New Branch**
3. 名前を `multi-tenant-test`、元ブランチは `main`（本番）、「Include data」を選ぶ
4. 作成後の画面で **Connection string** をコピー

コピーした接続文字列を、リポジトリ直下に `.env.staging` として保存する:

```
DATABASE_URL="postgresql://……ここに貼る……"
```

> `.env.staging` は `.gitignore` 対象（`.env*`）なのでコミットされない。

---

## 2. マイグレーション台本を流す

```powershell
cd C:\dev\salesagent-luma
node scripts/run-sql.cjs .env.staging prisma/migrations-manual/2026-08-01_01_multi_tenant_up.sql
```

接続先のホスト名が表示され、5秒後に実行される（間違っていたら Ctrl+C）。

**これで起きること**

- `tenants` に2行（Luma / リージー）が入る
- 既存ユーザー全員が Luma に紐付く（admin には全社ビュー権限も付く）
- 既存データ（企業1,686 / 商談1,689 など）はすべて Luma のものになる
- 既存の画面の見え方は**何も変わらない**

**やり直したいとき**

```powershell
node scripts/run-sql.cjs .env.staging prisma/migrations-manual/2026-08-01_01_multi_tenant_down.sql
```

---

## 3. テナント境界の検証を通す

「リージーからLumaのデータが見えないこと」を機械的に確認する。

```powershell
npx tsx scripts/verify-tenant-isolation.ts .env.staging
```

全項目に ✓ が付けば通過。1つでも ✗ が出たらそこで止めて連絡してほしい（情報漏洩に直結する）。

検証内容:
- 作成した商談に正しい会社が入る
- リージーからLumaの商談が見えない（一覧・件数・**ID直指定**とも）
- リージーからLumaの商談を更新・削除できない
- 全社ビューは両社見えるが書き込みは拒否される
- 商談に紐づけて作る商材にも会社が入る
- 企業マスタは両社から見える

---

## 4. ローカルで画面を確認する

`.env` を書き換えずに、環境変数で上書きして起動する（環境変数のほうが `.env` より優先される）:

```powershell
$env:DATABASE_URL = (Select-String -Path .env.staging -Pattern '^DATABASE_URL="(.+)"').Matches.Groups[1].Value
npm run dev
```

このウィンドウを閉じれば元に戻るので、`.env` を書き換えて戻し忘れる事故が起きない。

確認する箇所:

| 画面 | 見えるもの |
|---|---|
| サイドバー最上部 | 「Luma / リージー」のタブ。切り替えるとヘッダーの社名と色（オレンジ↔緑）が変わる |
| 商談一覧 | リージーに切り替えると0件（まだデータを入れていないので正しい） |
| KPI | 画面上部に「Luma / リージー」の2タブ。切り替えると年度表記が変わる（Luma=FY2026は2026年6月〜2027年5月、リージー=2026年1月〜12月） |
| 新規商談ダイアログ | 最上部に「どちらの会社の商談か」の選択。既定はサイドバーで選んでいる会社 |

> タブは**2社以上に所属している人にだけ**出る。テスト用ブランチでは
> `prisma/migrations-manual/_test-only_add-reagey-membership.sql` を適用済みで、
> 社長と冨永さんがリージーにも所属している（他の12名は Luma のみ＝タブが出ない）。

画面を目視する代わりに、動いている dev サーバーへ実際にアクセスして確認するスクリプトもある:

```powershell
node scripts/smoke-tenant-ui.mjs
```

サイドバーのタブ、KPIの会社タブ、会計年度の切替（Luma=6月始まり／リージー=1月始まり）、
商談のテナント分離、切替APIの権限チェックまでを一括で確認する。

> **リージーのタブに切り替えると商談は0件、商材・リード獲得経由も空**になる。
> これは正しい状態（リージーのデータ移管は Phase 5 で行う）。
> このため、リージー側では新規商談の作成もまだできない（商材マスタが無いため）。

---

## 5. 本番DBに適用する

3・4が問題なければ本番に流す。**必ず 01 → 02 を続けて実行すること**（理由は下記）。

```powershell
node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_01_multi_tenant_up.sql
node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_02_default_tenant_for_legacy_code.sql
```

- 所要は数秒（最大でも contacts 4,892行）
- **既存の動作は変わらない**（全データが Luma のものになるだけ）
- 社員から見た画面も変わらない（全員 Luma のみ所属なのでタブが出ない）

### なぜ 02 が必要か（2026-08-01 に実際に踏んだ）

01 は `tenant_id` の既定値を `''` にする。これは「Extension を通らない INSERT を
FK 違反で確実に落とす」ための意図的な設計（fail-closed）。

ところが **01 を適用した時点で本番に出ているのはまだ旧コード**で、`tenant_id` を送らない。
その結果、既定値 `''` が入って FK 違反になり、**商談・議事録・タスク・書類の新規登録が
すべて失敗する**。実際に本番で次のエラーを確認した:

```
insert or update on table "deals" violates foreign key constraint "deals_tenant_id_fkey"
```

02 は既定値を一時的に Luma に変え、旧コードでも従来どおり登録できるようにする。
デプロイが終わったら 6 の手順で `''` に戻す。

**正しい順序**

```
01 適用 → 02 適用 → 新コードをデプロイ → 動作確認 → 03 適用（'' に戻す）
```

---

## 6. デプロイ

```powershell
git add -A
git commit -m "feat(tenant): Luma/リージーのマルチテナント基盤と会社タブを追加"
git push -u origin feat/multi-tenant
```

> git コマンドは分類器にブロックされるため、プロンプトで `!` を付けて実行してほしい。

push すると Vercel の Preview URL が出る。そこで確認し、問題なければ `main` にマージすると本番へ反映される。

### デプロイ完了後：fail-closed を戻す

本番デプロイが終わり、画面が正常に動くことを確認したら:

```powershell
node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_03_restore_failclosed_default.sql
```

既定値を `''` に戻し、「Extension を通らない経路は必ず落ちる」状態を回復する。
これをやらないと、生SQL・バッチ・外部連携が静かに Luma のデータを作ってしまい、
リージーのデータ移管後に取り違えが起きても気付けない。

---

## やってはいけないこと

| | 理由 |
|---|---|
| `npx prisma db push` を実行する | 手書き台本で作った制約・デフォルト値を壊す可能性がある。スキーマ変更は必ず `prisma/migrations-manual/` に台本を足す |
| リージーのデータを入れる（Phase 5） | **まだ実施できない。** 下の残作業が終わっていない |
| 本番で `verify-tenant-isolation.ts` を実行する | テスト用の商談・企業を作って消すため。テスト用DBでのみ実行する |

---

## リージーのデータ投入（Phase 5）の前に必要な残作業

| # | 作業 | 状態 |
|---|---|---|
| 1 | 生SQL 3箇所（`src/lib/deal-status-server.ts`）に `tenant_id` 条件を追加 | **完了**（`tenantSqlFilter()`。検証は `verify-tenant-isolation.ts` の[7]） |
| 2 | セッション外の経路を `runAsTenant()` で包む | **完了**（`/api/agents/candidates` を Luma 固定に。Vercel cron は無し） |
| 3 | 会計年度のテナント化（Luma=6月 / リージー=1月） | **完了** |
| 4 | `TENANT_STRICT=1` に切り替え | 検証済み・**本番反映は Phase 5 直前**（下記） |
| 5 | Luma側の重複企業の整理 | 澤村＝**別会社として記録済み**／エンビジョン＝**要作業**（下記） |
| 6 | リージー独自コンポーネントの移植 | **完了**（下記） |

### 4. TENANT_STRICT=1 について

`TENANT_STRICT=1` にすると、会社が決まらないまま テナント所有テーブルを触った箇所が
例外になる（いまは Luma にフォールバックして警告ログを出すだけ）。

strict モードの dev サーバーに対して全画面・全APIを叩く検証を用意した:

```powershell
# 別ウィンドウで strict の dev サーバーを起動
$env:DATABASE_URL = (Select-String .env.staging -Pattern '^DATABASE_URL="(.+)"').Matches.Groups[1].Value
$env:TENANT_STRICT = "1"
npx next dev -p 3004

# 別ウィンドウで
node scripts/verify-tenant-strict.mjs 3004
node scripts/verify-deal-create-tenant.mjs 3004
```

2026-08-01 時点で **27ページ・16API すべて通過**、商談作成の会社選択も HTTP 経由で確認済み。
ただし本番で有効にすると、万一の見落としがそのまま機能停止になる。1社運用のうちは
フォールバックで実害が無いため、**Vercel の環境変数に入れるのは Phase 5 の直前**とする。

### 5. Luma側の重複企業

**澤村（対応済み）**

「株式会社澤村」と「澤村株式会社」は名前が似ているだけの**別会社**（社長確認 2026-08-01）。
統合してはいけないため `company_merge_dismissed` に登録し、重複候補に二度と出ないようにした
（台本 `2026-08-01_04_dismiss_sawamura_pair.sql`）。

**エンビジョン（残作業・画面から実施）**

| 企業 | 商談 | 受注 | 連絡先 | HP | 登録日 |
|---|---:|---:|---:|---|---|
| 株式会社エンビジョン（`0f5eafd8…`） | 1 | 0 | 3 | envision-inc.jp | 2026-05-03 |
| 株式会社エンビジョン（`d054e48c…`） | 0 | 0 | 1 | envision-inc.jp | 2026-06-09 |

社名もHPも完全に一致しており、実態としての重複。古いほう（商談1・連絡先3）に寄せる。

統合は本番の管理画面 `/admin/company-merges` から実施する。
（統合APIはログインセッションを要するためスクリプトからは叩けない。
また CompanyMerge のスナップショット生成をSQLで再現するのは危険なので、必ず画面から行う）
スナップショットが残るので、間違えても画面から元に戻せる。

### 6. 移植したコンポーネント

リージー版にしか無かった KPI 機能のうち、**`MetricRollupView` のみ移植**した
（`src/lib/kpi-rollup.ts` + `src/components/kpi/metric-rollup-view.tsx` + `getKpiRollup()`）。
月次実績を正本に、四半期・年間KGIへ自動で積み上げる集計。

`MonthlyWonBoard` は移植していない。Luma の `KpiHierarchyView` が月クリックでの
受注企業ドリルダウンを内蔵しており、同等機能が既にあるため。

移植時の注意（踏むと数字が0になる）:
リージー版は受注判定が `yomiStatus === "受注"` の厳密一致だが、**Luma のヨミは
「【映像】受注」のようにプレフィックスが付く**ため、そのままでは受注を取りこぼす。
Luma 側では `isWonDeal` / `wonAmount`（`@/lib/deal-aggregations`）を使うよう書き換えてある。
