-- ============================================================
-- 入金管理（機能5）＋ PM進捗（機能4）テーブル追加 DDL
--   対象: salesagent_luma（本番=Neon は社長確認後に手動実行）
--   方針: migrations 未使用運用のため、prisma db push 相当を手書きDDLで再現。
--         冪等（IF NOT EXISTS / DO ブロックの enum ガード）にしてあるため再実行可。
--
--   生成元 schema: prisma/schema.prisma の以下モデル
--     - InvoiceRecord            -> invoice_records
--     - RecurringBilling         -> recurring_billings
--     - RecurringBillingPeriod   -> recurring_billing_periods
--     - ProductionProject        -> production_projects
--   ＋ enum 4種
--
--   注意: enum 値は Prisma の enum メンバ名（英大文字）をそのまま使用。
--         アプリ層（lib/payments.ts 等）で日本語ラベルへ変換する。
-- ============================================================

BEGIN;

-- ---------- enums ----------
DO $$ BEGIN
  CREATE TYPE "PaymentTiming" AS ENUM ('PREPAID', 'ON_DELIVERY', 'INSTALLMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContractStatus" AS ENUM ('SIGNED', 'UNSIGNED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "InvoiceSentStatus" AS ENUM ('SENT', 'NOT_SENT', 'PARTIAL_SENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentRecvStatus" AS ENUM ('CONFIRMED', 'UNCONFIRMED', 'PARTIAL_CONFIRMED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ProductionStatus" AS ENUM (
    'BEFORE_SHOOT', 'EDITING', 'REVISING', 'CLIENT_REVIEW',
    'REVISION_WAIT', 'NEAR_DELIVERY', 'DELIVERED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- invoice_records（スポット入金管理） ----------
CREATE TABLE IF NOT EXISTS "invoice_records" (
  "id"                    TEXT PRIMARY KEY,
  "customer_name"         TEXT NOT NULL,
  "company_id"            TEXT,
  "deal_id"               TEXT,
  "deal_product_id"       TEXT,
  "payment_timing"        "PaymentTiming"     NOT NULL DEFAULT 'PREPAID',
  "contract_status"       "ContractStatus"    NOT NULL DEFAULT 'SIGNED',
  "invoice_status"        "InvoiceSentStatus" NOT NULL DEFAULT 'NOT_SENT',
  "payment_status"        "PaymentRecvStatus" NOT NULL DEFAULT 'UNCONFIRMED',
  "delivery_date"         TIMESTAMP(3),
  "expected_payment_date" TIMESTAMP(3),
  "amount_net"            INTEGER,
  "amount_gross"          INTEGER,
  "note"                  TEXT,
  "source_key"            TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "invoice_records"
    ADD CONSTRAINT "invoice_records_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "invoice_records"
    ADD CONSTRAINT "invoice_records_deal_id_fkey"
    FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "invoice_records"
    ADD CONSTRAINT "invoice_records_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "invoice_records_source_key_key" ON "invoice_records"("source_key");
CREATE INDEX IF NOT EXISTS "invoice_records_company_id_idx"   ON "invoice_records"("company_id");
CREATE INDEX IF NOT EXISTS "invoice_records_deal_id_idx"      ON "invoice_records"("deal_id");
CREATE INDEX IF NOT EXISTS "invoice_records_invoice_status_idx" ON "invoice_records"("invoice_status");
CREATE INDEX IF NOT EXISTS "invoice_records_payment_status_idx" ON "invoice_records"("payment_status");

-- ---------- recurring_billings（定期） ----------
CREATE TABLE IF NOT EXISTS "recurring_billings" (
  "id"              TEXT PRIMARY KEY,
  "customer_name"   TEXT NOT NULL,
  "company_id"      TEXT,
  "deal_id"         TEXT,
  "deal_product_id" TEXT,
  "initial_fee"     INTEGER,
  "monthly_fee"     INTEGER,
  "start_date"      TIMESTAMP(3),
  "end_date"        TIMESTAMP(3),
  "note"            TEXT,
  "source_key"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "recurring_billings"
    ADD CONSTRAINT "recurring_billings_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recurring_billings"
    ADD CONSTRAINT "recurring_billings_deal_id_fkey"
    FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "recurring_billings"
    ADD CONSTRAINT "recurring_billings_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "recurring_billings_source_key_key" ON "recurring_billings"("source_key");
CREATE INDEX IF NOT EXISTS "recurring_billings_company_id_idx" ON "recurring_billings"("company_id");
CREATE INDEX IF NOT EXISTS "recurring_billings_deal_id_idx"    ON "recurring_billings"("deal_id");

-- ---------- recurring_billing_periods（月次グリッド） ----------
CREATE TABLE IF NOT EXISTS "recurring_billing_periods" (
  "id"         TEXT PRIMARY KEY,
  "billing_id" TEXT NOT NULL,
  "year_month" INTEGER NOT NULL,
  "sent"       BOOLEAN NOT NULL DEFAULT false,
  "paid"       BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "recurring_billing_periods"
    ADD CONSTRAINT "recurring_billing_periods_billing_id_fkey"
    FOREIGN KEY ("billing_id") REFERENCES "recurring_billings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "recurring_billing_periods_billing_id_year_month_key"
  ON "recurring_billing_periods"("billing_id", "year_month");
CREATE INDEX IF NOT EXISTS "recurring_billing_periods_billing_id_idx" ON "recurring_billing_periods"("billing_id");
CREATE INDEX IF NOT EXISTS "recurring_billing_periods_year_month_idx" ON "recurring_billing_periods"("year_month");

-- ---------- production_projects（PM進捗・機能4） ----------
CREATE TABLE IF NOT EXISTS "production_projects" (
  "id"                        TEXT PRIMARY KEY,
  "deal_id"                   TEXT NOT NULL,
  "deal_product_id"           TEXT,
  "category"                  TEXT,
  "project_name"              TEXT NOT NULL,
  "status"                    "ProductionStatus" NOT NULL DEFAULT 'BEFORE_SHOOT',
  "pm_name"                   TEXT,
  "director_name"             TEXT,
  "camera_name"               TEXT,
  "editor_name"               TEXT,
  "shoot_date"                TIMESTAMP(3),
  "delivery_date"             TIMESTAMP(3),
  "provisional_delivery_date" TIMESTAMP(3),
  "delivered"                 BOOLEAN NOT NULL DEFAULT false,
  "note"                      TEXT,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "production_projects"
    ADD CONSTRAINT "production_projects_deal_id_fkey"
    FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "production_projects"
    ADD CONSTRAINT "production_projects_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "production_projects_deal_product_id_key" ON "production_projects"("deal_product_id");
CREATE INDEX IF NOT EXISTS "production_projects_deal_id_idx"  ON "production_projects"("deal_id");
CREATE INDEX IF NOT EXISTS "production_projects_category_idx" ON "production_projects"("category");
CREATE INDEX IF NOT EXISTS "production_projects_status_idx"   ON "production_projects"("status");

COMMIT;
