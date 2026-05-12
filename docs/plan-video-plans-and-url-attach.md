# 映像プラン体系刷新 ＋ 提案書URL添付対応 実装計画書

調査日: 2026-05-12
担当: luma-sales-engineer
ステータス: **社長承認待ち**（実装は未着手）
対象環境: salesagent-luma (port 3003, DB=salesagent_luma)
本体・リージー版には触らない

---

## 0. 社長からの依頼（原文）

> 映像のプランがライト・オーダーメイド・プレミアムだがこれをNotionの企画内容のものに変更し、複数選択できるようにしてほしい。どれにも該当しない場合はプランは空白でOK。金額は据え置きで。また提案書はファイルアップロードとURL添付どちらでも対応できるようにしてほしい。Notion内にご提案企画書のプロパティがあり、そのURLもエージェント内に反映してほしい

---

## 1. Notion 実データ調査結果（read-only）

### 1-1. 「企画内容」プロパティ

| 項目 | 値 |
|---|---|
| Notion型 | **multi_select** |
| 選択肢数 | **13** |
| 1654件中の入力率 | 129件 filled / 1525件 empty（**約7.8%しか埋まっていない**） |
| 1ページあたり選択肢数 | 1〜5個（平均 約3個） |

**全13選択肢（Notion登録順 / 色付き）:**

| # | 選択肢名 | Notion色 | 実データ使用回数 |
|---|---|---|---:|
| 1 | 【SNS】縦型ショート動画 | blue | 35 |
| 2 | 【会社紹介】工場紹介動画 | default | 1 |
| 3 | 【会社紹介】CM | brown | 0 |
| 4 | 【会社紹介】ブランディングムービー | orange | 8 |
| 5 | 【採用】ドラマ風動画 | purple | 8 |
| 6 | 【採用】座談会動画 | green | 53 |
| 7 | 【採用】ブランディングムービー | yellow | 89 |
| 8 | 【採用】1日密着動画 | pink | 77 |
| 9 | 【採用】インタビュー動画 | red | **107** ← 最頻 |
| 10 | 【サービス紹介】CM | gray | 4 |
| 11 | 【CATV】映像企画 | blue | 3 |
| 12 | IR動画 | pink | 1 |
| 13 | 【採用】アニメーション | purple | 1 |

**観察**:
- 「【採用】」系（インタビュー/ブランディング/1日密着/座談会）が圧倒的多数
- 1Dealに「インタビュー＋1日密着＋ブランディング」の3点セットが最頻パターン（25件）
- 1ページ最大5タグ。明らかに「メニュー選択」というより「企画提案の構成要素タグ」として使われている

### 1-2. 「ご提案企画書」プロパティ

| 項目 | 値 |
|---|---|
| Notion型 | **url** |
| 1654件中の入力率 | 120件 filled / 1534件 empty |
| URLのドメイン | ほぼ Canva (`canva.com/design/...` または `canva.link/...`) |

サンプル:
- `https://www.canva.com/design/DAHHZmnZEvA/Uq1wzJJNb7rnXFpFbMea4g/edit`
- `https://canva.link/p5pccksgyxqol5t`

**観察**:
- 短縮URL（`canva.link/xxx`）と長尺URL（`canva.com/design/xxx/edit?...`）が混在
- すべてCanva。社内の提案書はCanvaで作成 → Canva共有リンクで顧客提示が定着している
- 120件中119件は「企画内容」も埋まっている → **「企画内容」と「ご提案企画書」はセット運用**

### 1-3. 関連プロパティ（参考）

| プロパティ | 型 | 用途 |
|---|---|---|
| 映像ヨミ | select (7段階) | 既存DealProduct(productName='映像')に同期済み |
| 企画作成者 | people | 提案書を作った社員（=dealProduct担当者の候補ソース） |
| 提案金額 | number | bant.proposalAmount 経由で取り込み済み（dealProduct.amount に反映済み） |

### 1-4. 既存DB側のNotion由来データ（既に取り込み済み）

import-luma-yomi.ts によって以下が**既に bant JSON に格納されている**:

| bantキー | 入力数 | 入力例 |
|---|---:|---|
| bant.notionPageId | 1654 | （全件） |
| bant.proposalDocUrl | **120** | `"https://www.canva.com/design/..."` |
| bant.planContents | **128** | `["【採用】インタビュー動画", "【採用】1日密着動画", ...]` |

**つまり Notion → DB の読込みは既に完了済み。UIに出していないだけ**。

---

## 2. 既存スキーマとの整合性

### 2-1. products / product_plans の現状

| カテゴリ (Product.name) | 既存プラン (ProductPlan.name) | basePrice |
|---|---|---:|
| **映像** | ライト | ¥400,000 |
| **映像** | オーダーメイド | ¥550,000 |
| **映像** | プレミアム | ¥700,000 |
| SNS | ベーシック / スタンダード / プレミアム / ハイエンド | 94万〜220万 |
| CATV | 1キャンパス | ¥50,000 |
| アライアンス | アライアンス | ¥0 |

**映像 deal_products の現状（1345件）**: 1225件が `planName='オーダーメイド'`、120件が `planName=null`。
→ これは過去の seed スクリプト（scripts/seed-products-and-link-deals.ts）で **「全件 オーダーメイド 一律」** にしたもの。意味のある選択ではない。

### 2-2. deal_products は複数行 = 複数プラン可能

- `DealProduct` は1Deal対多関係（`@@index([dealId])`）→ 複数行を作れば複数プラン紐付け可能
- ただし現状の業務ルールでは **「1Dealに対し映像/SNS/CATV/アライアンスを最大4種（カテゴリ1種につき1行）」** の運用
- 1Dealに「映像」×3行（インタビュー動画/座談会動画/1日密着動画）を作る発想は新しい

### 2-3. documents テーブルのURL添付対応

```prisma
model Document {
  fileUrl   String  // 必須 NOT NULL（現状）
  fileSize  Int?
  mimeType  String?
  ...
}
```

- `fileUrl` は NOT NULL かつ「ローカルストレージ / Vercel Blob のURL」前提
- 既に空文字フォールバック（`"(リンク未登録)"`）が POST メタデータ専用ブランチに存在 → 一部対応の素地アリ
- 既存 documents 数: **0件**（実データ未投入）→ **スキーマ変更しやすいタイミング**

---

## 3. 設計の論点（社長判断必要）

### 論点A: プラン体系の刷新方針（最重要）

調査の結果、Notion「企画内容」は **「メニュー」ではなく「企画提案の構成要素タグ」** として使われています（1企画=平均3タグ）。
現状の `ProductPlan` モデル（カテゴリ×プラン）に当てはめると複数の解釈が成立します:

| 案 | モデリング | 1Dealでの見え方 | メリット | デメリット |
|---|---|---|---|---|
| **A-1: 「映像」カテゴリのプラン名を13種に置換** | ProductPlan を13行に書き換え。1DealProduct=1プラン選択 | プロダクト構成テーブルに「映像 / 【採用】インタビュー動画」が1行 | 既存スキーマそのまま | **複数プラン選択ができない**（社長要望に反する） |
| **A-2: 1Deal × 「映像」カテゴリ × DealProduct複数行** | 「映像」だけで複数のDealProductを作れるようにUI改修 | プロダクト構成に「映像 / 【採用】インタビュー」「映像 / 【SNS】縦型」が**複数行** | 自然な複数選択 / 既存スキーマ完全互換 | 集計時に「映像×3行」を1案件として扱う考慮が必要 |
| **A-3: DealProduct.planName を string[] に変更** | スキーマ拡張、`plan_name` を JSON配列に | プロダクト構成1行に複数タグが並ぶ（ピル表示） | UI上の見やすさ最高 / 1Deal×1映像DealProductルールを維持 | **スキーマ破壊変更**（既存1225件のplanName='オーダーメイド'を配列化マイグレ必要） |
| **A-4: 新規 plan_tags テーブル追加** | `deal_product_plan_tags`（dealProductId, tagName）の中間テーブル | 1DealProductに複数タグを紐付け | 正規化されて検索性が高い | テーブル追加・JOIN・UI複雑度↑ |

**推奨: A-3（社長要望に最も忠実）**

理由:
1. 社長の言葉「**プランを複数選択**」「**金額据え置き**」「**どれにも該当しなければ空白**」 → 1行に複数プランタグが並ぶUI（チェックボックス/multi-select）が最も自然
2. 既存の運用「1Deal=映像1行+SNS1行+...」（DealProduct構成）を**壊さない**
3. Notion由来のplanContentsを**そのまま** UIに表示可能
4. 既存「オーダーメイド」一律のplanNameを `["オーダーメイド"]` 配列に移行する1回限りのマイグレーション（破壊リスク制御可能）

A-2でも実現可能ですが、「1企業=1Deal=複数プロダクト」の現運用と「1案件にインタビュー動画と密着動画と...という3点セット」というNotionの実データ構造を見ると、**A-3で1行にまとめた方が現場感に近い**と判断します。

> **社長確認事項A**: A-1〜A-4のどれを採用するか。**推奨はA-3**。

---

### 論点B: 13選択肢の管理方式

| 案 | 内容 |
|---|---|
| **B-1: ProductPlanマスタに13行投入し、複数選択UIで参照** | A-3で採用するなら、`ProductPlan` の13行が「選択肢マスタ」になる |
| **B-2: 別の専用マスタテーブル `plan_tags`** | カテゴリ非依存のタグマスタ |
| **B-3: enum/hard-coded** | コードにベタ書き |

**推奨: B-1**
- 既存のProductPlanテーブルをそのまま選択肢マスタとして使う
- admin画面（products-admin.tsx）から追加・並び替え・色設定可能
- Notion側で選択肢が増えたら手動or同期で追加

> **社長確認事項B**: B-1〜B-3のどれか。**推奨はB-1**。

---

### 論点C: 金額据え置きの解釈

社長メッセージ「**金額は据え置きで**」の解釈が複数あります:

| 解釈 | 内容 |
|---|---|
| **C-1: 既存 deal_products.amount は触らない** | 1225件の amount=550,000（オーダーメイド単価）はそのまま残す |
| **C-2: 新規プラン13種は basePrice=null（金額は商談ごとに手入力）** | プラン選択 → 金額は手動。提案金額は1Deal単位で「ご提案金額」フィールドを別途持つ |
| **C-3: 13プランそれぞれに basePrice を設定（社長と単価をヒアリングして決める）** | 「【採用】インタビュー動画=◯円」「【採用】ブランディングムービー=◯円」を別途定義 |
| **C-4: 旧プラン3種（ライト/オーダーメイド/プレミアム）の basePrice 40/55/70万を維持し、新タグ選択時の金額は手入力** | 「既存案件は40/55/70万のまま、新規はタグ＋手入力」 |

**推奨: C-1 + C-2 のハイブリッド**

理由:
1. 「金額は据え置き」=既存DBの金額を変えない=C-1
2. 新タグ13種は basePrice 持たない（C-2）→ 商談ごとに営業が手入力（実際の社内運用に合致：1日密着動画と座談会動画ではプロダクションコストが違うため、案件ごとに見積もる）
3. 既存1225件のオーダーメイド名は移行時に `["オーダーメイド"]` として残す。**営業がUIで明示的にタグ選び直したタイミング**で `["【採用】インタビュー動画", ...]` に置き換わる漸進的移行

> **社長確認事項C**: C-1〜C-4のどれか。**推奨はC-1+C-2**。
> もしC-3を選ぶ場合、13タグそれぞれの基準価格を別途ヒアリングが必要。

---

### 論点D: 複数選択UIの設計

| 案 | UI |
|---|---|
| **D-1: ピル選択（multi-pill）** | タグをクリックでオン/オフ。Notionの multi_select と同じ体験 |
| **D-2: チェックボックスリスト** | ドロップダウン内に13個のチェックボックス |
| **D-3: コンボボックス＋ピル** | 検索可能なコンボボックス＋選択済みはピル表示で削除可能（shadcn の Combobox 系） |

**推奨: D-3**
- 13選択肢中12種が実使用されており、将来増える可能性も高い → 検索可能なほうが良い
- 選択済みは色付きピルでカテゴリ（【採用】【会社紹介】【SNS】【CATV】【サービス紹介】）ごとに色分け（Notion色を踏襲）
- 「どれにも該当しない場合は空白」 → 何も選ばないで保存可能（必須バリデーション無し）

> **社長確認事項D**: D-1〜D-3のどれか。**推奨はD-3**。

---

### 論点E: 提案書のURL添付実装方針

documents テーブルへのURL添付対応:

| 案 | スキーマ変更 | 説明 |
|---|---|---|
| **E-1: 既存 fileUrl にURL文字列を入れる（"http://..." 直入れ）** | なし（互換） | 最小実装。`mimeType` を `"text/uri-list"` or `null`、`fileSize=null`、`/api/documents/[id]/download` は URL を 302 リダイレクト |
| **E-2: source_type カラム追加** | `sourceType String @default("file")` (`file` / `url`) | 表示時の挙動分岐がクリーン。ダウンロードボタン vs 外部リンクボタンを切り替え |
| **E-3: 別テーブル `document_links` を新設** | テーブル新設 | URL添付は documents とは別概念 |

**推奨: E-2**

理由:
1. 既存 documents は0件 → スキーマ変更コスト最小
2. URL添付とファイル添付は表示・DLボタンの挙動が違う（DL vs 新タブで開く / アイコン色 / ファイルサイズ表示の有無） → 明示的に区別したほうがUIが綺麗
3. 将来の「URL先のmeta scraping（Canvaのサムネ取得）」「Canvaリンク変換」等の拡張余地

具体的なスキーマ変更案:
```prisma
model Document {
  ...
  sourceType String @default("file") @map("source_type")  // "file" / "url"
  fileUrl    String                                        // file=Blob URL / url=外部URL
  fileSize   Int?
  mimeType   String?
  ...
}
```

> **社長確認事項E**: E-1〜E-3のどれか。**推奨はE-2**。

---

### 論点F: NotionからのURL／企画内容の取込タイミング

既存 bant.proposalDocUrl / bant.planContents は **import-luma-yomi.ts** 実行時のみ更新。

| 案 | タイミング |
|---|---|
| **F-1: 商談詳細画面に「Notion同期」ボタン**（手動・1件ずつ） | 営業がボタンを押した瞬間にNotion APIを叩いて最新化 |
| **F-2: import-luma-yomi.ts を増分対応の cron 化（夜間1回）** | 全件は重いので、`last_edited_time` で増分のみ |
| **F-3: F-1 と F-2 の併用** | 通常はcron、急ぎは手動 |
| **F-4: 既存 bant データ表示のみ（同期しない）** | UIに出すだけ。再投入は admin が import-luma-yomi.ts を手動実行 |

**推奨: F-1 + F-4 の段階導入**

Phase 1（即実装）:
- 既存 bant.proposalDocUrl / bant.planContents を**UIに表示**するだけで完了（120件のURL、128件のplanContentsが即座に見える）
- 投入済みデータの活用が最優先

Phase 2（後日）:
- 商談詳細に「Notionから最新化」ボタン追加（F-1）
- 1Deal分だけ Notion API を叩いて bant 更新 → planContents / proposalDocUrl をDealProductに反映

Phase 3（必要なら）:
- cron化（F-2）

> **社長確認事項F**: F-1〜F-4のどれか。**推奨はPhase 1先行（F-4）→Phase 2（F-1）**。

---

## 4. 推奨案を採用した場合の実装スコープ

採用前提: **A-3 + B-1 + C-1+C-2 + D-3 + E-2 + F-4→F-1**

### 4-1. スキーマ変更（prisma/schema.prisma）

```prisma
model DealProduct {
  ...
  planName  String?  @map("plan_name")  // 既存 (互換のため残置・1件目を表示)
  planNames String[] @map("plan_names") @default([])  // ★新規: 複数プラン
  ...
}

model Document {
  ...
  sourceType String @default("file") @map("source_type")  // ★新規: "file" / "url"
  ...
}
```

`db push` 1回で完了（カラム追加のみ、データ消失なし）。

### 4-2. データ移行スクリプト（破壊リスク低）

`scripts/migrate-plan-names-to-array.ts`:
1. 既存 deal_products (1345件) の planName を `[planName]` 配列にコピー
   - `"オーダーメイド"` → `["オーダーメイド"]`
   - `null` → `[]`
2. **bant.planContents が存在し、productName='映像' の DealProduct がある場合**、その bant.planContents 配列を `planNames` に上書き
   - **影響件数の試算**: bant.planContents 設定済み 128件 のうち、productName='映像'がある Deal の DealProduct → ほぼ全件
3. dry-run 必須、--apply フラグで本投入、`yomiStatus IN ('受注','締結済み')` は保護対象として除外

### 4-3. UI改修

| ファイル | 変更内容 |
|---|---|
| `src/components/deals/deal-products-panel.tsx` | プラン列を**multi-pill UI**に。13選択肢から複数選択・空可 |
| `src/components/deals/deal-documents.tsx` | アップロードフォームに「ファイル / URL」タブ。URL添付モード追加 |
| `src/app/api/deal-products/[id]/route.ts` | `planNames: string[]` 受付追加 |
| `src/app/api/deals/[id]/products/route.ts` | 同上 |
| `src/app/api/documents/route.ts` | `sourceType='url'` の場合 multipart 不要、JSON で `{ name, category, fileUrl(=URL), sourceType:'url' }` を受付 |
| `src/app/api/documents/[id]/download/route.ts` | sourceType=url なら 302 リダイレクト |
| `src/components/admin/products-admin.tsx` | 「映像」カテゴリのプラン管理画面で13タグを seed |

### 4-4. Notion 「ご提案企画書」自動反映（Phase 1）

商談詳細ページの「この商談の提案書・見積書」セクションに:
- bant.proposalDocUrl が存在すれば「Notion由来の企画書」として自動表示（カード1枚）
- カードからCanva URLに直接遷移可能
- 「documents テーブルへ取り込む」ボタンで documents 行を1件作成（sourceType='url' / category='proposal' / fileUrl=Canva URL）

### 4-5. seed スクリプト追加

`scripts/seed-eizo-plan-tags.ts`:
- 「映像」Product の plans を13行に拡張（既存3行はactive=falseで残置 or 削除）
- 各タグの basePrice=null（C-2）、color設定（Notion色を踏襲）

---

## 5. 工数見積もり

採用案（A-3/B-1/C-1+C-2/D-3/E-2/F-4→F-1）の実装工数:

| 作業 | 想定時間 |
|---|---:|
| 1. スキーマ拡張（planNames String[] / sourceType）+ db push | 0.5h |
| 2. seed-eizo-plan-tags.ts 作成・dry-run・apply | 1.0h |
| 3. migrate-plan-names-to-array.ts 作成・dry-run・apply（保護対象検証込み） | 2.0h |
| 4. DealProductsPanel UI 改修（multi-pill + 集計表示維持） | 3.0h |
| 5. deal-products API 改修（planNames受付・互換維持） | 1.0h |
| 6. deal-documents UI 改修（ファイル/URL タブ） | 2.5h |
| 7. documents API 改修（sourceType / URL受付 / download分岐） | 1.5h |
| 8. Phase 1: bant.proposalDocUrl の自動表示カード | 1.5h |
| 9. typecheck / build / 動作確認 / バグ修正バッファ | 2.0h |
| **合計** | **約15h（2営業日）** |

Phase 2（後日）の「Notionから最新化」ボタン: 追加で約3〜4h

---

## 6. 既知のリスクと注意事項

### 6-1. データ破壊リスク
- 既存 deal_products 1345件のうち **141件が「受注/締結済み」** → これは絶対に触らない（既存 seed-products-and-link-deals.ts と同じ保護パターンを踏襲）
- planName → planNames への移行は **dry-run 必須**

### 6-2. Notion同期の整合性
- Notion → DB の同期は片方向（既存）
- DB → Notion の同期は appointmentDate のみ実装済み（notion-sync.ts）
- planNames / proposalDocUrl の DB → Notion 同期は今回は**実装しない**（必要なら社長判断後に追加）

### 6-3. UIの後方互換
- `planName`（単数）も `planNames`（複数）も両方存在する遷移期間が発生
- 表示は `planNames[0] ?? planName` のフォールバック
- 編集すると planNames が正、planName は `planNames[0] ?? null` に同期

### 6-4. 提案書セクションの2系統表示
- Phase 1 で **「documentsテーブル経由」と「Notion bant経由」の2系統** が同時表示される
- ユーザー混乱を避けるため、Notion由来は「Notionの企画書（外部リンク）」と明示し、視覚的に区別

---

## 7. 社長承認が必要な事項（一覧）

| 番号 | 項目 | 推奨 | 選択肢 |
|---|---|---|---|
| **A** | プラン体系のモデリング | **A-3**（planNames String[] 配列化） | A-1 / A-2 / A-3 / A-4 |
| **B** | 13選択肢の管理方式 | **B-1**（既存ProductPlanテーブル流用） | B-1 / B-2 / B-3 |
| **C** | 金額据え置きの解釈 | **C-1+C-2**（既存amount不変＋新タグはbasePrice無し） | C-1 / C-2 / C-3 / C-4 |
| **D** | 複数選択UI | **D-3**（コンボボックス＋ピル） | D-1 / D-2 / D-3 |
| **E** | URL添付実装方針 | **E-2**（sourceTypeカラム追加） | E-1 / E-2 / E-3 |
| **F** | Notion同期タイミング | **Phase 1=F-4（表示のみ）→ Phase 2=F-1（手動ボタン）** | F-1 / F-2 / F-3 / F-4 |

### 最重要3件（特に確認していただきたい）
1. **論点A**: 「複数選択」の実現方式が後の全UIを決める
2. **論点C**: 「金額据え置き」の解釈次第で13タグ×basePriceのヒアリングが必要かどうかが変わる
3. **論点F**: Phase 1で済ませるか、Notion同期ボタンまで一気にやるか

---

## 8. 次のステップ

社長承認をいただいたら、以下の順で実装に着手します:

1. スキーマ拡張 + seed-eizo-plan-tags.ts（dry-run → apply）
2. migrate-plan-names-to-array.ts（dry-run → 結果を社長確認 → apply）
3. UI/API 改修 → typecheck/build → http://localhost:3003 で動作確認
4. 完了報告（変更ファイル一覧 / 動作確認手順 / Phase 2 への引き継ぎ事項）

実装中に追加判断が必要になった場合は、停止して都度ご相談します。
