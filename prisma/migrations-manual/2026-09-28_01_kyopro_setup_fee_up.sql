-- 撮影当日に通常業務と設営を兼務するアサイン向けの加算額。
-- 既存データは一括更新せず、すべて未設定（0円）のまま維持する。
ALTER TABLE "kyopro_assignments"
  ADD COLUMN IF NOT EXISTS "setup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "setup_bill_amount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "setup_pay_amount" INTEGER NOT NULL DEFAULT 0;
