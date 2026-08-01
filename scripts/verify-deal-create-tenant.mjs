/**
 * 商談作成の会社選択が正しく効くかを、実際の API 経由で確認する
 * ============================================================
 * 「どちらの会社の商談か」の選択は、Cookie も画面も詐称できるため
 * サーバー側で所属を検証している。その動作を HTTP 越しに確かめる。
 *
 * 前提: strict モードの dev サーバーがテスト用DBを見て起動していること（既定 3004）
 * 実行: node scripts/verify-deal-create-tenant.mjs [ポート]
 *
 * テスト用DB専用。作った商談は最後に削除する。本番に向けて実行しないこと。
 */
import fs from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";

const PORT = process.argv[2] ?? "3004";
const BASE = `http://localhost:${PORT}`;
const LUMA = "11111111-1111-4111-8111-111111111111";
const REAGEY = "22222222-2222-4222-8222-222222222222";

const secret = fs.readFileSync(".env", "utf8").match(/^JWT_SECRET\s*=\s*"?([^"\r\n]+)/m)[1];
const dbUrl = fs.readFileSync(".env.staging", "utf8").match(/DATABASE_URL="([^"]+)/)[1];

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const boss = (await db.query(`select id from users where email='teppei.miyake@luma-create.com'`)).rows[0];
// リージーに所属していない一般社員（所属外テナントを指定した場合の拒否を確認する）
const staff = (await db.query(
  `select u.id, u.email from users u
   where not exists (select 1 from user_tenants ut where ut.user_id=u.id and ut.tenant_id=$1)
   and u.permission <> 'viewer' limit 1`, [REAGEY])).rows[0];
const company = (await db.query(`select id from companies where deleted_at is null limit 1`)).rows[0];
const leadSource = (await db.query(`select id from lead_sources where tenant_id=$1 limit 1`, [LUMA])).rows[0];

const sign = async (userId, email) =>
  new SignJWT({ userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt().setExpirationTime("7d")
    .sign(new TextEncoder().encode(secret));

const bossToken = await sign(boss.id, "teppei.miyake@luma-create.com");
const staffToken = await sign(staff.id, staff.email);

let failed = 0;
const ok = (m) => console.log("  ✓ " + m);
const ng = (m) => { console.error("  ✗ " + m); failed++; };
const created = [];

async function createDeal(token, tenantId, title) {
  const r = await fetch(BASE + "/api/deals", {
    method: "POST",
    headers: { cookie: `salesagent_session=${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId,
      companyId: company.id,
      ownerUserId: boss.id,
      leadSourceId: leadSource?.id,
      title,
      appointmentDate: new Date().toISOString(),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.deal?.id) created.push(j.deal.id);
  return { status: r.status, deal: j.deal, error: j.error };
}

console.log(`=== 商談作成の会社選択（${BASE}）===\n`);

// 1. 社長がリージーを選んで作成 → リージーの商談になる
let r = await createDeal(bossToken, REAGEY, "__verify_create_reagey__");
r.deal?.tenantId === REAGEY
  ? ok("リージーを選んで作成 → リージーの商談になる")
  : ng(`リージー指定なのに tenantId=${r.deal?.tenantId ?? `作成失敗 HTTP ${r.status} ${r.error ?? ""}`}`);

// 2. 社長が Luma を選んで作成 → Luma の商談になる
r = await createDeal(bossToken, LUMA, "__verify_create_luma__");
r.deal?.tenantId === LUMA
  ? ok("Luma を選んで作成 → Luma の商談になる")
  : ng(`Luma 指定なのに tenantId=${r.deal?.tenantId ?? `作成失敗 HTTP ${r.status}`}`);

// 3. 所属していない会社を指定 → 403 で拒否
r = await createDeal(staffToken, REAGEY, "__verify_create_denied__");
r.status === 403
  ? ok("所属していない会社を指定すると 403 で拒否される")
  : ng(`所属外の会社を指定できてしまった（HTTP ${r.status} / tenantId=${r.deal?.tenantId}）`);

// 4. 会社を指定しない → 表示中のタブ（既定 Luma）で作成される
r = await createDeal(bossToken, undefined, "__verify_create_default__");
r.deal?.tenantId === LUMA
  ? ok("会社を指定しない場合は表示中のタブ（Luma）で作成される")
  : ng(`未指定時の tenantId=${r.deal?.tenantId ?? `作成失敗 HTTP ${r.status}`}`);

// 後片付け
if (created.length) {
  await db.query(`delete from deal_products where deal_id = any($1)`, [created]);
  await db.query(`delete from deals where id = any($1)`, [created]);
}
const left = (await db.query(`select count(*)::int n from deals where title like '__verify_create%'`)).rows[0].n;
left === 0 ? ok("テストで作った商談を削除済み") : ng(`テスト商談が ${left} 件残っている`);
await db.end();

console.log(failed === 0 ? "\n=== 全チェック通過 ===" : `\n=== ${failed} 件の失敗 ===`);
process.exit(failed ? 1 : 0);
