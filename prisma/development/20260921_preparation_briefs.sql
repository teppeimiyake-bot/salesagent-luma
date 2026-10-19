-- 確認済みの開発用 Neon に不足していた事前準備の保存先を追加する。
-- 既存データ・テーブルの変更や削除は行わない。呼び出し元でトランザクションを使用。
CREATE TABLE IF NOT EXISTS public.preparation_briefs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  deal_id TEXT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  industry_summary TEXT,
  hiring_insights JSONB,
  pain_hypotheses JSONB,
  proposal_story TEXT,
  talking_points JSONB,
  sources JSONB,
  model TEXT,
  created_by_id TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS preparation_briefs_deal_id_idx ON public.preparation_briefs(deal_id);
CREATE INDEX IF NOT EXISTS preparation_briefs_tenant_id_idx ON public.preparation_briefs(tenant_id);
