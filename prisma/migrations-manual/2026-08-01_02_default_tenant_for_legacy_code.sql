-- ============================================================
-- 【緊急・一時措置】tenant_id の既定値を Luma にする
-- ============================================================
-- 経緯:
--   01 の台本は tenant_id の既定値を '' にしている。これは「Prisma Extension を
--   通らない経路の INSERT を FK 違反で確実に落とす」ための意図的な設計
--   （src/lib/db.ts / schema.prisma のコメント参照）。
--
--   ところが 01 を本番DBに適用した時点では、本番で動いているアプリはまだ
--   tenant_id を知らない旧コードである。旧コードの INSERT は tenant_id を
--   送らないため既定値 '' が入り、tenants への FK 違反で **すべて失敗する**。
--   （商談・議事録・タスク・書類などの新規登録が一切できなくなる）
--
--   そこで、新コードをデプロイし終えるまでの間だけ既定値を Luma にしておく。
--   旧コードの INSERT は Luma のデータとして正しく作られる。
--
-- デプロイ完了後は 03 の台本で既定値を '' に戻し、fail-closed を回復すること。
--
-- 実行: node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_02_default_tenant_for_legacy_code.sql
-- ============================================================

BEGIN;

DO $$
DECLARE
  t text;
  all_tables text[] := ARRAY[
    'products','product_plans','agent_runs','agent_candidates','agent_evidence',
    'agent_generated_messages','deals','pipeline_stages','plan_proposals','lead_sources',
    'industries','deal_products','meetings','tasks','documents','quotes','quote_lines',
    'chat_messages','roleplay_sessions','ai_logs','invites','goals','invoice_records',
    'recurring_billings','recurring_billing_periods','production_projects','sns_accounts',
    'ms_workers','ms_weekly_entries','ms_kpi_goals','pm_staff'
  ];
BEGIN
  FOREACH t IN ARRAY all_tables LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %L',
                   t, '11111111-1111-4111-8111-111111111111');
  END LOOP;
END $$;

COMMIT;
