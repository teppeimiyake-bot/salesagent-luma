-- ============================================================
-- Phase 1 ロールバック（マルチテナント基盤の撤去）
-- ============================================================
-- 前提: リージーのデータ移管（Phase 5）を実行する前にのみ使用できる。
--       移管後は tenant_id を落とすと Luma とリージーのデータが混ざるため、
--       この台本は使わず DB スナップショットから復元すること。
--
-- 安全弁: Luma 以外のテナントに属する行が1件でもあれば異常終了する。
-- ============================================================

BEGIN;

DO $$
DECLARE
  n bigint;
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
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id <> %L', t, '11111111-1111-4111-8111-111111111111') INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ロールバック中止: % に Luma 以外のテナントの行が % 件ある。移管済みデータが消えるため実行できない。', t, n;
    END IF;
  END LOOP;
END $$;

-- UNIQUE をテナント統合前の形へ戻す
DROP INDEX IF EXISTS products_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_name_key ON products(name);
DROP INDEX IF EXISTS agent_candidates_tenant_id_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS agent_candidates_source_key_key ON agent_candidates(source_key);
DROP INDEX IF EXISTS pipeline_stages_tenant_id_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_value_key ON pipeline_stages(value);
DROP INDEX IF EXISTS plan_proposals_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS plan_proposals_name_key ON plan_proposals(name);
DROP INDEX IF EXISTS lead_sources_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_name_key ON lead_sources(name);
DROP INDEX IF EXISTS industries_tenant_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS industries_name_key ON industries(name);
DROP INDEX IF EXISTS invoice_records_tenant_id_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_records_source_key_key ON invoice_records(source_key);
DROP INDEX IF EXISTS recurring_billings_tenant_id_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS recurring_billings_source_key_key ON recurring_billings(source_key);
DROP INDEX IF EXISTS ms_kpi_goals_tenant_id_period_key;
CREATE UNIQUE INDEX IF NOT EXISTS ms_kpi_goals_period_key ON ms_kpi_goals(period);
DROP INDEX IF EXISTS pm_staff_tenant_id_role_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS pm_staff_role_name_key ON pm_staff(role, name);

-- tenant_id 列を撤去
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
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_tenant_id_fkey');
    EXECUTE format('DROP INDEX IF EXISTS %I', t || '_tenant_id_idx');
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS tenant_id', t);
  END LOOP;
END $$;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_created_by_tenant_id_fkey;
DROP INDEX IF EXISTS companies_created_by_tenant_id_idx;
ALTER TABLE companies DROP COLUMN IF EXISTS created_by_tenant_id;

DROP TABLE IF EXISTS user_tenants;
DROP TABLE IF EXISTS tenants;

COMMIT;
