// 権限（管理者・利用者・閲覧のみ）は、全社共通の User.permission ではなく、操作中の会社での権限
// （UserTenant.permission）で判定する。閲覧のみに下げた利用者が商談などを作成・更新できていた（クラウドの再確認で発見）。
//   - getCurrentPermission（src/lib/auth.ts）が操作中の会社の権限を返すこと
//   - 書き込み系の route と画面が、ログイン中のユーザーの User.permission を直接読まず、getCurrentPermission で判定すること
//   - 商談の作成・更新・削除が、閲覧のみでは 403 になること
// DB は模擬する（架空のユーザーのみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineModule } from "./helpers/offline-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LUMA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function loadAuth({ userPermission = "user", ctx = null, als = null, env = { NODE_ENV: "development" } } = {}) {
  const m = { env, ctx, als, userPermission, reads: 0 };
  m.prisma = { user: { findUnique: async () => { m.reads++; return { permission: m.userPermission }; } } };
  const auth = await offlineModule("src/lib/auth.ts", m, {
    bcryptjs: "export default {hash:async()=>'h',compare:async()=>true};",
    jose: "export class SignJWT{};export const jwtVerify=async()=>({payload:{userId:'u-1',email:'u1@example.invalid'}});",
    "next/headers": "export const cookies=async()=>({get:()=>({value:'token'}),set(){},delete(){}});",
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/tenant-context": "export const currentTenant=()=>mocks.als??undefined;export const getRequestTenant=async()=>mocks.ctx;",
  }, ["src/lib/auth.ts"], []);
  return { m, auth };
}
const ctxOf = (tenantId, permission, userId = "u-1") => ({ tenantId, code: "x", fiscalYearStartMonth: 6, userId, permission, crossTenant: false });

test("getCurrentPermission: 操作中の会社での権限を返す（全社共通の User.permission ではない）", async () => {
  // 全社共通では admin でも、この会社では閲覧のみ
  assert.equal(await (await loadAuth({ userPermission: "admin", ctx: ctxOf(LUMA, "viewer") })).auth.getCurrentPermission(), "viewer");
  // 全社共通では利用者でも、この会社（リージー）では管理者
  assert.equal(await (await loadAuth({ userPermission: "user", ctx: ctxOf(OTHER, "admin") })).auth.getCurrentPermission(), "admin");
});

test("getCurrentPermission: 全社統合ビューは閲覧のみ（書き込みは止める）", async () => {
  const cross = { tenantId: null, code: "__all__", fiscalYearStartMonth: 1, userId: "u-1", permission: "viewer", crossTenant: true };
  assert.equal(await (await loadAuth({ userPermission: "admin", ctx: cross })).auth.getCurrentPermission(), "viewer");
});

test("getCurrentPermission: runAsUserTenant で張った会社（同じユーザー）を優先し、バッチ用のコンテキスト（system）は使わない", async () => {
  assert.equal(await (await loadAuth({ ctx: ctxOf(LUMA, "viewer"), als: ctxOf(OTHER, "admin") })).auth.getCurrentPermission(), "admin");
  assert.equal(await (await loadAuth({ ctx: ctxOf(LUMA, "viewer"), als: ctxOf(LUMA, "admin", "system") })).auth.getCurrentPermission(), "viewer");
});

test("getCurrentPermission: 会社が決まらない（所属なし）ときは、移行期は全社共通の値、TENANT_STRICT=1 では null", async () => {
  assert.equal(await (await loadAuth({ userPermission: "user", ctx: null })).auth.getCurrentPermission(), "user");
  assert.equal(await (await loadAuth({ userPermission: "admin", ctx: null, env: { NODE_ENV: "development", TENANT_STRICT: "1" } })).auth.getCurrentPermission(), null);
});

// ---- 呼び出し元 -------------------------------------------------------------

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sources(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}
// ログイン中のユーザーの全社共通の権限を直接読む書き方（getCurrentPermission を通らない）
const DIRECT_READ = /prisma\.user\.findUnique\(\s*\{\s*where:\s*\{\s*id:\s*(?:session|s)[!?]?\.userId\s*\}\s*(?:,\s*select:\s*\{[^}]*permission:\s*true[^}]*\})?,?\s*\}\s*\)/;

test("呼び出し元: 画面・API が、ログイン中のユーザーの User.permission を直接読まない", async () => {
  const offenders = [];
  for (const file of [...await sources("src/app"), ...await sources("src/components")]) {
    const text = await readFile(path.join(ROOT, file), "utf8");
    const match = text.match(DIRECT_READ);
    if (!match) continue;
    // 権限以外の項目（名前・アバターなど）だけを読むものは対象外
    if (!/permission/.test(match[0]) && !/\bme\??\.permission|\buser\??\.permission/.test(text)) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

const WRITE_ROUTES = [
  "src/app/api/deals/route.ts",
  "src/app/api/deals/[id]/route.ts",
  "src/app/api/deals/[id]/products/route.ts",
  "src/app/api/deals/[id]/quotes/route.ts",
  "src/app/api/deals/[id]/summarize-bant/route.ts",
  "src/app/api/deals/[id]/preparation/route.ts",
  "src/app/api/deals/[id]/meet/route.ts",
  "src/app/api/meetings/route.ts",
  "src/app/api/meetings/[id]/route.ts",
  "src/app/api/meetings/[id]/analyze/route.ts",
  "src/app/api/meetings/[id]/transcription/route.ts",
  "src/app/api/meetings/upload-sessions/route.ts",
  "src/app/api/meetings/upload-sessions/[uploadId]/complete/route.ts",
  "src/app/api/meetings/upload-sessions/[uploadId]/parts/[index]/route.ts",
  "src/app/api/quotes/[id]/route.ts",
  "src/app/api/quotes/[id]/finalize/route.ts",
  "src/app/api/documents/route.ts",
  "src/app/api/documents/[id]/route.ts",
];

test("呼び出し元: 商談・会議・議事録・BANT・見積・資料・事前準備の書き込み系 route は、操作中の会社の権限（getCurrentPermission）で判定する", async () => {
  for (const file of WRITE_ROUTES) {
    const text = await readFile(path.join(ROOT, file), "utf8");
    assert.match(text, /getCurrentPermission\(\)/, file);
  }
});

// ---- 商談の作成・更新・削除 --------------------------------------------------

function dealsMocks(permission) {
  const m = { permission, created: [], updated: [], env: { NODE_ENV: "development" } };
  m.prisma = {
    deal: {
      create: async ({ data }) => { m.created.push(data); return { id: "deal-new", ...data }; },
      update: async ({ data }) => { m.updated.push(data); return { id: "deal-1", ...data }; },
      findUnique: async () => ({ id: "deal-1", companyId: "c-1", ownerUserId: null, status: "LEAD", deletedAt: null }),
      delete: async () => { m.updated.push({ deleted: true }); return {}; },
    },
    company: { findUnique: async () => ({ id: "c-1", name: "架空商事" }) },
    user: { findUnique: async () => ({ id: "u-1", name: "架空 太郎" }) },
    $transaction: async (fn) => (typeof fn === "function" ? fn(m.prisma) : Promise.all(fn)),
  };
  return m;
}
const permissionAuth = "export const getCurrentPermission=async()=>mocks.permission;export const getSession=async()=>({userId:'u-1'});export const hasPermission=(p,r)=>({viewer:1,user:2,admin:3})[p??'viewer']>=({viewer:1,user:2,admin:3})[r];";

test("商談の作成（POST /api/deals、会社の指定なし）: 操作中の会社で閲覧のみなら 403 で作らない", async () => {
  const m = dealsMocks("viewer");
  const route = await offlineModule("src/app/api/deals/route.ts", m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": permissionAuth,
    "@prisma/client": "export const DealStatus={LEAD:'LEAD'};",
    "@/lib/tenant-context": "export const runAsUserTenant=async()=>null;",
    "@/lib/deal-aggregations": "export const probabilityToYomi=()=>null;",
    "@/lib/deal-title": "export const buildDealTitle=()=>'架空商談';",
  }, ["src/app/api/deals/route.ts"]);
  const res = await route.POST(new Request("http://offline.invalid/api/deals", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId: "00000000-0000-4000-8000-000000000001", title: "架空商談" }),
  }));
  assert.equal(res.status, 403);
  assert.equal(m.created.length, 0);
});

test("商談の更新・削除（PATCH・DELETE /api/deals/[id]）: 閲覧のみなら、日時以外の項目も含めて 403", async () => {
  const text = await readFile(path.join(ROOT, "src/app/api/deals/[id]/route.ts"), "utf8");
  const patch = text.slice(text.indexOf("export async function PATCH"), text.indexOf("export async function DELETE"));
  // PATCH の最初（入力の解析の直後）で、項目に関係なく利用者以上かを確かめる
  const firstCheck = patch.search(/hasPermission\(await getCurrentPermission\(\), "user"\)/);
  const firstWrite = patch.search(/prisma\.deal\.update|tx\.deal\.update/);
  assert.ok(firstCheck > 0 && firstCheck < patch.indexOf("changesMeeting"), "PATCH の先頭で権限を確かめる");
  assert.ok(firstWrite === -1 || firstCheck < firstWrite);
  const del = text.slice(text.indexOf("export async function DELETE"));
  assert.match(del, /const perm = await getCurrentPermission\(\);[\s\S]*hasPermission\(perm, "user"\)/);
});

// ---- 画面 ---------------------------------------------------------------------

test("画面: 閲覧のみでは「新規商談」を出さない（商談一覧・会社詳細）", async () => {
  const deals = await readFile(path.join(ROOT, "src/app/(app)/deals/page.tsx"), "utf8");
  assert.match(deals, /right=\{canEdit \? <NewDealDialog \/> : null\}/);
  const company = await readFile(path.join(ROOT, "src/app/(app)/companies/[id]/page.tsx"), "utf8");
  assert.match(company, /<CompanyTabs company=\{company\} canEdit=\{canEdit\} \/>/);
  const tabs = await readFile(path.join(ROOT, "src/components/companies/company-tabs.tsx"), "utf8");
  const dialogs = tabs.match(/\{canEdit && <NewDealDialog defaultCompanyId=\{company\.id\} \/>\}/g) ?? [];
  assert.equal(dialogs.length, 2);
});

test("画面: 右上（サイドバー）の権限表示は、操作中の会社の権限", async () => {
  const layout = await readFile(path.join(ROOT, "src/app/(app)/layout.tsx"), "utf8");
  assert.match(layout, /getCurrentPermission\(\)/);
  assert.match(layout, /permission: tenantPermission/);
});
