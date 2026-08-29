-- ============================================================
-- 京プロ 研修中/規定レート化のロールバック
-- ============================================================
--   npx tsx --env-file=.env.production.local scripts/apply-kyopro-migration.ts --file 02 --down --apply
--
-- 研修区分（誰がどの稼働で研修中だったか）は失われる。金額は元の下限・上限運用に戻す。
-- ============================================================

BEGIN;

ALTER TABLE "kyopro_rates" ADD COLUMN IF NOT EXISTS "pay_rate_min" INTEGER;
ALTER TABLE "kyopro_rates" ADD COLUMN IF NOT EXISTS "pay_rate_max" INTEGER;
ALTER TABLE "kyopro_rates" DROP COLUMN IF EXISTS "pay_rate_trainee";

UPDATE "kyopro_rates"
   SET "pay_rate_default" = 18000, "pay_rate_min" = 15000, "pay_rate_max" = 20000
 WHERE "role" = 'MC';

ALTER TABLE "kyopro_staff" DROP COLUMN IF EXISTS "trainee";
ALTER TABLE "kyopro_assignments" DROP COLUMN IF EXISTS "trainee";

COMMIT;
