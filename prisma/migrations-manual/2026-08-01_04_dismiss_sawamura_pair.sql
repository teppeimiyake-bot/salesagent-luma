-- ============================================================
-- 「澤村株式会社」と「株式会社澤村」を別会社として記録する
-- ============================================================
-- 社長確認（2026-08-01）: この2社は名前が似ているだけの別会社。統合してはいけない。
--
--   株式会社澤村（40939004…）  商談1 / 受注0 / 連絡先2 / 書類5 / HPなし
--   澤村株式会社（ca7c51c6…）  商談1 / 受注1 / 連絡先2 / 入金1 / sawamura-net.co.jp
--
-- company_merge_dismissed に登録しておくと、企業統合画面の重複候補に
-- 二度と出てこなくなる（誤って統合される事故を防ぐ）。
-- 一意制約の都合で company_id_a < company_id_b の順に入れる。
--
-- 実行: node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_04_dismiss_sawamura_pair.sql
-- ============================================================

BEGIN;

INSERT INTO company_merge_dismissed (id, company_id_a, company_id_b, dismissed_by_id, created_at)
SELECT
  gen_random_uuid()::text,
  LEAST(a.id, b.id),
  GREATEST(a.id, b.id),
  (SELECT id FROM users WHERE email = 'teppei.miyake@luma-create.com'),
  now()
FROM companies a, companies b
WHERE a.name = '株式会社澤村'
  AND b.name = '澤村株式会社'
  AND a.deleted_at IS NULL
  AND b.deleted_at IS NULL
  AND a.merged_into_id IS NULL
  AND b.merged_into_id IS NULL
ON CONFLICT (company_id_a, company_id_b) DO NOTHING;

COMMIT;

-- 確認:
--   SELECT ca.name, cb.name FROM company_merge_dismissed d
--   JOIN companies ca ON ca.id = d.company_id_a
--   JOIN companies cb ON cb.id = d.company_id_b;
