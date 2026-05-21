-- ============================================================
-- 本番Neon スキーマ同期（additive only / 冪等）
-- 2026-05-21 商談作成不可（P2022: column does not exist）障害の修正
--
-- 原因：schema.prisma に追加された列/テーブルが本番Neonに db push されておらず、
--       Prisma が SELECT する列が実DBに存在せず全 deal クエリが失敗していた。
--
-- すべて IF NOT EXISTS / nullable or default 付きで、既存データを一切破壊しない。
-- ============================================================

-- 1. deals.meeting_scheduled_at（今回の直接原因。1e9ea2b で追加）
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "meeting_scheduled_at" TIMESTAMP(3);

-- 2. deal_products.plan_proposals（de26802 で追加。念のため冪等保証）
ALTER TABLE "deal_products" ADD COLUMN IF NOT EXISTS "plan_proposals" TEXT[] NOT NULL DEFAULT '{}';

-- 3. documents.source_type（fa5ea85 で追加。念のため冪等保証）
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_type" TEXT NOT NULL DEFAULT 'file';

-- 4. plan_proposals テーブル（de26802 で追加。念のため冪等保証）
CREATE TABLE IF NOT EXISTS "plan_proposals" (
  "id"            TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "color"         TEXT NOT NULL DEFAULT 'default',
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "active"        BOOLEAN NOT NULL DEFAULT true,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plan_proposals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_proposals_name_key" ON "plan_proposals"("name");
CREATE INDEX IF NOT EXISTS "plan_proposals_display_order_idx" ON "plan_proposals"("display_order");

-- 確認
SELECT 'deals.meeting_scheduled_at' AS check, count(*) AS exists
FROM information_schema.columns
WHERE table_name='deals' AND column_name='meeting_scheduled_at';
