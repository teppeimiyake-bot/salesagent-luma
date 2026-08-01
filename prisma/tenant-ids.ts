/**
 * テナントID定数（seed / backfill スクリプト用）
 * ============================================================
 * 値は prisma/migrations-manual/2026-08-01_01_multi_tenant_up.sql が投入する
 * tenants 行の固定 id と一致させること。
 *
 * アプリ本体（src/）からは使わない。本体は src/lib/tenant-context.ts の
 * コンテキストから解決し、Prisma Extension が自動でスコープする。
 *
 * 注意: これらのスクリプトは `@/lib/db` の Extension を通らない独自クライアントで
 * 動くものがある。その場合 create 時の tenant_id も自分で指定する必要がある。
 * 指定を忘れた場合は tenant_id が '' のまま INSERT され、tenants への FK 制約で
 * 必ず失敗する（黙って他社データを汚さない）。
 */
export const LUMA_TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const REAGEY_TENANT_ID = "22222222-2222-4222-8222-222222222222";
