-- T16: Google Meet 自動録画・自動文字起こし（成果物取り込み）用の列。
-- 追加のみ・すべて NULL 許容（既定値つき）なので、既存レコードと既存画面はそのまま動く。
-- FEATURE_MEET_AUTO_RECORD が OFF の間はどの列も書かれない。

BEGIN;

-- 商談側：Meetスペースの解決結果と、設定／成果物取得の進行状態。
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS meet_space_name text,
  ADD COLUMN IF NOT EXISTS meet_artifact_config_status text,
  ADD COLUMN IF NOT EXISTS meet_artifact_config_error text,
  ADD COLUMN IF NOT EXISTS meet_artifact_configured_at timestamp(3),
  ADD COLUMN IF NOT EXISTS meet_artifact_status text,
  ADD COLUMN IF NOT EXISTS meet_artifact_error text,
  ADD COLUMN IF NOT EXISTS meet_artifact_checked_at timestamp(3),
  ADD COLUMN IF NOT EXISTS meet_artifact_attempts integer NOT NULL DEFAULT 0;

-- cron が「成果物待ち／取得中」の商談だけを拾えるようにする。
CREATE INDEX IF NOT EXISTS deals_meet_artifact_status_idx
  ON deals (meet_artifact_status);

-- 商談履歴側：どの会議記録から作られたか、話者つき発言配列。
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS meet_conference_record_id text,
  ADD COLUMN IF NOT EXISTS meet_transcript_name text,
  ADD COLUMN IF NOT EXISTS meet_transcript_doc_url text,
  ADD COLUMN IF NOT EXISTS transcript_segments jsonb;

-- 二重取り込み防止の本体：同一テナント内で同じ会議記録から2件目を作らせない。
-- 既存行（NULL）は対象外にしたいので部分ユニークインデックスにする。
CREATE UNIQUE INDEX IF NOT EXISTS meetings_tenant_id_meet_conference_record_id_key
  ON meetings (tenant_id, meet_conference_record_id)
  WHERE meet_conference_record_id IS NOT NULL;

COMMIT;
