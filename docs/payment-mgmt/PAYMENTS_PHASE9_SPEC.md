# 入金管理 Phase 9 仕様（社長フィードバック 2026-06-04 追加）

Phase 8（色分け・項目別フィルタ・着金デフォルトフィルタ・顧客名→商談リンク）の上に積む。**Phase 8完了後に着手**（同一ファイル競合回避）。

## 1. プロダクト単位の入金管理（最重要・データモデル変更）
- 現状：InvoiceRecord/RecurringBilling は顧客（CSV1行）単位。
- 変更：**受注プロダクト（DealProduct）単位**で管理。同じ顧客でも別プロダクトを受注したら**プロダクトごとに別エントリ**。
- スキーマ：`InvoiceRecord` と `RecurringBilling` に `dealProductId String?`（FK→DealProduct, nullable, index, 逆リレーション）を追加。`scripts/sql/` に冪等ALTER追記（本番は私が後で適用）。
- 区分：
  - **スポット（InvoiceRecord）＝単発（映像/CATV等の都度納品）**。受注した非SNSプロダクトごとに1件。
  - **定期（RecurringBilling）＝SNS運用案件**。受注したSNSプロダクトごとに1件。
- バックフィル `scripts/backfill-payment-dealproduct.ts`（冪等）：
  - 受注（isWonYomi）DealProduct を走査し、カテゴリで spot/recurring に振り分け、`dealProductId`・`dealId`・`companyId` を設定したエントリを upsert。
  - 既存CSV由来の入金ステータス（送付/着金/日付/金額）は、**会社（＋可能ならカテゴリ）一致で該当プロダクトのエントリに引き継ぐ**。複数受注で振り分け不能な分は主要1プロダクトに付与し、他はブランク開始（要ログ出力）。

## 2. 契約金額 = 商談の提案金額（DealProduct.amount）連動
- スポットの `契約金額(税抜)` の既定値＝紐づく **DealProduct.amount（提案金額）**。`着金金額(税込)=契約金額×1.1` は維持。
- **入金管理画面でも金額調整可**（編集可）。編集は InvoiceRecord 側に保持（提案金額=DealProduct.amount は上書きしない＝商談側は不変）。提案金額からの「再同期」ができると尚良い（任意）。初期表示・新規生成時は提案金額をセット。

## 3. 納品予定日 = PM受注管理と連動
- スポットの `納品予定日` は PM（ProductionProject）の納品予定日と連動（ProductionProject.deliveryDate 等を一次ソースに表示。入金側で編集したら双方向 or 片方向＝実装しやすい方、最低でも表示連動）。dealProduct→ProductionProject で解決。

## 4. 着金見込み日の期日超過アラート
- `着金見込み日 < 本日` かつ 着金状況が未完了（**未確認 / 前金分確認済み**）の行は **赤字＋アラート表示**（バッジ/行ハイライト）。確認済みは対象外。
- 本日基準。`着金見込み日` 空欄は対象外。

## 5. 定期（SNS）＝受注管理と連動＋金額整合
- 定期は **SNS運用案件**。`契約期間（開始〜終了）` を PM受注管理（ProductionProject の serviceStartMonth/serviceEndMonth＝SNS提供開始/終了）と連動。
- **初期費用 ＋ 月額 × 契約月数 ＝ 提案金額（DealProduct.amount）** になるよう連動・検算。
  - 既定：月額・初期費用から算出した合計が DealProduct.amount と一致するか表示（不一致は警告）。
  - 月数は契約期間（開始〜終了）から算出。
- 定期も**入金管理画面で金額（初期費用・月額）調整可**。

## 6. アクセス制限：管理者のみ
- `/payments` 画面・API（GET含む）を **admin 権限のみ**に制限（現状 GET=viewer/更新=user → すべて admin に引き上げ）。サイドナビの「入金管理」も admin のみ表示。

## 実装後
- `tsc`/`build` PASS。dev検証（プロダクト別エントリ・金額連動・期日アラート赤字・定期の期間/金額連動・admin限定）。
- 本番反映手順（dealProductId のALTER SQL＋バックフィル＝SEED_ALLOW_PROD=1）を報告。push・本番反映はオーケストレーター（私）が実施。

## 決め（社長確認不要で進める既定。違えば後修正）
- 着金期日アラート対象＝未確認＋前金分確認済み（確認済みは除外）。
- 入金側の金額編集は商談の提案金額を上書きしない（独立保持・初期値は提案金額）。
- 複数受注企業のCSV入金ステータスは判定可能なプロダクトへ、不能分は主要プロダクトへ付与・他はブランク。
