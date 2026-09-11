-- ============================================================
-- 所属会社(user_tenants)を持たないユーザーの検出と復旧
-- ============================================================
-- 背景:
--   マルチテナント化（2026-08-01）以降、メンバー追加の経路が user_tenants を
--   作っていなかった。
--     - POST /api/users（管理 > メンバーの「直接追加」）
--         → users は作られるが user_tenants が無い ＝ ログインできても全画面が落ちる
--     - POST /api/auth/register（招待URL）
--         → TENANT_STRICT=1 の本番では invites の読み取り自体が例外になり 500。
--           招待リンクが「エラーリンク」になっていたのはこれ。
--   アプリ側は 2026-09-11 の修正で両方とも user_tenants を必ず作るようにした。
--   このスクリプトは、それ以前に作られてしまった「所属なしユーザー」を後追いで直す。
--
-- 実行: node scripts/run-sql.cjs .env.production.local prisma/migrations-manual/2026-09-11_01_fix_orphan_users_without_tenant.sql
--
-- ⚠ 手順:
--   1. まず STEP 1（確認）だけを実行して、対象ユーザーと所属させるべき会社を目視確認する。
--   2. 問題なければ STEP 2 の BEGIN 〜 COMMIT を実行する。
--      STEP 2 は「全員を Luma に所属させる」前提。リージー所属にすべき人がいる場合は
--      その人だけ tenant_id を差し替えてから実行すること（Luma とリージーは別法人）。
-- ============================================================

-- ------------------------------------------------------------
-- STEP 1: 所属会社を持たないユーザーの一覧（これだけなら無害）
-- ------------------------------------------------------------
SELECT u.id,
       u.email,
       u.name,
       u.permission AS legacy_permission,
       u.role       AS legacy_role,
       u.created_at
FROM users u
LEFT JOIN user_tenants ut ON ut.user_id = u.id
WHERE ut.id IS NULL
ORDER BY u.created_at DESC;

-- ------------------------------------------------------------
-- STEP 2: 上記を Luma 所属として復旧する
-- ------------------------------------------------------------
-- 権限・役職は users 側のレガシー列（移行期の互換で残してある）を引き継ぐ。
-- is_default = true にしないと resolveTenantContext() が拾えない。
-- cross_tenant_read は全社統合ビューの権限なので、ここでは付けない（false）。
--
-- ↓ 確認が済むまでコメントアウトしたままにしておくこと
-- ------------------------------------------------------------
-- BEGIN;
--
-- INSERT INTO user_tenants (id, user_id, tenant_id, permission, role, is_default, cross_tenant_read, created_at)
-- SELECT gen_random_uuid()::text,   -- id は text 列なのでキャストが要る
--        u.id,
--        '11111111-1111-4111-8111-111111111111',  -- Luma（リージーは '22222222-2222-4222-8222-222222222222'）
--        COALESCE(u.permission, 'user'),
--        COALESCE(u.role, 'sales'),
--        true,
--        false,
--        now()
-- FROM users u
-- LEFT JOIN user_tenants ut ON ut.user_id = u.id
-- WHERE ut.id IS NULL;
--
-- -- 復旧後の確認：0行になっていること
-- SELECT count(*) AS still_orphan
-- FROM users u
-- LEFT JOIN user_tenants ut ON ut.user_id = u.id
-- WHERE ut.id IS NULL;
--
-- COMMIT;

-- ------------------------------------------------------------
-- 参考: tenant_id が入っていない招待（発行はされたが会社不明）の確認
-- ------------------------------------------------------------
-- アプリ側の修正で、この状態の招待は受諾を拒否する（所属なしユーザーを作らないため）。
-- 該当があれば管理画面から招待を取り消し、会社を選んだ状態で再発行する。
SELECT id, email, tenant_id, used, expires_at, created_at
FROM invites
WHERE tenant_id IS NULL OR tenant_id = ''
ORDER BY created_at DESC;
