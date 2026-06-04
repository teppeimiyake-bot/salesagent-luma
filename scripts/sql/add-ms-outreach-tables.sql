-- ============================================================
-- MS送付状況（/ms-outreach）テーブル追加 DDL
--   対象: salesagent_luma（本番=Neon は社長確認後に手動実行）
--   方針: migrations 未使用運用のため、prisma db push 相当を手書きDDLで再現。
--         冪等（IF NOT EXISTS / duplicate_object ガード）にしてあるため再実行可。
--         additive のみ。既存テーブル・データには一切触れない。
--
--   生成元 schema: prisma/schema.prisma の以下 3 モデル
--     - MsWorker      -> ms_workers
--     - MsWeeklyEntry -> ms_weekly_entries
--     - MsKpiGoal     -> ms_kpi_goals
--
--   dev には `prisma db push` 適用済み（ms_weekly_entries=393 件）。
--   本番にはこのSQLを DATABASE_URL_UNPOOLED に対して手動実行する。
-- ============================================================

BEGIN;

-- ---------- ms_workers（送付代行ワーカーのマスタ） ----------
CREATE TABLE IF NOT EXISTS "ms_workers" (
  "id"         TEXT NOT NULL,
  "code"       TEXT,
  "name"       TEXT NOT NULL,
  "is_agency"  BOOLEAN NOT NULL DEFAULT false,
  "active"     BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "notes"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ms_workers_pkey" PRIMARY KEY ("id")
);

-- ---------- ms_weekly_entries（週次実績: worker × year × month × week） ----------
CREATE TABLE IF NOT EXISTS "ms_weekly_entries" (
  "id"             TEXT NOT NULL,
  "worker_id"      TEXT NOT NULL,
  "year"           INTEGER NOT NULL,
  "month"          INTEGER NOT NULL,
  "week_of_month"  INTEGER NOT NULL,
  "sent"           INTEGER NOT NULL DEFAULT 0,
  "appointments"   INTEGER NOT NULL DEFAULT 0,
  "list_orders"    INTEGER NOT NULL DEFAULT 0,
  "inquiry_orders" INTEGER NOT NULL DEFAULT 0,
  "notes"          TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ms_weekly_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ms_weekly_entries_worker_id_year_month_week_of_month_key"
  ON "ms_weekly_entries" ("worker_id", "year", "month", "week_of_month");
CREATE INDEX IF NOT EXISTS "ms_weekly_entries_worker_id_idx"
  ON "ms_weekly_entries" ("worker_id");
CREATE INDEX IF NOT EXISTS "ms_weekly_entries_year_month_idx"
  ON "ms_weekly_entries" ("year", "month");

-- ---------- ms_kpi_goals（会計年度単位のKPI目標） ----------
CREATE TABLE IF NOT EXISTS "ms_kpi_goals" (
  "id"                TEXT NOT NULL,
  "period"            TEXT NOT NULL,
  "target_reply_rate" DOUBLE PRECISION NOT NULL,
  "target_sent"       INTEGER,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ms_kpi_goals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ms_kpi_goals_period_key"
  ON "ms_kpi_goals" ("period");

-- ---------- FK 制約（存在しなければ追加） ----------
DO $$ BEGIN
  ALTER TABLE "ms_weekly_entries"
    ADD CONSTRAINT "ms_weekly_entries_worker_id_fkey"
    FOREIGN KEY ("worker_id") REFERENCES "ms_workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
