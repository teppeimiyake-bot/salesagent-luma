# Luma営業エージェント 新機能仕様（2026-06 社長指示）

社長から salesagent-luma 宛に来た5機能の追加指示。本書は実装ブリーフ。

## 調査で判明した現状
- 見積書/契約書：現状は **手動アップロードのみ**（`src/components/deals/deal-quotes.tsx` / `deal-contracts.tsx` → `Document` category=quote/contract）。**自動生成は未実装**。
- ヨミ：`A+ヨミ(90%) / Aヨミ(70%) / Bヨミ / Cヨミ / ネタ / NG / 受注` の7段階が `src/components/deals/yomi-filter-config.ts` に定義済み。yomiは **DealProduct** 単位（商材ごと）。接頭辞 `【映像】【SNS】【CATV】` 付きで保存される（`src/lib/yomi-status.ts`）。
- 商材カテゴリ：映像 / SNS / CATV / アライアンス（`src/lib/product-categories.ts`）。
- 企業情報：`Company` に `name` / `address` / `ceoName` あり → 契約書差込に必要な項目は揃う。
- DealProduct：`amount`（提案金額・円）/ `planName` / `planProposals[]`（企画案）/ `yomiStatus`。
- Document：category に quote/contract/template/proposal、`scope`(global/deal)、`dealId`、`version`、`fileUrl` あり。
- **PM進捗タブ・入金管理タブは未実装**。
- 本番稼働中・社員8名利用・Neon DB。**スキーマ変更は手動 `prisma db push` 必須（migrations未使用）**。社長が並行gitすることあり。

## 実装上の制約（厳守）
- **新規ブランチ**で作業（`feature/quote-contract-pm-payments` 等）。`main` / `deploy/company-merge` を直接いじらない。**自動pushしない**。
- 社長のWIP（現在 modified の `dashboard/page.tsx`・`import-notion-meeting-notes.ts` 等）には触れない。
- 本番DBへの `db push` は社長確認後。スキーマ追加分のSQLは別途用意し、ローカル/dev で検証。
- PDF生成は Vercel serverless 互換のものを使う（`@react-pdf/renderer` 推奨。puppeteer系は避ける）。

---

## 機能1：見積書の自動作成
- DealProduct（=プラン/企画案）単位で **複数** の見積を作成可能。
- 「過去の見積データを参照して金額を自動入力」→ 同一 **商材カテゴリ × プラン × 企画案** の過去 `DealProduct.amount` 実績（直近N件の中央値など）をサジェスト。フォールバックは `ProductPlan.basePrice`。
- 自動入力された金額は **手修正可**。
- 確定すると見積PDFを生成し `Document`(category=quote, scope=deal, dealId, version) に格納。PDFダウンロード可。
- テンプレは経理フォルダの過去お見積書PDFのレイアウトを踏襲（社名・御中・項目・小計・消費税10%・合計）。

## 機能2：契約書の自動作成
- トリガー：**DealProduct.yomiStatus が `A+ヨミ` に遷移した時**（接頭辞付き `【映像】A+ヨミ` 等も判定）。
- 差込元：`Company.name` / `address` / `ceoName` ＋ その DealProduct の見積金額 ＋ 営業エージェントに格納された契約書フォーマット（`Document` category=template/contract の雛形）。
- 自動生成された契約書ドラフトは確定前に手修正可。確定で `Document`(category=contract, scope=deal) に格納、PDFダウンロード可。

## 機能3：発行物の自動格納＋PDFダウンロード
- 見積・契約の発行物を `Document` に自動格納（scope=deal / dealId 紐付け）。
- サーバ側でPDF生成（`@react-pdf/renderer`）。既存の `/api/documents/[id]/download` を流用。

## 機能4：受注企業の案件進捗（PMタブ）
- 画面右側に **受注企業だけ** を表示するタブ「PM（受注管理）」を新設。新ルート `src/app/(app)/pm/`。
- 対象：DealProduct.yomiStatus が受注系（`isWonYomi`）の商材を持つ企業/案件。
- **映像 / SNS / CATV** でサブタブ分け（商材カテゴリ）。
- 管理項目はNotion PMボード（`Luma PM-dev`）準拠：
  - プロジェクト名 / ステータス（撮影前・編集中・修正中・先方チェック待ち・修正待ち・納品間近・納品済み）/ PM（担当者）/ 撮影日 / 納品予定日 / 仮納品予定日 / ディレクター / カメラ / 編集 / 備考 / 納品済(チェック)
- 新モデル `ProductionProject`（DealProduct 1:1 もしくは Deal+カテゴリ単位）を追加してインライン編集。

## 機能5：請求書送付状況・着金状況の管理（入金管理）
新ルート `src/app/(app)/payments/`。スポット / 定期 の2サブタブ。元データは `docs/payment-mgmt/入金管理_spot.csv` / `入金管理_recurring.csv`。

### スポット（InvoiceRecord）
列：顧客名 / 支払時期(前払い・納品後支払い・分割支払い) / 契約締結状況(締結済み・未締結) / 請求書送付状況(送付済み・未送付・前金分送付済み) / 着金状況(確認済み・未確認・前金分確認済み) / 納品予定日 / 着金見込み日 / 契約金額(税抜) / 着金金額(税込)。
- **着金金額 = 契約金額 × 1.1（税込）**。確認済み・分割の検算ロジックに利用。
- 可能なら Deal/DealProduct と顧客名で紐付け（重複企業注意：`reference_salesagent_luma_dup_companies`）。

### 定期（RecurringBilling ＋ RecurringBillingPeriod）
列：顧客名 / 初期費用 / 月額 / 契約開始日 / 契約終了日 ＋ **月次グリッド**（各月ごとに「請求送付」「着金」のbool 2フラグ）。
- 40列のフラグを生で持たず、`RecurringBillingPeriod`（billingId, 対象年月, sent bool, paid bool）で正規化。
- 画面は月次グリッド（横＝月、縦＝顧客、セル＝送付/着金トグル）。

CSV実データを初期投入用シードに使う（`scripts/seed-payments.ts`）。

---

## 推奨フェーズ
1. スキーマ設計（InvoiceRecord / RecurringBilling / RecurringBillingPeriod / ProductionProject）＋ `db push` 用SQL作成（ローカル検証）。
2. 機能5（入金管理）：データが確定しているので最初に。CSVシード投入。
3. 機能4（PMタブ）。
4. PDF基盤（`@react-pdf/renderer`）＋ 機能1（見積自動作成）。
5. 機能2（契約自動生成・A+ヨミトリガー）＋ 機能3仕上げ。

各フェーズ末でローカルコミット。完了後に社長へ「本番 db push / deploy 可否」を確認する。
