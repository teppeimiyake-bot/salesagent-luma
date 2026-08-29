-- ============================================================
-- 京プロ 撮影会人材派遣 Phase 1 のロールバック
-- ============================================================
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations-manual/2026-08-29_01_kyopro_down.sql
--
-- 京プロ機能で入力したデータ（撮影会・アサイン・マスタ・請求／支払）は全て消える。
-- 既存の商談・企業・入金などのテーブルには一切触れない。
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS "kyopro_payouts";
DROP TABLE IF EXISTS "kyopro_billing_periods";
DROP TABLE IF EXISTS "kyopro_assignments";
DROP TABLE IF EXISTS "kyopro_shoots";
DROP TABLE IF EXISTS "kyopro_settings";
DROP TABLE IF EXISTS "kyopro_rates";
DROP TABLE IF EXISTS "kyopro_staff";
DROP TABLE IF EXISTS "kyopro_clients";
DROP TABLE IF EXISTS "kyopro_venues";

DROP TYPE IF EXISTS "KyoproPayoutStatus";
DROP TYPE IF EXISTS "KyoproBillStatus";
DROP TYPE IF EXISTS "KyoproAssignStatus";
DROP TYPE IF EXISTS "KyoproShootStatus";
DROP TYPE IF EXISTS "KyoproShootKind";
DROP TYPE IF EXISTS "KyoproRole";

COMMIT;
