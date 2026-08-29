-- ============================================================
-- 京プロ: 発注単価を「研修中 / 規定（＝研修明け）」の2段階にする
-- ============================================================
-- 変更点:
--   1. kyopro_rates: 下限・上限（pay_rate_min / pay_rate_max）を廃止し、
--      研修中の単価（pay_rate_trainee）を持たせる。
--   2. kyopro_staff: 現在研修中かどうか（trainee）。新しいアサインの既定になる。
--   3. kyopro_assignments: その稼働が研修中扱いだったか（trainee）。
--      撮影会ごと・人材ごとに残るので、過去分は当時の区分のまま動かない。
--   4. 司会のレートを 規定 20,000 / 研修中 15,000 に揃える。
--      初期投入時の暫定値（18,000）で入っている司会のアサインは規定額に直す。
--
-- 実行方法:
--   npx tsx --env-file=.env.production.local scripts/apply-kyopro-migration.ts --file 02 --apply
--   もしくは psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations-manual/2026-08-29_02_kyopro_trainee_up.sql
--
-- ロールバック: 2026-08-29_02_kyopro_trainee_down.sql
-- ============================================================

BEGIN;

ALTER TABLE "kyopro_rates" ADD COLUMN IF NOT EXISTS "pay_rate_trainee" INTEGER;
ALTER TABLE "kyopro_rates" DROP COLUMN IF EXISTS "pay_rate_min";
ALTER TABLE "kyopro_rates" DROP COLUMN IF EXISTS "pay_rate_max";

ALTER TABLE "kyopro_staff" ADD COLUMN IF NOT EXISTS "trainee" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "kyopro_assignments" ADD COLUMN IF NOT EXISTS "trainee" BOOLEAN NOT NULL DEFAULT false;

-- 司会だけ研修中の単価がある（案内・カメラ・セレクトは研修中も規定額）
UPDATE "kyopro_rates"
   SET "pay_rate_default" = 20000,
       "pay_rate_trainee" = 15000
 WHERE "role" = 'MC';

-- 初期投入時の暫定値（18,000）のままの司会アサインを規定額へ寄せる。
-- 研修中だった人は画面で「研修中」に切り替えれば 15,000 に引き直される。
UPDATE "kyopro_assignments"
   SET "pay_amount" = 20000
 WHERE "role" = 'MC'
   AND "pay_amount" = 18000;

COMMIT;
