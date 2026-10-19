BEGIN;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS meeting_owner_type text NOT NULL DEFAULT 'unknown';

-- 既存の Calendar/Meet 発行 API 成功行だけを自社発行として引き継ぐ。
-- Meet URL だけの行は先方発行の可能性があるため推定しない。
UPDATE deals
SET meeting_owner_type = 'own_meet'
WHERE meet_event_id IS NOT NULL
  AND meeting_owner_type = 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'deals_meeting_owner_type_check'
  ) THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_meeting_owner_type_check
      CHECK (meeting_owner_type IN ('own_meet', 'guest_meet', 'zoom', 'in_person', 'unknown'));
  END IF;
END $$;

COMMIT;
