BEGIN;

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS quote_number text,
  ADD COLUMN IF NOT EXISTS issuer_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS template_version text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_quote_id text REFERENCES quotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS subtotal integer,
  ADD COLUMN IF NOT EXISTS tax_total integer,
  ADD COLUMN IF NOT EXISTS grand_total integer;

CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_id_quote_number_key
  ON quotes(tenant_id, quote_number);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_id_idempotency_key_key
  ON quotes(tenant_id, idempotency_key);

ALTER TABLE quote_lines
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT '式',
  ADD COLUMN IF NOT EXISTS tax_category text NOT NULL DEFAULT 'taxable',
  ADD COLUMN IF NOT EXISTS tax_rate integer NOT NULL DEFAULT 10;

UPDATE quote_lines ql
SET unit = '式', tax_category = 'taxable', tax_rate = q.tax_rate
FROM quotes q
WHERE ql.quote_id = q.id;

CREATE TABLE IF NOT EXISTS quote_issuer_profiles (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  legal_name text NOT NULL,
  postal_code text NOT NULL DEFAULT '170-0013',
  address_line1 text NOT NULL,
  address_line2 text NOT NULL,
  logo_url text,
  default_notes text NOT NULL,
  travel_expense_note text,
  number_prefix text NOT NULL DEFAULT 'L',
  next_quote_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_templates (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  product_id text,
  plan_name text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS quote_templates_tenant_active_sort_idx
  ON quote_templates(tenant_id, active, sort_order);

CREATE TABLE IF NOT EXISTS quote_template_lines (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id text NOT NULL REFERENCES quote_templates(id) ON DELETE CASCADE,
  name text NOT NULL,
  detail text,
  qty integer NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT '式',
  unit_price integer NOT NULL DEFAULT 0,
  tax_category text NOT NULL DEFAULT 'taxable',
  tax_rate integer NOT NULL DEFAULT 10,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS quote_template_lines_template_sort_idx
  ON quote_template_lines(template_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_template_lines_tenant_idx
  ON quote_template_lines(tenant_id);

INSERT INTO quote_issuer_profiles (
  tenant_id, legal_name, postal_code, address_line1, address_line2,
  default_notes, travel_expense_note, number_prefix
)
SELECT id, name, '170-0013', '東京都豊島区東池袋', '2-7-3 柄澤ビル3F',
       E'本見積書の有効期限は発行日より30日間です。\n業務内容の変更がある場合は別途お見積りいたします。',
       '撮影場所までの交通費は実費にて別途ご請求いたします。',
       CASE WHEN code = 'luma' THEN 'L' ELSE upper(left(code, 1)) END
FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- D-04/D-05確定前でも画面入力を始められるゼロ円の初期テンプレート。
-- 金額・税区分は発行前に担当者が確認し、管理者設定で後から差し替える。
INSERT INTO quote_templates (tenant_id, name, plan_name, sort_order)
SELECT tenant.id, template.name, template.plan_name, template.sort_order
FROM tenants tenant
CROSS JOIN (VALUES
  ('映像制作 Aプラン', 'Aプラン', 10),
  ('映像制作 Cプラン', 'Cプラン', 20),
  ('SNS ライトプラン', 'ライトプラン', 30)
) AS template(name, plan_name, sort_order)
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO quote_template_lines (
  tenant_id, template_id, name, detail, qty, unit, unit_price, tax_category, tax_rate, sort_order
)
SELECT qt.tenant_id, qt.id, line.name, line.detail, 1, line.unit, 0, 'taxable', 10, line.sort_order
FROM quote_templates qt
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('企画・構成', NULL::text, '式', 10),
    ('撮影', NULL::text, '日', 20),
    ('編集・納品', NULL::text, '式', 30)
  ) AS video(name, detail, unit, sort_order)
  WHERE qt.name LIKE '映像制作%'
  UNION ALL
  SELECT 'SNS運用', '投稿企画・制作・運用', '月', 10
  WHERE qt.name = 'SNS ライトプラン'
) line
WHERE NOT EXISTS (SELECT 1 FROM quote_template_lines existing WHERE existing.template_id = qt.id);

COMMIT;
