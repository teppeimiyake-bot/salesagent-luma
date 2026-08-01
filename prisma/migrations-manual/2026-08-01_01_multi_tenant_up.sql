-- ============================================================
-- Phase 1: マルチテナント基盤（Luma / リージー 統合）
-- ============================================================
-- 目的:
--   1テナント（Luma）だけが存在する状態を作る。既存データは全て Luma に属し、
--   アプリの挙動は一切変わらない（Phase 2 で Prisma Extension を入れて初めてスコープが効く）。
--
-- 実行方法:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 2026-08-01_01_multi_tenant_up.sql
--   ※ 本プロジェクトは prisma migrate を使っていないため手書き台本で管理する。
--     この台本を流したあと `prisma db push` を実行してはいけない（差分を巻き戻す恐れがある）。
--
-- 想定所要: 数秒（最大テーブルでも contacts 4,892 行 / deals 1,689 行）
-- ロールバック: 2026-08-01_01_multi_tenant_down.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. tenants
-- ------------------------------------------------------------
-- UUID は移行スクリプトから参照するため固定値にする（gen_random_uuid を使わない）
CREATE TABLE IF NOT EXISTS tenants (
  id                       text PRIMARY KEY,
  code                     text NOT NULL,
  name                     text NOT NULL,
  short_name               text NOT NULL,
  fiscal_year_start_month  integer NOT NULL DEFAULT 1,
  theme_color              text,
  logo_url                 text,
  active                   boolean NOT NULL DEFAULT true,
  sort_order               integer NOT NULL DEFAULT 0,
  created_at               timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_code_key ON tenants(code);

INSERT INTO tenants (id, code, name, short_name, fiscal_year_start_month, theme_color, sort_order) VALUES
  -- theme_color は src/components/layout/sidebar.tsx / tenant-tabs.tsx の配色と対応させる
  -- （Luma = orange-500 / リージー = emerald-700）
  ('11111111-1111-4111-8111-111111111111', 'luma',   '株式会社Luma',     'Luma',   6, '#F97316', 1),
  ('22222222-2222-4222-8222-222222222222', 'reagey', '株式会社リージー', 'リージー', 1, '#047857', 2)
ON CONFLICT (id) DO NOTHING;
-- fiscal_year_start_month: Luma=6（5月決算） / リージー=1（12月決算）

-- ------------------------------------------------------------
-- 2. user_tenants（既存ユーザーは全員 Luma 所属として登録）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_tenants (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  permission        text NOT NULL DEFAULT 'user',
  role              text DEFAULT 'sales',
  is_default        boolean NOT NULL DEFAULT false,
  cross_tenant_read boolean NOT NULL DEFAULT false,
  created_at        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS user_tenants_user_id_tenant_id_key ON user_tenants(user_id, tenant_id);
CREATE INDEX IF NOT EXISTS user_tenants_tenant_id_idx ON user_tenants(tenant_id);

-- 既存の users.permission / users.role をそのまま Luma テナントの権限として引き継ぐ。
-- admin は全社統合ビュー（cross_tenant_read）も許可する。
INSERT INTO user_tenants (id, user_id, tenant_id, permission, role, is_default, cross_tenant_read)
SELECT gen_random_uuid()::text,
       u.id,
       '11111111-1111-4111-8111-111111111111',
       COALESCE(u.permission, 'user'),
       u.role,
       true,
       COALESCE(u.permission, 'user') = 'admin'
FROM users u
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- ------------------------------------------------------------
-- 3. テナント所有テーブル（31件）へ tenant_id を追加
--    NULL 許容で追加 → Luma で埋める → NOT NULL 化 → FK / index
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
  -- 複合 UNIQUE の先頭列が tenant_id になるテーブルは、単独 index を作らない（下の 4. で作成）
  tables_needing_index text[] := ARRAY[
    'product_plans','agent_runs','agent_evidence','agent_generated_messages','deals',
    'deal_products','meetings','tasks','documents','quotes','quote_lines','chat_messages',
    'roleplay_sessions','ai_logs','invites','goals','recurring_billing_periods',
    'production_projects','sns_accounts','ms_workers','ms_weekly_entries'
  ];
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
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id text', t);
    EXECUTE format('UPDATE %I SET tenant_id = %L WHERE tenant_id IS NULL', t, '11111111-1111-4111-8111-111111111111');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    -- 既定値は空文字。Prisma の型上で tenant_id を省略可能にするための仕掛けで、
    -- 実際に省略された INSERT は下の FK 制約で必ず失敗する（Extension を通らない
    -- 経路が別テナントのデータを作ってしまう事故を、静かに通さず落とす）。
    -- ADD COLUMN 時ではなくここで付けるので、既存行が '' で埋まることはない。
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %L', t, '');
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I, ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT',
      t, t || '_tenant_id_fkey', t || '_tenant_id_fkey');
    IF t = ANY(tables_needing_index) THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id)', t || '_tenant_id_idx', t);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. UNIQUE 制約をテナントスコープへ張り替え
--    「Luma の商材『映像』」と「リージーの商材『映像』」が共存できるようにする
-- ------------------------------------------------------------
DROP INDEX IF EXISTS products_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_id_name_key ON products(tenant_id, name);

DROP INDEX IF EXISTS agent_candidates_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS agent_candidates_tenant_id_source_key_key ON agent_candidates(tenant_id, source_key);

DROP INDEX IF EXISTS pipeline_stages_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_tenant_id_value_key ON pipeline_stages(tenant_id, value);

DROP INDEX IF EXISTS plan_proposals_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS plan_proposals_tenant_id_name_key ON plan_proposals(tenant_id, name);

DROP INDEX IF EXISTS lead_sources_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_tenant_id_name_key ON lead_sources(tenant_id, name);

DROP INDEX IF EXISTS industries_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS industries_tenant_id_name_key ON industries(tenant_id, name);

DROP INDEX IF EXISTS invoice_records_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_records_tenant_id_source_key_key ON invoice_records(tenant_id, source_key);

DROP INDEX IF EXISTS recurring_billings_source_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS recurring_billings_tenant_id_source_key_key ON recurring_billings(tenant_id, source_key);

DROP INDEX IF EXISTS ms_kpi_goals_period_key;
CREATE UNIQUE INDEX IF NOT EXISTS ms_kpi_goals_tenant_id_period_key ON ms_kpi_goals(tenant_id, period);

DROP INDEX IF EXISTS pm_staff_role_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS pm_staff_tenant_id_role_name_key ON pm_staff(tenant_id, role, name);

-- ------------------------------------------------------------
-- 5. companies（共有マスタ）に起票テナントを記録
--    Company / Contact はテナント所有ではなく Luma・リージー共有。
--    リージー顧客47社中24社が Luma にも存在し、リージーのリードソースに
--    「Luma顧客企業」が実在する（相互送客が実務化）ため分離複製しない。
-- ------------------------------------------------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_by_tenant_id text;
UPDATE companies SET created_by_tenant_id = '11111111-1111-4111-8111-111111111111' WHERE created_by_tenant_id IS NULL;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_created_by_tenant_id_fkey;
ALTER TABLE companies ADD CONSTRAINT companies_created_by_tenant_id_fkey
  FOREIGN KEY (created_by_tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS companies_created_by_tenant_id_idx ON companies(created_by_tenant_id);

COMMIT;

-- ------------------------------------------------------------
-- 検証（COMMIT 後に手で実行して確認する）
-- ------------------------------------------------------------
-- 1) tenant_id が NULL の行が無いこと（全テーブル 0 件であること）
--    SELECT 'deals' t, count(*) FROM deals WHERE tenant_id IS NULL
--    UNION ALL SELECT 'deal_products', count(*) FROM deal_products WHERE tenant_id IS NULL
--    ... （31テーブル分。verify.sql に同等のクエリあり）
--
-- 2) 全行が Luma に属すること
--    SELECT tenant_id, count(*) FROM deals GROUP BY 1;
--
-- 3) ユーザー14名が Luma テナントに紐付いたこと
--    SELECT t.code, count(*) FROM user_tenants ut JOIN tenants t ON t.id = ut.tenant_id GROUP BY 1;
