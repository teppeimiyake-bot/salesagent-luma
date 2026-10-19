// ユーザーの一覧・作成・更新・削除（/api/users・/api/users/[id]・招待・管理画面のユーザー一覧）を、操作中の会社に限る。
// User は tenant_id を持たないため Prisma Extension では絞られず、ログインしていれば全ユーザーのメールが返り、
// 管理者はほかの会社のユーザーの権限・メールの変更や削除までできていた。
// 管理者かどうかは、全社共通の User.permission ではなく、操作中の会社での権限（UserTenant.permission）で決める。
// 権限・役職の変更もその会社の所属だけを変え、ほかの会社にも所属するユーザーの全社共通の値（権限・メール）は変えない。
// DB は模擬する（架空のユーザーのみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { offlineModule } from "./helpers/offline-module.mjs";

const LUMA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const INACTIVE = "33333333-3333-4333-8333-333333333333";
const ACTIVE = { [LUMA]: true, [OTHER]: true, [INACTIVE]: false };
const mem = (tenantId, permission = "user", role = "sales") => ({ tenantId, permission, role });

function fixture() {
  return [
    { id: "u-admin", name: "架空 管理", email: "admin@example.invalid", role: "manager", permission: "admin", m: [mem(LUMA, "admin", "manager")] },
    { id: "u-radmin", name: "架空 他社管理", email: "radmin@example.invalid", role: "manager", permission: "user", m: [mem(OTHER, "admin", "manager")] },
    { id: "u-gadmin", name: "架空 旧管理", email: "gadmin@example.invalid", role: "sales", permission: "admin", m: [mem(LUMA, "user")] },
    { id: "u-luma", name: "架空 太郎", email: "taro@example.invalid", role: "sales", permission: "user", m: [mem(LUMA)] },
    { id: "u-other", name: "架空 花子", email: "hanako@example.invalid", role: "sales", permission: "user", m: [mem(OTHER)] },
    { id: "u-both", name: "架空 次郎", email: "jiro@example.invalid", role: "manager", permission: "user", m: [mem(LUMA, "user", "manager"), mem(OTHER, "user", "manager")] },
    { id: "u-none", name: "架空 未所属", email: "none@example.invalid", role: "sales", permission: "user", m: [] },
    { id: "u-inactive", name: "架空 停止", email: "stop@example.invalid", role: "sales", permission: "user", m: [mem(INACTIVE)] },
  ];
}
const CROSS_FOR = (userId) => ({ tenantId: null, code: "__all__", fiscalYearStartMonth: 1, userId, permission: "viewer", crossTenant: true });

const memberOf = (user, some) => user.m.some((r) =>
  (some.tenantId === undefined || some.tenantId === r.tenantId)
  && (some.permission === undefined || some.permission === r.permission)
  && (some.tenant?.active === undefined || ACTIVE[r.tenantId] === some.tenant.active));
function pick(u, select) {
  if (!select) return { ...u };
  const out = {};
  for (const [k, v] of Object.entries(select)) {
    if (k === "userTenants") out.userTenants = u.m.filter((r) => !v.where?.tenantId || r.tenantId === v.where.tenantId).map((r) => ({ permission: r.permission, role: r.role }));
    else if (k in u) out[k] = u[k];
  }
  return out;
}

/** session のユーザーが tenantId の会社を操作中（その会社での権限が ctx.permission）。tenantId=null は全社統合ビュー。 */
function setup({ as = "u-admin", tenantId = LUMA, ctx: ctxOverride, env = { NODE_ENV: "development" }, session } = {}) {
  const m = { env, users: fixture(), updated: [], memberUpdates: [], deleted: [], created: [], detached: [], invites: [] };
  const find = (id) => m.users.find((u) => u.id === id);
  m.session = session === undefined ? { userId: as } : session;
  const own = find(as)?.m.find((r) => r.tenantId === tenantId);
  m.ctx = ctxOverride !== undefined ? ctxOverride
    : tenantId === null ? CROSS_FOR(as)
    : own ? { tenantId, code: "x", fiscalYearStartMonth: 6, userId: as, permission: own.permission, crossTenant: false } : null;
  m.prisma = {
    user: {
      findMany: async ({ where = {}, select } = {}) => m.users
        .filter((u) => !where.role?.in || where.role.in.includes(u.role))
        .filter((u) => !where.userTenants?.some || memberOf(u, where.userTenants.some))
        .map((u) => pick(u, select)),
      findUnique: async ({ where, select }) => {
        const u = where.id ? find(where.id) : m.users.find((x) => x.email === where.email);
        return u ? pick(u, select) : null;
      },
      update: async ({ where, data, select }) => {
        const u = find(where.id);
        if (!u) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(u, data);
        m.updated.push({ id: where.id, data: JSON.parse(JSON.stringify(data)) });
        return pick(u, select);
      },
      delete: async ({ where }) => { m.deleted.push(where.id); m.users = m.users.filter((u) => u.id !== where.id); return {}; },
      create: async ({ data, select }) => {
        const { userTenants, ...rest } = data;
        const u = { id: `u-new-${m.created.length + 1}`, ...rest, m: userTenants?.create ? [{ ...userTenants.create }] : [] };
        m.users.push(u);
        m.created.push({ data });
        return pick(u, select);
      },
    },
    userTenant: {
      findMany: async ({ where }) => m.users.filter((u) => u.id === where.userId)
        .flatMap((u) => u.m.map((r) => ({ userId: u.id, ...r })))
        .filter((r) => where.permission === undefined || r.permission === where.permission),
      findFirst: async ({ where }) => {
        const u = find(where.userId);
        const r = u?.m.find((x) => (where.tenantId === undefined || x.tenantId === where.tenantId)
          && (where.permission === undefined || x.permission === where.permission)
          && (where.tenant?.active === undefined || ACTIVE[x.tenantId] === where.tenant.active));
        return r ? { userId: u.id, ...r } : null;
      },
      update: async ({ where, data }) => {
        const key = where.userId_tenantId;
        const r = find(key.userId)?.m.find((x) => x.tenantId === key.tenantId);
        if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(r, data);
        m.memberUpdates.push({ ...key, data: JSON.parse(JSON.stringify(data)) });
        return { userId: key.userId, ...r };
      },
    },
    deal: { updateMany: async (a) => { m.detached.push(["deal", a]); return { count: 0 }; } },
    document: { updateMany: async (a) => { m.detached.push(["document", a]); return { count: 0 }; } },
    invite: {
      deleteMany: async () => ({ count: 0 }),
      findMany: async () => m.invites,
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }) => { const i = { id: `inv-${m.invites.length + 1}`, ...data }; m.invites.push(i); return i; },
      delete: async ({ where }) => { m.invites = m.invites.filter((i) => i.id !== where.id); return {}; },
    },
    $transaction: async (ops) => Promise.all(ops),
  };
  return m;
}

const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getSession=async()=>mocks.session;export const hasPermission=(p,r)=>({viewer:1,user:2,admin:3})[p??'viewer']>=({viewer:1,user:2,admin:3})[r];export const hashPassword=async()=>'hash';",
  "@/lib/tenant-context": [
    "export const currentTenant=()=>mocks.ctx??undefined;",
    "export const getRequestTenant=async()=>null;",
    `export const currentTenantId=()=>mocks.ctx?.tenantId??"${LUMA}";`,
  ].join(""),
};
const deps = ["src/lib/tenant-users.ts", "src/lib/tenant-user-admin.ts", "src/lib/email.ts"];
const load = (entry, m) => offlineModule(entry, m, boundaries, [entry, ...deps], ["zod", "next/server", "node:path", "node:crypto", "crypto"]);
const loadUsers = (m) => load("src/app/api/users/route.ts", m);
const loadUser = (m) => load("src/app/api/users/[id]/route.ts", m);
const loadInvites = (m) => load("src/app/api/invites/route.ts", m);
const params = (id) => ({ params: Promise.resolve({ id }) });
const json = (body, method = "POST") => new Request("http://offline.invalid/api/users", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ids = (users) => users.map((u) => u.id).sort();
const user = (m, id) => m.users.find((u) => u.id === id);
const membership = (m, id, tenantId) => user(m, id).m.find((r) => r.tenantId === tenantId);
const del = () => new Request("http://offline.invalid", { method: "DELETE" });

test("GET /api/users: 操作中の会社に所属するユーザーだけを返し、権限・役職はその会社での値", async () => {
  const m = setup();
  const body = await (await (await loadUsers(m)).GET()).json();
  assert.deepEqual(ids(body.users), ["u-admin", "u-both", "u-gadmin", "u-luma"]);
  assert.ok(!JSON.stringify(body).includes("hanako@example.invalid"));
  assert.equal(body.users.find((u) => u.id === "u-gadmin").permission, "user", "この会社では利用者");
  assert.ok(!("userTenants" in body.users[0]));
});

test("GET /api/users: 別の会社ではその会社のユーザー、全社統合ビューでは有効な会社のどれかに所属するユーザー", async () => {
  assert.deepEqual(ids((await (await (await loadUsers(setup({ as: "u-radmin", tenantId: OTHER }))).GET()).json()).users), ["u-both", "u-other", "u-radmin"]);
  assert.deepEqual(ids((await (await (await loadUsers(setup({ tenantId: null }))).GET()).json()).users), ["u-admin", "u-both", "u-gadmin", "u-luma", "u-other", "u-radmin"]);
});

test("GET /api/users: 会社が決まらないときは移行期は既定の会社、TENANT_STRICT=1 では返さない。未ログインは 401", async () => {
  assert.deepEqual(ids((await (await (await loadUsers(setup({ ctx: null }))).GET()).json()).users), ["u-admin", "u-both", "u-gadmin", "u-luma"]);
  const strict = await (await loadUsers(setup({ ctx: null, env: { NODE_ENV: "development", TENANT_STRICT: "1" } }))).GET();
  assert.ok(strict.status >= 400);
  assert.ok(!JSON.stringify(await strict.json()).includes("@example.invalid"));
  assert.equal((await (await loadUsers(setup({ session: null }))).GET()).status, 401);
});

test("POST /api/users: 追加したユーザーは操作中の会社に所属させる。全社統合ビューでは追加しない", async () => {
  const m = setup();
  const res = await (await loadUsers(m)).POST(json({ email: "new@example.invalid", name: "架空 新人", role: "sales", permission: "user" }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(JSON.parse(JSON.stringify(m.created[0].data.userTenants.create)), { tenantId: LUMA, permission: "user", role: "sales", isDefault: true });
  assert.ok(ids((await (await (await loadUsers(m)).GET()).json()).users).includes("u-new-1"));

  const cross = setup({ tenantId: null });
  const denied = await (await loadUsers(cross)).POST(json({ email: "new@example.invalid", name: "架空 新人" }));
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /全社統合ビュー/);
  assert.equal(cross.created.length, 0);
});

test("管理者の判定は操作中の会社での権限: 全社共通で admin でも、この会社で利用者なら追加・変更・削除・招待はできない", async () => {
  const m = setup({ as: "u-gadmin", tenantId: LUMA });
  assert.equal((await (await loadUsers(m)).POST(json({ email: "new@example.invalid", name: "架空 新人" }))).status, 403);
  assert.equal((await (await loadUser(m)).PATCH(json({ permission: "viewer" }, "PATCH"), params("u-luma"))).status, 403);
  assert.equal((await (await loadUser(m)).DELETE(del(), params("u-luma"))).status, 403);
  assert.equal((await (await loadInvites(m)).POST(json({ email: "inv@example.invalid" }))).status, 403);
  assert.equal(m.created.length + m.updated.length + m.memberUpdates.length + m.deleted.length + m.invites.length, 0);
});

test("管理者の判定は操作中の会社での権限: 全社共通では利用者でも、この会社の管理者ならこの会社のユーザーを変更できる", async () => {
  const m = setup({ as: "u-radmin", tenantId: OTHER });
  const res = await (await loadUser(m)).PATCH(json({ permission: "viewer" }, "PATCH"), params("u-other"));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(membership(m, "u-other", OTHER).permission, "viewer");
  const inv = await (await loadInvites(m)).POST(json({ email: "inv@example.invalid" }));
  assert.equal(inv.status, 200, JSON.stringify(await inv.clone().json()));
  assert.equal(m.invites[0].invitedById, "u-radmin");
});

test("PATCH /api/users/[id]: ほかの会社だけに所属するユーザーは 404 で、何も変えない", async () => {
  const m = setup();
  const res = await (await loadUser(m)).PATCH(json({ permission: "admin", email: "taken@example.invalid" }, "PATCH"), params("u-other"));
  assert.equal(res.status, 404);
  assert.equal(m.updated.length + m.memberUpdates.length, 0);
});

test("PATCH /api/users/[id]: ほかの会社にも所属するユーザーの権限・役職は、この会社の所属だけを変え、ほかの会社では変わらない", async () => {
  const m = setup({ as: "u-radmin", tenantId: OTHER });
  const res = await (await loadUser(m)).PATCH(json({ permission: "admin", role: "sales" }, "PATCH"), params("u-both"));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await res.json();
  assert.equal(body.user.permission, "admin");
  assert.equal(membership(m, "u-both", OTHER).permission, "admin");
  assert.equal(membership(m, "u-both", OTHER).role, "sales");
  assert.equal(membership(m, "u-both", LUMA).permission, "user", "Luma では利用者のまま");
  assert.equal(membership(m, "u-both", LUMA).role, "manager");
  assert.equal(user(m, "u-both").permission, "user", "全社共通の権限は変えない");
  assert.equal(user(m, "u-both").role, "manager");
  assert.ok(!m.updated.some((u) => "permission" in u.data || "role" in u.data));
});

test("PATCH /api/users/[id]: ほかの会社にも所属するユーザーのメールは変えない（409）。乗っ取りの経路を作らない", async () => {
  const m = setup({ as: "u-radmin", tenantId: OTHER });
  const res = await (await loadUser(m)).PATCH(json({ email: "attacker@example.invalid" }, "PATCH"), params("u-both"));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ほかの会社にも所属/);
  assert.equal(user(m, "u-both").email, "jiro@example.invalid");
  assert.equal(m.updated.length, 0);
  // 同じメールのまま（変更なし）なら通す
  assert.equal((await (await loadUser(m)).PATCH(json({ email: "jiro@example.invalid", name: "架空 次郎（改）" }, "PATCH"), params("u-both"))).status, 200);
});

test("PATCH /api/users/[id]: この会社だけに所属するユーザーは、所属と全社共通の権限・メールの両方を変える", async () => {
  const m = setup();
  const res = await (await loadUser(m)).PATCH(json({ permission: "viewer", email: "taro2@example.invalid" }, "PATCH"), params("u-luma"));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json()).user.permission, "viewer");
  assert.equal(membership(m, "u-luma", LUMA).permission, "viewer");
  assert.equal(user(m, "u-luma").permission, "viewer");
  assert.equal(user(m, "u-luma").email, "taro2@example.invalid");
});

test("PATCH /api/users/[id]: 全社統合ビューでは変更しない（会社を切り替えてから）", async () => {
  const m = setup({ tenantId: null });
  const res = await (await loadUser(m)).PATCH(json({ permission: "viewer" }, "PATCH"), params("u-luma"));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /全社統合ビュー/);
  assert.equal(m.updated.length + m.memberUpdates.length, 0);
});

test("DELETE /api/users/[id]: ほかの会社のユーザーは 404、ほかの会社にも所属するユーザーは 409 で削除しない", async () => {
  const m = setup();
  const route = await loadUser(m);
  assert.equal((await route.DELETE(del(), params("u-other"))).status, 404);
  const both = await route.DELETE(del(), params("u-both"));
  assert.equal(both.status, 409);
  assert.match((await both.json()).error, /ほかの会社にも所属/);
  assert.deepEqual(m.deleted, []);
  assert.equal(m.detached.length, 0);
  assert.equal((await route.DELETE(del(), params("u-luma"))).status, 200);
  assert.deepEqual(m.deleted, ["u-luma"]);
});

test("DELETE /api/users/[id]: 全社統合ビューでは削除しない", async () => {
  const m = setup({ tenantId: null });
  const res = await (await loadUser(m)).DELETE(del(), params("u-luma"));
  assert.equal(res.status, 403);
  assert.deepEqual(m.deleted, []);
});

test("招待: 一覧は会社の管理者なら全社統合ビューでも読めるが、発行・取消は全社統合ビューではしない", async () => {
  const cross = setup({ tenantId: null });
  const route = await loadInvites(cross);
  assert.equal((await route.GET()).status, 200);
  assert.equal((await route.POST(json({ email: "inv@example.invalid" }))).status, 403);
  assert.equal((await route.DELETE(new Request("http://offline.invalid/api/invites?id=x", { method: "DELETE" }))).status, 403);
  assert.equal(cross.invites.length, 0);
  // どの会社でも管理者でない人は、全社統合ビューでも一覧を読めない
  assert.equal((await (await loadInvites(setup({ as: "u-luma", tenantId: null }))).GET()).status, 403);
});

test("管理画面のユーザー一覧: 操作中の会社のユーザーを、その会社での権限・役職で読む。画面の入口も会社での権限で判定する", async () => {
  const lib = await offlineModule("src/lib/tenant-users.ts", setup(), boundaries, deps);
  const users = await lib.listCurrentTenantUsers({ id: true, permission: true, role: true }, {}, { tenantRoles: true });
  assert.deepEqual(ids(users), ["u-admin", "u-both", "u-gadmin", "u-luma"]);
  assert.equal(users.find((u) => u.id === "u-gadmin").permission, "user");
  const crossLib = await offlineModule("src/lib/tenant-users.ts", setup({ tenantId: null }), boundaries, deps);
  assert.deepEqual(ids(await crossLib.listCurrentTenantUsers({ id: true })), ["u-admin", "u-both", "u-gadmin", "u-luma", "u-other", "u-radmin"]);

  const access = async (opts) => (await offlineModule("src/lib/tenant-users.ts", setup(opts), boundaries, deps)).userAdminAccess();
  assert.deepEqual(JSON.parse(JSON.stringify(await access({}))), { allowed: true, readOnlyReason: null });
  assert.equal((await access({ as: "u-gadmin" })).allowed, false, "全社共通で admin でも、この会社で利用者なら入れない");
  const cross = await access({ tenantId: null });
  assert.equal(cross.allowed, true);
  assert.match(cross.readOnlyReason, /全社統合ビュー/);
  assert.equal((await access({ as: "u-luma", tenantId: null })).allowed, false);

  const page = await readFile(new URL("../src/app/(app)/admin/users/page.tsx", import.meta.url), "utf8");
  assert.match(page, /userAdminAccess\(\)/);
  assert.match(page, /tenantRoles: true/);
  assert.doesNotMatch(page, /prisma\.user\.findMany/);
  assert.doesNotMatch(page, /hasPermission\(me\?\.permission/);
});

test("権限を下げると会社の所属の権限も下がり、所属の書き込み権限を見る処理（runAsUserTenant の requireWrite）が止まる", async () => {
  const m = setup();
  const res = await (await loadUser(m)).PATCH(json({ permission: "viewer" }, "PATCH"), params("u-luma"));
  assert.equal(res.status, 200);
  // 実物の runAsUserTenant（src/lib/tenant-context.ts）を、同じ模擬 DB で u-luma として動かす
  const t = { prisma: m.prisma, session: { userId: "u-luma" } };
  t.prisma = { ...m.prisma, userTenant: { ...m.prisma.userTenant, findFirst: async ({ where }) => {
    const r = await m.prisma.userTenant.findFirst({ where: { userId: where.userId, tenantId: where.tenantId } });
    return r ? { ...r, tenant: { code: "luma", fiscalYearStartMonth: 6 } } : null;
  } } };
  const ctx = await offlineModule("src/lib/tenant-context.ts", t, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>mocks.session;",
    react: "export const cache=(fn)=>fn;",
    "next/headers": "export const cookies=async()=>({get:()=>undefined});",
  }, ["src/lib/tenant-context.ts"], ["node:async_hooks"]);
  let wrote = false;
  const result = await ctx.runAsUserTenant(LUMA, async () => { wrote = true; return "deal"; }, { requireWrite: true });
  assert.equal(result, null);
  assert.equal(wrote, false);
  // 読み取り（requireWrite なし）はこれまでどおり通る
  assert.equal(await ctx.runAsUserTenant(LUMA, async () => "read"), "read");
  const deals = await readFile(new URL("../src/app/api/deals/route.ts", import.meta.url), "utf8");
  assert.match(deals, /runAsUserTenant\([\s\S]{0,200}requireWrite: true/);
});
