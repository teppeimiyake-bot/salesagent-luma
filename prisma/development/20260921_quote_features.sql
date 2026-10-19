-- 開発用 Neon の不足項目だけ追加。既存列・既存行は変更しない。
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_number TEXT,
  ADD COLUMN IF NOT EXISTS issuer_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS template_version TEXT,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS supersedes_quote_id TEXT REFERENCES public.quotes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS subtotal INTEGER,
  ADD COLUMN IF NOT EXISTS tax_total INTEGER,
  ADD COLUMN IF NOT EXISTS grand_total INTEGER;
ALTER TABLE public.quote_lines
  ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT '式',
  ADD COLUMN IF NOT EXISTS tax_category TEXT NOT NULL DEFAULT 'taxable',
  ADD COLUMN IF NOT EXISTS tax_rate INTEGER NOT NULL DEFAULT 10;
CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_id_quote_number_key ON public.quotes(tenant_id, quote_number);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_tenant_id_idempotency_key_key ON public.quotes(tenant_id, idempotency_key);
CREATE TABLE IF NOT EXISTS public.quote_issuer_profiles (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL UNIQUE REFERENCES public.tenants(id),
  legal_name TEXT NOT NULL, postal_code TEXT NOT NULL DEFAULT '170-0013',
  address_line1 TEXT NOT NULL, address_line2 TEXT NOT NULL, logo_url TEXT,
  default_notes TEXT NOT NULL, travel_expense_note TEXT, number_prefix TEXT NOT NULL DEFAULT 'L',
  next_quote_number INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL
);
