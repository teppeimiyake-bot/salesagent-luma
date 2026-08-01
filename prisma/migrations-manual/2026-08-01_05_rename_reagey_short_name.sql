-- ============================================================
-- リージーの画面表示名を「Re;Easy」にする
-- ============================================================
-- 社長指示（2026-08-01）: 画面上のブランド表記は Reagey ではなく Re;Easy。
--
-- 変えるのは short_name（会社タブ・KPIタブ・見出しに出る表示名）だけ。
-- name（株式会社リージー）は法人の正式名称なので変更しない。
--
-- 実行: node scripts/run-sql.cjs <envファイル> prisma/migrations-manual/2026-08-01_05_rename_reagey_short_name.sql
-- ============================================================

BEGIN;

UPDATE tenants SET short_name = 'Re;Easy' WHERE code = 'reagey';

COMMIT;

-- 確認:
--   SELECT code, name, short_name FROM tenants ORDER BY sort_order;
