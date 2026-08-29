-- ============================================================
-- 京プロ 撮影会人材派遣（リージー専用）Phase 1: テーブル追加
-- ============================================================
-- 目的:
--   撮影会（日付×クライアント×会場）・アサイン・マスタ・月次請求／支払の器を作る。
--   既存テーブルには一切触らない（追加のみ）。
--
-- 実行方法:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations-manual/2026-08-29_01_kyopro_up.sql
--
--   ※ 本番に対して `prisma db push` を実行してはいけない。
--     本番には Prisma がモデル化していない tenant_id の FK が 34 本あり、
--     db push はそれを DROP してしまう（fail-closed の要が外れる）。
--     さらに production_projects.provisional_delivery_date のドリフトも巻き込む。
--     スキーマ追加はこの手書き台本で行う。
--
-- ロールバック: 2026-08-29_01_kyopro_down.sql
-- 投入後: npx tsx --env-file=.env.production.local scripts/import-kyopro.ts --apply
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. ENUM
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproRole') THEN
    CREATE TYPE "KyoproRole" AS ENUM ('CAMERA', 'SELECT', 'MC', 'GUIDE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproShootKind') THEN
    CREATE TYPE "KyoproShootKind" AS ENUM ('SHOOT', 'SETUP');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproShootStatus') THEN
    CREATE TYPE "KyoproShootStatus" AS ENUM ('PLANNED', 'CONFIRMED', 'DONE', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproAssignStatus') THEN
    CREATE TYPE "KyoproAssignStatus" AS ENUM ('TENTATIVE', 'CONFIRMED', 'DONE', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproBillStatus') THEN
    CREATE TYPE "KyoproBillStatus" AS ENUM ('NOT_SENT', 'SENT', 'PAID');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KyoproPayoutStatus') THEN
    CREATE TYPE "KyoproPayoutStatus" AS ENUM ('UNPAID', 'SCHEDULED', 'PAID');
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. テーブル
--    tenant_id の DEFAULT '' は既存モデルと同じ仕掛け。
--    Extension を通らない経路の INSERT を FK 違反で確実に落とす（fail-closed）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "kyopro_clients" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "color_hex" TEXT NOT NULL DEFAULT '#0d6b52',
    "default_venue_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_clients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_venues" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "color_hex" TEXT NOT NULL DEFAULT '#7c3aed',
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_venues_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_staff" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "kana" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "roles" "KyoproRole"[],
    "pay_overrides" JSONB,
    "bank_info" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_staff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_rates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "role" "KyoproRole" NOT NULL,
    "bill_rate" INTEGER NOT NULL,
    "pay_rate_default" INTEGER NOT NULL,
    "pay_rate_min" INTEGER,
    "pay_rate_max" INTEGER,
    "cleanup_bill_amount" INTEGER NOT NULL DEFAULT 3000,
    "cleanup_pay_amount" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_rates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "payout_due_months" INTEGER NOT NULL DEFAULT 2,
    "tax_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_shoots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "kind" "KyoproShootKind" NOT NULL DEFAULT 'SHOOT',
    "client_id" TEXT NOT NULL,
    "venue_id" TEXT,
    "status" "KyoproShootStatus" NOT NULL DEFAULT 'PLANNED',
    "required_counts" JSONB,
    "start_time" TEXT,
    "end_time" TEXT,
    "note" TEXT,
    "source_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_shoots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "shoot_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "role" "KyoproRole" NOT NULL,
    "status" "KyoproAssignStatus" NOT NULL DEFAULT 'CONFIRMED',
    "bill_amount" INTEGER NOT NULL,
    "pay_amount" INTEGER NOT NULL,
    "cleanup" BOOLEAN NOT NULL DEFAULT false,
    "cleanup_bill_amount" INTEGER NOT NULL DEFAULT 0,
    "cleanup_pay_amount" INTEGER NOT NULL DEFAULT 0,
    "adjust_amount" INTEGER NOT NULL DEFAULT 0,
    "adjust_note" TEXT,
    "note" TEXT,
    "source_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_billing_periods" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "year_month" TEXT NOT NULL,
    "bill_status" "KyoproBillStatus" NOT NULL DEFAULT 'NOT_SENT',
    "invoice_date" TIMESTAMP(3),
    "due_date" TIMESTAMP(3),
    "paid_date" TIMESTAMP(3),
    "amount_net" INTEGER,
    "amount_gross" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_billing_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kyopro_payouts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT '',
    "year_month" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "status" "KyoproPayoutStatus" NOT NULL DEFAULT 'UNPAID',
    "paid_date" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "kyopro_payouts_pkey" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------
-- 3. インデックス（Prisma スキーマの @@unique / @@index と対応）
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_clients_tenant_id_name_key" ON "kyopro_clients"("tenant_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_venues_tenant_id_name_key" ON "kyopro_venues"("tenant_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_staff_tenant_id_name_key" ON "kyopro_staff"("tenant_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_rates_tenant_id_role_effective_from_key" ON "kyopro_rates"("tenant_id", "role", "effective_from");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_settings_tenant_id_key" ON "kyopro_settings"("tenant_id");
CREATE INDEX IF NOT EXISTS "kyopro_shoots_tenant_id_date_idx" ON "kyopro_shoots"("tenant_id", "date");
CREATE INDEX IF NOT EXISTS "kyopro_shoots_client_id_idx" ON "kyopro_shoots"("client_id");
CREATE INDEX IF NOT EXISTS "kyopro_shoots_venue_id_idx" ON "kyopro_shoots"("venue_id");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_shoots_tenant_id_source_key_key" ON "kyopro_shoots"("tenant_id", "source_key");
CREATE INDEX IF NOT EXISTS "kyopro_assignments_tenant_id_staff_id_idx" ON "kyopro_assignments"("tenant_id", "staff_id");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_assignments_tenant_id_shoot_id_staff_id_role_key" ON "kyopro_assignments"("tenant_id", "shoot_id", "staff_id", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_billing_periods_tenant_id_year_month_key" ON "kyopro_billing_periods"("tenant_id", "year_month");
CREATE UNIQUE INDEX IF NOT EXISTS "kyopro_payouts_tenant_id_year_month_staff_id_key" ON "kyopro_payouts"("tenant_id", "year_month", "staff_id");

-- ------------------------------------------------------------
-- 4. 外部キー（モデル間）
-- ------------------------------------------------------------
ALTER TABLE "kyopro_clients" DROP CONSTRAINT IF EXISTS "kyopro_clients_default_venue_id_fkey";
ALTER TABLE "kyopro_clients" ADD CONSTRAINT "kyopro_clients_default_venue_id_fkey"
  FOREIGN KEY ("default_venue_id") REFERENCES "kyopro_venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kyopro_shoots" DROP CONSTRAINT IF EXISTS "kyopro_shoots_client_id_fkey";
ALTER TABLE "kyopro_shoots" ADD CONSTRAINT "kyopro_shoots_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "kyopro_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kyopro_shoots" DROP CONSTRAINT IF EXISTS "kyopro_shoots_venue_id_fkey";
ALTER TABLE "kyopro_shoots" ADD CONSTRAINT "kyopro_shoots_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "kyopro_venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "kyopro_assignments" DROP CONSTRAINT IF EXISTS "kyopro_assignments_shoot_id_fkey";
ALTER TABLE "kyopro_assignments" ADD CONSTRAINT "kyopro_assignments_shoot_id_fkey"
  FOREIGN KEY ("shoot_id") REFERENCES "kyopro_shoots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kyopro_assignments" DROP CONSTRAINT IF EXISTS "kyopro_assignments_staff_id_fkey";
ALTER TABLE "kyopro_assignments" ADD CONSTRAINT "kyopro_assignments_staff_id_fkey"
  FOREIGN KEY ("staff_id") REFERENCES "kyopro_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "kyopro_payouts" DROP CONSTRAINT IF EXISTS "kyopro_payouts_staff_id_fkey";
ALTER TABLE "kyopro_payouts" ADD CONSTRAINT "kyopro_payouts_staff_id_fkey"
  FOREIGN KEY ("staff_id") REFERENCES "kyopro_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- 5. tenant_id の外部キー（既存テーブルと同じ規約 = fail-closed）
--    Prisma スキーマにはリレーションを張らず、SQL 側だけで担保する。
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
  kyopro_tables text[] := ARRAY[
    'kyopro_clients', 'kyopro_venues', 'kyopro_staff', 'kyopro_rates', 'kyopro_settings',
    'kyopro_shoots', 'kyopro_assignments', 'kyopro_billing_periods', 'kyopro_payouts'
  ];
BEGIN
  FOREACH t IN ARRAY kyopro_tables LOOP
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I, ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT',
      t, t || '_tenant_id_fkey', t || '_tenant_id_fkey');
  END LOOP;
END $$;

COMMIT;
