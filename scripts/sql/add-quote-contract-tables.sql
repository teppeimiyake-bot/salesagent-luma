-- ============================================================
-- 見積書・契約書 自動生成（機能①②③）テーブル/カラム追加 DDL
--   対象: salesagent_luma（本番=Neon は社長確認後に手動実行）
--   方針: migrations 未使用運用のため、prisma db push 相当を手書きDDLで再現。
--         冪等（IF NOT EXISTS）にしてあるため再実行可。
--
--   生成元 schema: prisma/schema.prisma の以下
--     - Document に status / deal_product_id カラム追加（＋ index）
--     - Quote      -> quotes
--     - QuoteLine  -> quote_lines
--
--   dev には `prisma db push` 適用済み。本番にはこのSQLを手動実行する。
-- ============================================================

BEGIN;

-- ---------- documents: 自動生成物の状態・出所カラム ----------
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "status" TEXT;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deal_product_id" TEXT;
CREATE INDEX IF NOT EXISTS "documents_deal_product_id_idx" ON "documents" ("deal_product_id");

-- ---------- quotes（見積ヘッダ） ----------
CREATE TABLE IF NOT EXISTS "quotes" (
  "id"               TEXT NOT NULL,
  "deal_id"          TEXT NOT NULL,
  "deal_product_id"  TEXT,
  "client_name"      TEXT NOT NULL,
  "client_honorific" TEXT NOT NULL DEFAULT '御中',
  "subject"          TEXT,
  "issue_date"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"             TEXT,
  "tax_rate"         INTEGER NOT NULL DEFAULT 10,
  "status"           TEXT NOT NULL DEFAULT 'draft',
  "version"          TEXT,
  "document_id"      TEXT,
  "created_by_id"    TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "quotes_deal_id_idx" ON "quotes" ("deal_id");
CREATE INDEX IF NOT EXISTS "quotes_deal_product_id_idx" ON "quotes" ("deal_product_id");

-- ---------- quote_lines（見積明細） ----------
CREATE TABLE IF NOT EXISTS "quote_lines" (
  "id"         TEXT NOT NULL,
  "quote_id"   TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "detail"     TEXT,
  "qty"        INTEGER NOT NULL DEFAULT 1,
  "unit_price" INTEGER NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "quote_lines_quote_id_idx" ON "quote_lines" ("quote_id");

-- ---------- FK 制約（存在しなければ追加） ----------
DO $$ BEGIN
  ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_deal_id_fkey"
    FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "quote_lines"
    ADD CONSTRAINT "quote_lines_quote_id_fkey"
    FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
