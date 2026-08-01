/**
 * TENANT_STRICT=1 での全画面・全APIチェック
 * ============================================================
 * TENANT_STRICT=1 にすると、会社が決まらないまま テナント所有テーブルを触った
 * 箇所が例外になる。本番でこれを有効にする前に、包み忘れが残っていないかを
 * 実際に全画面・全GET APIを叩いて洗い出す。
 *
 * 前提: 別ウィンドウで strict モードの dev サーバーを起動しておく
 *   $env:DATABASE_URL = (Select-String .env.staging -Pattern '^DATABASE_URL="(.+)"').Matches.Groups[1].Value
 *   $env:TENANT_STRICT = "1"
 *   npx next dev -p 3004
 *
 * 実行: node scripts/verify-tenant-strict.mjs [ポート]
 */
import fs from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";

const PORT = process.argv[2] ?? "3004";
const BASE = `http://localhost:${PORT}`;
const env = fs.readFileSync(".env", "utf8");
const secret = env.match(/^JWT_SECRET\s*=\s*"?([^"\r\n]+)/m)?.[1] ?? "dev-secret-change-me-please-32chars-minimum";
const dbUrl = fs.readFileSync(".env.staging", "utf8").match(/DATABASE_URL="([^"]+)/)[1];

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const me = (await db.query(`select id, email from users where email='teppei.miyake@luma-create.com'`)).rows[0];
// 動的セグメントに使う実データのID
const dealId = (await db.query(`select id from deals where deleted_at is null limit 1`)).rows[0]?.id;
const companyId = (await db.query(`select id from companies where deleted_at is null limit 1`)).rows[0]?.id;
const projectId = (await db.query(`select id from production_projects limit 1`)).rows[0]?.id;
await db.end();

const token = await new SignJWT({ userId: me.id, email: me.email })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(new TextEncoder().encode(secret));

const PAGES = [
  "/dashboard", "/deals", `/deals/${dealId}`, "/companies", `/companies/${companyId}`,
  "/kpi", "/kpi?tenant=luma", "/kpi?tenant=reagey", "/team", "/todos", "/documents",
  "/ms", "/ms-outreach", "/pm", projectId ? `/pm/${projectId}` : null, "/payments", "/agent",
  "/admin/products", "/admin/plan-proposals", "/admin/lead-sources", "/admin/industries",
  "/admin/pipeline-stages", "/admin/pm-staff", "/admin/users", "/admin/company-merges",
  "/admin/trash", "/admin/agent-candidates",
].filter(Boolean);

const APIS = [
  "/api/deals", "/api/companies", "/api/users", "/api/lead-sources", "/api/pipeline-stages",
  "/api/industries", "/api/plan-proposals", "/api/pm-staff", "/api/products", "/api/tasks",
  "/api/documents", "/api/tenant/mine", "/api/ms-weekly?fy=2026", "/api/ms-kpi-goal?fy=2026",
  `/api/contacts?companyId=${companyId}`, `/api/deals?companyId=${companyId}`,
];

let failed = 0;
async function hit(path, kind) {
  try {
    const r = await fetch(BASE + path, { headers: { cookie: `salesagent_session=${token}` }, redirect: "manual" });
    // 3xx（リダイレクト）と 404 は「テナント境界の問題ではない」ので通す
    const bad = r.status >= 500;
    if (bad) {
      const body = await r.text();
      const hint = body.match(/テナントコンテキストなしで [^\s"<]+/)?.[0] ?? "";
      console.error(`  ✗ ${kind} ${path} … HTTP ${r.status}${hint ? ` / ${hint}` : ""}`);
      failed++;
    } else {
      console.log(`  ✓ ${kind} ${path} … HTTP ${r.status}`);
    }
  } catch (e) {
    console.error(`  ✗ ${kind} ${path} … ${e.message}`);
    failed++;
  }
}

console.log(`=== TENANT_STRICT=1 での全画面チェック（${BASE}）===\n`);
console.log("[ページ]");
for (const p of PAGES) await hit(p, "GET");
console.log("\n[API]");
for (const a of APIS) await hit(a, "GET");

console.log(
  failed === 0
    ? "\n=== 全て通過（包み忘れなし。TENANT_STRICT=1 を本番に入れられる）==="
    : `\n=== ${failed} 件が 500。上記の箇所を runAsTenant()/withTenant() で包むこと ===`,
);
process.exit(failed ? 1 : 0);
