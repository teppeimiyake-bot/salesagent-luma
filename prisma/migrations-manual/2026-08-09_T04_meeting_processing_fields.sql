ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "processing_status" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS "processing_error" TEXT,
  ADD COLUMN IF NOT EXISTS "duration_sec" INTEGER,
  ADD COLUMN IF NOT EXISTS "audio_size_bytes" INTEGER,
  ADD COLUMN IF NOT EXISTS "processing_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processing_completed_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "meetings_processing_status_idx"
  ON "meetings" ("processing_status");
