// 担当者一覧（getSalesUsers）は、操作中の会社に所属する（user_tenants）ユーザーだけを返す。
// User は tenant_id を持たないため Prisma Extension では絞られず、商談一覧などの担当者の絞り込みに
// 別の会社のユーザーの名前・メールが出ていた。DB は模擬する（架空のユーザーのみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

const LUMA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INACTIVE = "33333333-3333-4333-8333-333333333333";
const TENANTS = { [LUMA]: { active: true }, [OTHER]: { active: true }, [INACTIVE]: { active: false } };

const USERS = [
  { id: "u-luma", name: "架空 太郎", email: "taro@example.invalid", role: "sales", tenants: [LUMA] },
  { id: "u-other", name: "架空 花子", email: "hanako@example.invalid", role: "sales", tenants: [OTHER] },
  { id: "u-both", name: "架空 次郎", email: "jiro@example.invalid", role: "manager", tenants: [LUMA, OTHER] },
  { id: "u-none", name: "架空 未所属", email: "none@example.invalid", role: "sales", tenants: [] },
  { id: "u-inactive", name: "架空 停止", email: "stop@example.invalid", role: "sales", tenants: [INACTIVE] },
  { id: "u-admin", name: "架空 管理", email: "admin@example.invalid", role: null, tenants: [LUMA] },
];

// 模擬 DB：getSalesUsers が送る where（role と userTenants.some）を実際に当てはめる
function membershipMatches(user, some) {
  return user.tenants.some((tenantId) =>
    (some.tenantId === undefined || some.tenantId === tenantId)
    && (some.tenant?.active === undefined || TENANTS[tenantId].active === some.tenant.active));
}
function setup(ctx, env = { NODE_ENV: "development" }) {
  const m = { calls: [], env, ctx };
  m.prisma = {
    user: {
      findMany: async (args) => {
        m.calls.push(args);
        return USERS
          .filter((u) => !args.where?.role?.in || args.where.role.in.includes(u.role))
          .filter((u) => !args.where?.userTenants?.some || membershipMatches(u, args.where.userTenants.some))
          .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
      },
    },
  };
  return m;
}

async function loadQueries(m) {
  const entry = "src/lib/queries.ts";
  return offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>null;",
    "@/lib/tenant-context": [
      "export const getFiscalStartMonth=async()=>6;",
      "export const currentTenant=()=>mocks.ctx??undefined;",
      "export const getRequestTenant=async()=>null;",
      `export const currentTenantId=()=>mocks.ctx?.tenantId??"${LUMA}";`,
    ].join(""),
    "@prisma/client": "export const DealStatus={};export const TaskStatus={};",
    "@/lib/deal-status": "export const isExcludedFromNextAction=()=>false;",
    "@/lib/deal-status-server": "export const excludeNGDealsWhere=()=>({});export const excludeDoneAndNGDealsWhere=()=>({});",
    "@/lib/kpi-rollup": "export const buildKpiRollup=()=>{throw Error('unused')};",
    // 先方の売上計上（SNS 月次按分）が使うリクエスト単位のメモ化。テストでは素通しにする。
    react: "export const cache=(fn)=>fn;",
  }, [entry, "src/lib/config.ts", "src/lib/calendar-date.ts", "src/lib/revenue-recognition.ts", "src/lib/product-categories.ts", "src/lib/deal-aggregations.ts", "src/lib/yomi-status.ts", "src/lib/tenant-users.ts", "src/lib/tenant-user-admin.ts"]);
}

const ids = (users) => users.map((u) => u.id).sort();
const ctxFor = (tenantId) => ({ tenantId, code: "x", fiscalYearStartMonth: 6, userId: "u-luma", permission: "user", crossTenant: false });

test("担当者一覧: 操作中の会社に所属するユーザーだけを返し、別の会社のユーザーの名前・メールは出さない", async () => {
  const m = setup(ctxFor(LUMA));
  const users = await (await loadQueries(m)).getSalesUsers();
  assert.deepEqual(ids(users), ["u-both", "u-luma"]);
  assert.ok(!users.some((u) => u.email === "hanako@example.invalid"));
});

test("担当者一覧: 別の会社に切り替えると、その会社のユーザーだけになる", async () => {
  const m = setup(ctxFor(OTHER));
  const users = await (await loadQueries(m)).getSalesUsers();
  assert.deepEqual(ids(users), ["u-both", "u-other"]);
});

test("担当者一覧: 全社統合ビューでは、有効な会社のどれかに所属するユーザーを返す（未所属・停止中の会社だけのユーザーは出さない）", async () => {
  const m = setup({ ...ctxFor(null), code: "__all__", permission: "viewer", crossTenant: true });
  const users = await (await loadQueries(m)).getSalesUsers();
  assert.deepEqual(ids(users), ["u-both", "u-luma", "u-other"]);
});

test("担当者一覧: 会社が決まらないときは、移行期は既定の会社（Luma）、TENANT_STRICT=1 では返さずに失敗する", async () => {
  const fallback = setup(null);
  assert.deepEqual(ids(await (await loadQueries(fallback)).getSalesUsers()), ["u-both", "u-luma"]);

  const strict = setup(null, { NODE_ENV: "development", TENANT_STRICT: "1" });
  await assert.rejects((await loadQueries(strict)).getSalesUsers(), /テナント/);
  assert.equal(strict.calls.length, 0);
});
