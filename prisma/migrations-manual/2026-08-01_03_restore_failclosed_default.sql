-- ============================================================
-- 【デプロイ完了後に実行】tenant_id の既定値を '' に戻す
-- ============================================================
-- 02 は「旧コードが動いている間だけ」の一時措置だった。
-- 新コード（Prisma Extension が必ず tenant_id を注入する版）をデプロイし終えたら、
-- 既定値を '' に戻して fail-closed を回復する。
--
-- 既定値が Luma のままだと、Extension を通らない経路（生SQL・バッチ・外部連携）が
-- 静かに Luma のデータを作ってしまい、リージーのデータ移管後に取り違えが起きても
-- 気付けない。'' に戻せば FK 違反で必ず落ちるので、そこで異常に気付ける。
--
-- 実行タイミング:
--   Vercel の本番デプロイが完了し、画面が正常に動くことを確認したあと。
--   （デプロイ前に実行すると、旧コードの新規登録がすべて失敗する）
--
-- 実行: node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-08-01_03_restore_failclosed_default.sql
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
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %L', t, '');
  END LOOP;
END $$;

COMMIT;
