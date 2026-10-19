-- Development only. Add the T17 tables without changing existing records.
CREATE TABLE IF NOT EXISTS public.quote_templates (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
 product_id TEXT, plan_name TEXT, active BOOLEAN NOT NULL DEFAULT true,
 sort_order INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS quote_templates_tenant_id_name_key ON public.quote_templates(tenant_id, name);
CREATE INDEX IF NOT EXISTS quote_templates_tenant_id_active_sort_order_idx ON public.quote_templates(tenant_id, active, sort_order);
CREATE TABLE IF NOT EXISTS public.quote_template_lines (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '', template_id TEXT NOT NULL,
 name TEXT NOT NULL, detail TEXT, qty INTEGER NOT NULL DEFAULT 1,
 unit TEXT NOT NULL DEFAULT '式', unit_price INTEGER NOT NULL DEFAULT 0,
 tax_category TEXT NOT NULL DEFAULT 'taxable', tax_rate INTEGER NOT NULL DEFAULT 10,
 sort_order INTEGER NOT NULL DEFAULT 0,
 CONSTRAINT quote_template_lines_template_id_fkey FOREIGN KEY(template_id) REFERENCES public.quote_templates(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS quote_template_lines_template_id_sort_order_idx ON public.quote_template_lines(template_id, sort_order);
CREATE INDEX IF NOT EXISTS quote_template_lines_tenant_id_idx ON public.quote_template_lines(tenant_id);
