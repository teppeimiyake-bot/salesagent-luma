-- ============================================================
-- 【テスト用ブランチ限定】リージー所属を追加して会社タブを出す
-- ============================================================
-- 会社タブは「2社以上に所属している人」にだけ表示される。
-- Phase 1 の台本では全員が Luma のみに紐付くため、このままではタブが出ない。
-- 画面確認のために、リージー本番でも admin である2名をリージーにも所属させる。
--
-- 本番に流すのは Phase 5（リージーのデータ移管）のとき。
-- それまで本番では実行しないこと（タブが出ても中身が空で混乱するため）。
--
-- 実行: node scripts/run-sql.cjs .env.staging prisma/migrations-manual/_test-only_add-reagey-membership.sql
-- ============================================================

BEGIN;

INSERT INTO user_tenants (id, user_id, tenant_id, permission, role, is_default, cross_tenant_read)
SELECT
  gen_random_uuid()::text,
  u.id,
  '22222222-2222-4222-8222-222222222222', -- リージー
  'admin',
  'manager',
  false,   -- ログイン直後は Luma（is_default は Luma 側が true のまま）
  true     -- 全社ビューも可
FROM users u
WHERE u.email IN ('teppei.miyake@luma-create.com', 'hana.tominaga@reeasy.jp')
ON CONFLICT (user_id, tenant_id) DO NOTHING;

COMMIT;

-- 確認:
--   SELECT u.email, t.code, ut.permission
--   FROM user_tenants ut JOIN users u ON u.id = ut.user_id JOIN tenants t ON t.id = ut.tenant_id
--   ORDER BY u.email, t.sort_order;
