ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "minutes_json" JSONB;
