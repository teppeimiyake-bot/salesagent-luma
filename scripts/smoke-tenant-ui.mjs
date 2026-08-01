/**
 * 会社タブのスモークテスト（実際に動いている dev サーバーに対して確認する）
 * ============================================================
 * テスト用DBに繋いだ dev サーバー(3003)に、社長としてログインした状態でアクセスし、
 * 会社タブ・KPIタブ・会計年度・商談の分離が正しく動くかを確認する。
 *
 * 前提: 別ウィンドウで dev サーバーがテスト用DBを見て起動していること
 *   $env:DATABASE_URL = (Select-String -Path .env.staging -Pattern '^DATABASE_URL="(.+)"').Matches.Groups[1].Value
 *   npm run dev
 *
 * 実行: node scripts/smoke-tenant-ui.mjs
 *
 * ログインは .env の JWT_SECRET でセッショントークンを自作して通す（開発確認用）。
 * 本番URLに対しては実行しないこと。
 */
import fs from "node:fs";
import { SignJWT } from "jose";
import pg from "pg";

const env = fs.readFileSync(".env", "utf8");
const secretRaw = env.match(/^JWT_SECRET\s*=\s*"?([^"\r\n]+)/m)?.[1] ?? "dev-secret-change-me-please-32chars-minimum";
const dbUrl = fs.readFileSync(".env.staging", "utf8").match(/DATABASE_URL="([^"]+)/)[1];
const BASE = "http://localhost:3003";

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const me = (await client.query(`select id, email from users where email='teppei.miyake@luma-create.com'`)).rows[0];
await client.end();

const token = await new SignJWT({ userId: me.id, email: me.email })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(new TextEncoder().encode(secretRaw));

let tenantCookie = "";
const cookieHeader = () => `salesagent_session=${token}${tenantCookie ? `; salesagent_tenant=${tenantCookie}` : ""}`;
const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { cookie: cookieHeader() } });
  return { status: r.status, html: await r.text() };
};

const results = [];
const check = (label, cond, extra = "") => {
  results.push({ label, ok: !!cond, extra });
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? ` … ${extra}` : ""}`);
};

console.log("=== 会社タブ（サイドバー）===");
let r = await get("/dashboard");
check("ダッシュボードが開ける", r.status === 200, `HTTP ${r.status}`);
check("サイドバーに Luma タブ", r.html.includes(">Luma<"));
check("サイドバーに リージー タブ", r.html.includes(">リージー<"));
check("全社タブ（社長のみ）", r.html.includes(">全社<"));
check("ブランド表示は株式会社Luma", r.html.includes("株式会社Luma"));

console.log("\n=== KPI：Luma ===");
r = await get("/kpi?tenant=luma");
check("KPIが開ける", r.status === 200, `HTTP ${r.status}`);
const lumaFy = r.html.match(/FY(\d{4})（(\d{4})年(\d+)月〜(\d{4})年(\d+)月）/);
check("会計年度が6月始まり", lumaFy && lumaFy[3] === "6", lumaFy ? lumaFy[0] : "表記なし");
check("ヘッダーに Luma", r.html.includes("Luma｜"));

console.log("\n=== KPI：リージー ===");
r = await get("/kpi?tenant=reagey");
check("KPIが開ける", r.status === 200, `HTTP ${r.status}`);
const rgFy = r.html.match(/FY(\d{4})（(\d{4})年(\d+)月〜(\d+)月）|FY(\d{4})（(\d{4})年(\d+)月〜(\d{4})年(\d+)月）/);
check("会計年度が1月始まり（暦年）", rgFy && /（\d{4}年1月〜12月）/.test(rgFy[0]), rgFy ? rgFy[0] : "表記なし");
check("ヘッダーに リージー", r.html.includes("リージー｜"));

console.log("\n=== 商談一覧のテナント分離 ===");
tenantCookie = "luma";
r = await get("/deals");
const lumaDeals = (r.html.match(/data-deal-id|\/deals\//g) || []).length;
check("Luma タブでは商談が表示される", r.status === 200 && lumaDeals > 0, `商談リンク ${lumaDeals} 箇所`);
tenantCookie = "reagey";
r = await get("/deals");
const rgDeals = (r.html.match(/\/deals\/[0-9a-f-]{36}/g) || []).length;
check("リージー タブでは Luma の商談が出ない", rgDeals === 0, `商談リンク ${rgDeals} 件`);

console.log("\n=== 登録先の選択肢API ===");
tenantCookie = "luma";
let res = await fetch(BASE + "/api/tenant/mine", { headers: { cookie: cookieHeader() } });
let j = await res.json();
check("所属2社が返る", j.tenants?.length === 2, (j.tenants ?? []).map((t) => t.shortName).join(" / "));
check("既定は Luma", j.activeCode === "luma", `activeCode=${j.activeCode}`);

console.log("\n=== テナント切替API ===");
res = await fetch(BASE + "/api/tenant/switch", {
  method: "POST",
  headers: { cookie: cookieHeader(), "Content-Type": "application/json" },
  body: JSON.stringify({ code: "reagey" }),
});
check("リージーに切り替えできる", res.ok, `HTTP ${res.status}`);
res = await fetch(BASE + "/api/tenant/switch", {
  method: "POST",
  headers: { cookie: cookieHeader(), "Content-Type": "application/json" },
  body: JSON.stringify({ code: "no-such-company" }),
});
check("所属しない会社は拒否される", res.status === 403, `HTTP ${res.status}`);

const failed = results.filter((x) => !x.ok);
console.log(failed.length === 0 ? "\n=== 全チェック通過 ===" : `\n=== ${failed.length} 件の失敗 ===`);
process.exit(failed.length ? 1 : 0);
