-- 開発専用Neonの商談・商談履歴を、開発main@fb863c4のPrisma定義へ揃える。
-- 既存列の変更・削除、既存レコードのUPDATE/DELETEは行わない。
-- 呼び出し元がトランザクションとlock_timeoutを設定して実行する。
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS meeting_start_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS meeting_end_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS meet_url TEXT,
  ADD COLUMN IF NOT EXISTS meet_event_id TEXT,
  ADD COLUMN IF NOT EXISTS meeting_owner_type TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS meet_space_name TEXT,
  ADD COLUMN IF NOT EXISTS meet_artifact_config_status TEXT,
  ADD COLUMN IF NOT EXISTS meet_artifact_config_error TEXT,
  ADD COLUMN IF NOT EXISTS meet_artifact_configured_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS meet_artifact_status TEXT,
  ADD COLUMN IF NOT EXISTS meet_artifact_error TEXT,
  ADD COLUMN IF NOT EXISTS meet_artifact_checked_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS meet_artifact_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.meetings
  ADD COLUMN IF NOT EXISTS minutes_json JSONB,
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS duration_sec INTEGER,
  ADD COLUMN IF NOT EXISTS audio_size_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS processing_completed_at TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS meet_conference_record_id TEXT,
  ADD COLUMN IF NOT EXISTS meet_transcript_name TEXT,
  ADD COLUMN IF NOT EXISTS meet_transcript_doc_url TEXT,
  ADD COLUMN IF NOT EXISTS transcript_segments JSONB;

CREATE INDEX IF NOT EXISTS deals_meeting_start_at_idx ON public.deals(meeting_start_at);
CREATE INDEX IF NOT EXISTS deals_meet_artifact_status_idx ON public.deals(meet_artifact_status);
CREATE INDEX IF NOT EXISTS meetings_processing_status_idx ON public.meetings(processing_status);
CREATE UNIQUE INDEX IF NOT EXISTS meetings_tenant_id_meet_conference_record_id_key
  ON public.meetings(tenant_id, meet_conference_record_id);
