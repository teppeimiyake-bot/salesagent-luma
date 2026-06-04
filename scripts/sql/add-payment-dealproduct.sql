-- ============================================================
-- 入金管理 Phase 9：プロダクト単位化のための deal_product_id 追加 DDL
--   対象: salesagent_luma（本番=Neon は社長＝オーケストレーターが後で手動実行）
--   方針: migrations 未使用運用のため、prisma db push 相当を手書きDDLで再現。
--         冪等（ADD COLUMN IF NOT EXISTS / FK・INDEX ガード）。再実行可。
--
--   注意: add-payment-pm-tables.sql の CREATE TABLE IF NOT EXISTS には
--         既に deal_product_id 列が含まれるが、Phase 8以前に作成済みの
--         本番テーブルには列が無い可能性があるため、ここで明示的に追加する。
--         （CREATE TABLE IF NOT EXISTS は既存テーブルに列を足さないため）
--
--   生成元 schema: prisma/schema.prisma
--     - InvoiceRecord    -> invoice_records.deal_product_id
--     - RecurringBilling -> recurring_billings.deal_product_id
--   FK: -> deal_products(id) ON DELETE SET NULL
--   index: invoice_records_deal_product_id_idx / recurring_billings_deal_product_id_idx
--
--   本番反映後に流すバックフィル:
--     SEED_ALLOW_PROD=1 DATABASE_URL="<prod>" npx tsx scripts/backfill-payment-dealproduct.ts
-- ============================================================

BEGIN;

-- ---------- invoice_records ----------
ALTER TABLE "invoice_records" ADD COLUMN IF NOT EXISTS "deal_product_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "invoice_records"
    ADD CONSTRAINT "invoice_records_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "invoice_records_deal_product_id_idx"
  ON "invoice_records"("deal_product_id");

-- ---------- recurring_billings ----------
ALTER TABLE "recurring_billings" ADD COLUMN IF NOT EXISTS "deal_product_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "recurring_billings"
    ADD CONSTRAINT "recurring_billings_deal_product_id_fkey"
    FOREIGN KEY ("deal_product_id") REFERENCES "deal_products"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "recurring_billings_deal_product_id_idx"
  ON "recurring_billings"("deal_product_id");

COMMIT;
