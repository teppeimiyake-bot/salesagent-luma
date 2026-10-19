-- ============================================================
-- T01 商談日時（開始・終了時刻）を登録できるようにする
-- ============================================================
-- チケット: 00_Docs/03_チケット/T01_商談日時登録.html（LUMA-E1-01）
-- 参照:     実装計画_録音・商談履歴作成.html §4-3
--
-- 追加するもの（Expand-only。既存カラムは一切変更しない）:
--   deals.meeting_start_at  商談の開始日時（timestamptz・NULL可）
--   deals.meeting_end_at    商談の終了日時（timestamptz・NULL可）
--
-- 設計メモ:
--   - 既存の meeting_scheduled_at（商談予定日）は ms管理タブが date-only で
--     運用中のため型を変えず、そのまま残す。新カラムと並存させ、
--     商談日時を保存したときはアプリ側で日付部分を meeting_scheduled_at にも
--     書き込む（ms管理の表示・編集は従来どおり動く）。
--   - 新カラムは NULL 許容の追加のみなので、既存レコード／新カラムを知らない
--     既存コードはそのまま動作し続ける。ロールバックも DROP COLUMN のみ。
--   - 時刻を伴うため、既存カラム（timestamp without time zone）とは異なり
--     timestamptz を採用する。Prisma 側は @db.Timestamptz(6) で対応させる。
--
-- 実行: node scripts/run-sql.cjs .env prisma/migrations-manual/2026-08-09_T01_deal_meeting_datetime.sql
-- ============================================================

BEGIN;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_start_at timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_end_at   timestamptz;

COMMENT ON COLUMN deals.meeting_start_at IS '商談の開始日時（T01）。NULL = 未入力';
COMMENT ON COLUMN deals.meeting_end_at   IS '商談の終了日時（T01）。NULL = 未入力';

-- 商談日時での絞り込み（T02 Meet発行・T03 録音準備の前日バッチが使う想定）
CREATE INDEX IF NOT EXISTS deals_meeting_start_at_idx ON deals (meeting_start_at);

COMMIT;

-- 確認:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'deals' AND column_name IN ('meeting_start_at','meeting_end_at');
--
-- 巻き戻し（必要な場合のみ）:
--   ALTER TABLE deals DROP COLUMN IF EXISTS meeting_start_at;
--   ALTER TABLE deals DROP COLUMN IF EXISTS meeting_end_at;
