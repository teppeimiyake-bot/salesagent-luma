-- T02: Google Meet URL / Calendar event ID for deals.
-- Nullable additive columns only. Existing records and existing screens keep working.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS meet_url text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS meet_event_id text;
