BEGIN;

CREATE TABLE IF NOT EXISTS preparation_briefs (
  -- deals.id は Prisma String（Postgres text）。uuid 型だと FK が張れない
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id text NOT NULL DEFAULT '',
  deal_id text NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  error text,
  industry_summary text,
  hiring_insights jsonb,
  pain_hypotheses jsonb,
  proposal_story text,
  talking_points jsonb,
  sources jsonb,
  model text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS preparation_briefs_deal_id_idx ON preparation_briefs(deal_id);
CREATE INDEX IF NOT EXISTS preparation_briefs_tenant_id_idx ON preparation_briefs(tenant_id);

COMMIT;
