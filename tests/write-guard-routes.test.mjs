// 書き込み・AI 呼び出し・外部取得をするのに権限を確かめていなかった route を、利用者以上（操作中の会社での権限）に限る。
// 閲覧のみ・全社統合ビューでは 403 にし、DB への書き込み・AI・外部への取得を一切しない。
// 対象：タスク・連絡先・会社の追加・会社HPの要約とロゴの取得・AIチャット・次の一手の提案・ナレッジのAI検索。
// DB・AI・外部通信は模擬する（offlineModule は外部通信を禁止している）。
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offlineModule } from "./helpers/offline-module.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = "00000000-0000-4000-8000-000000000001";
const WRITE_OPS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);

function mocks({ permission, cross = false, signedIn = true }) {
  const m = { permission, writes: [], ai: 0, env: { NODE_ENV: "development" } };
  m.session = signedIn ? { userId: "u-1" } : null;
  m.ctx = cross
    ? { tenantId: null, code: "__all__", fiscalYearStartMonth: 1, userId: "u-1", permission: "viewer", crossTenant: true }
    : { tenantId: "t-1", code: "luma", fiscalYearStartMonth: 6, userId: "u-1", permission: permission ?? "viewer", crossTenant: false };
  const model = (name) => new Proxy({}, { get: (_, op) => async (args) => {
    if (WRITE_OPS.has(op)) { m.writes.push(`${name}.${op}`); return { id: "row", ...(args?.data ?? {}) }; }
    if (op === "findMany") return [];
    if (op === "count") return 0;
    return null;
  } });
  m.prisma = new Proxy({}, { get: (_, name) => (name === "$transaction" ? async (x) => (typeof x === "function" ? x(m.prisma) : Promise.all(x)) : model(name)) });
  m.callAi = async () => { m.ai++; return "{}"; };
  return m;
}

const boundaries = {
  "@/lib/ai/text-style": "export const JP_TEXT_STYLE_RULE='';export const JP_JSON_TEXT_STYLE_RULE='';",
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>mocks.session?(mocks.ctx.crossTenant?'viewer':mocks.permission):null;const r={viewer:1,user:2,admin:3};export const hasPermission=(p,q)=>(r[p??'viewer']??0)>=r[q];",
  "@/lib/tenant-context": "export const currentTenant=()=>mocks.ctx;export const getRequestTenant=async()=>mocks.ctx;",
  "@/lib/ai/anthropic": "export const callClaude=(...a)=>mocks.callAi(...a);export const callClaudeJSON=(...a)=>mocks.callAi(...a);",
  "@/lib/ai/provider": "export const hasAiTextKey=()=>true;",
  "@/lib/deal-status-server": "export const excludeDoneAndNGDealsWhere=async()=>({AND:[]});",
  "@/lib/meeting-datetime": "export const toJstDateStr=()=>'2026-10-01';",
  "@prisma/client": "export const TaskStatus={OPEN:'OPEN',DONE:'DONE'};",
};

const json = (body, method = "POST") => new Request("http://offline.invalid", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: UUID }) };
const CASES = [
  ["src/app/api/tasks/route.ts", "POST", () => [json({ title: "架空のタスク", dealId: UUID })]],
  ["src/app/api/tasks/[id]/route.ts", "PATCH", () => [json({ status: "DONE" }, "PATCH"), params]],
  ["src/app/api/tasks/[id]/route.ts", "DELETE", () => [new Request("http://offline.invalid", { method: "DELETE" }), params]],
  ["src/app/api/contacts/route.ts", "POST", () => [json({ companyId: UUID, name: "架空 連絡先" })]],
  ["src/app/api/contacts/[id]/route.ts", "PATCH", () => [json({ name: "架空 変更" }, "PATCH"), params]],
  ["src/app/api/contacts/[id]/route.ts", "DELETE", () => [new Request("http://offline.invalid", { method: "DELETE" }), params]],
  ["src/app/api/companies/route.ts", "POST", () => [json({ name: "架空商事", websiteUrl: "https://example.invalid" })]],
  ["src/app/api/companies/[id]/fetch-summary/route.ts", "POST", () => [new Request("http://offline.invalid", { method: "POST" }), params]],
  ["src/app/api/companies/[id]/fetch-logo/route.ts", "POST", () => [new Request("http://offline.invalid", { method: "POST" }), params]],
  ["src/app/api/chat/route.ts", "POST", () => [json({ scope: "global", content: "架空の質問" })]],
  ["src/app/api/deals/[id]/suggest-next-action/route.ts", "POST", () => [new Request("http://offline.invalid", { method: "POST" }), params]],
  ["src/app/api/knowledge/search/route.ts", "POST", () => [json({ query: "架空の検索" })]],
];
const load = (entry, m) => offlineModule(entry, m, boundaries, [entry, "src/lib/write-guard.ts"]);

for (const [entry, method, args] of CASES) {
  const name = `${method} ${entry.replace("src/app", "").replace("/route.ts", "")}`;
  test(`${name}: 閲覧のみは 403 で、書き込み・AI・外部取得をしない`, async () => {
    const m = mocks({ permission: "viewer" });
    const res = await (await load(entry, m))[method](...args());
    assert.equal(res.status, 403, JSON.stringify(await res.clone().json().catch(() => null)));
    assert.match((await res.json()).error, /閲覧のみ/);
    assert.deepEqual(m.writes, []);
    assert.equal(m.ai, 0);
  });
  test(`${name}: 全社統合ビューは 403 と、会社を切り替える案内`, async () => {
    const m = mocks({ permission: "admin", cross: true });
    const res = await (await load(entry, m))[method](...args());
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /全社統合ビュー/);
    assert.deepEqual(m.writes, []);
    assert.equal(m.ai, 0);
  });
  test(`${name}: 未ログインは 401、利用者は権限で止めない`, async () => {
    const anon = mocks({ permission: null, signedIn: false });
    assert.equal((await (await load(entry, anon))[method](...args())).status, 401);
    const user = mocks({ permission: "user" });
    let status;
    try { status = (await (await load(entry, user))[method](...args())).status; } catch { status = "threw-after-guard"; }
    assert.notEqual(status, 403);
    assert.notEqual(status, 401);
  });
}

test("呼び出し元: 書き込み・AI・外部取得をする route（認証・テナント切替・cron・エージェントを除く）は、すべて権限を確かめる", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) await walk(rel);
      else if (e.name === "route.ts") files.push(rel);
    }
  };
  await walk("src/app/api");
  const EXEMPT = /^src\/app\/api\/(auth|tenant|cron|agents)\//;
  const missing = [];
  for (const file of files) {
    if (EXEMPT.test(file)) continue;
    const text = await readFile(path.join(ROOT, file), "utf8");
    for (const part of text.split(/(?=export (?:async )?function (?:GET|POST|PATCH|PUT|DELETE)\b)/).slice(1)) {
      const method = part.match(/export (?:async )?function (\w+)/)[1];
      if (method === "GET") continue;
      if (!/getCurrentPermission|requireWriter|requireUserAdmin|requireWrite|requirePermission|authorize\(true\)|guard\(|requireAdmin\(|guardKyopro\(/.test(part)) missing.push(`${method} ${file}`);
    }
  }
  assert.deepEqual(missing, []);
});
