// 招待・自己登録で作ったユーザーに、会社の所属（user_tenants）を作る。
// 所属が無いと、会社ごとに絞った担当者一覧・管理画面のユーザー一覧に出ない。
// 招待は、招待の会社（invites.tenant_id）に所属させる。ログイン前（セッションが無い）でも、
// Luma 以外の会社の招待を見つけられること。DB は模擬する（架空のユーザーのみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { offlineModule } from "./helpers/offline-module.mjs";

const LUMA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const plain = (v) => JSON.parse(JSON.stringify(v));

function setup({ env = { NODE_ENV: "development" }, invites = [], users = [], memberships = [] } = {}) {
  const m = { env, invites: structuredClone(invites), users: structuredClone(users), memberships: structuredClone(memberships), upserts: [], cookies: 0 };
  const userClient = {
    findUnique: async ({ where }) => m.users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
    create: async ({ data }) => {
      const { userTenants, ...rest } = data;
      const u = { id: `u-new-${m.users.length + 1}`, permission: "user", role: "sales", ...rest };
      m.users.push(u);
      if (userTenants?.create) m.memberships.push({ userId: u.id, ...userTenants.create });
      return u;
    },
  };
  const membershipClient = {
    count: async ({ where }) => m.memberships.filter((r) => r.userId === where.userId).length,
    upsert: async ({ where, create }) => {
      m.upserts.push(plain({ where, create }));
      const key = where.userId_tenantId;
      const found = m.memberships.find((r) => r.userId === key.userId && r.tenantId === key.tenantId);
      if (found) return found;
      m.memberships.push(create);
      return create;
    },
  };
  const inviteUnscoped = {
    findUnique: async ({ where }) => m.invites.find((i) => i.token === where.token) ?? null,
    findFirst: async ({ where }) => m.invites.find((i) => i.email === where.email && !i.used) ?? null,
    update: async ({ where, data }) => Object.assign(m.invites.find((i) => i.id === where.id), data),
  };
  // 招待の会社が有効か（先方の登録・招待確認の前提チェック）。テストの会社はどれも有効。
  const tenantUnscoped = { findUnique: async ({ where }) => ({ id: where.id, active: true, code: where.id, name: where.id, shortName: where.id }) };
  const unscoped = { user: userClient, userTenant: membershipClient, invite: inviteUnscoped, tenant: tenantUnscoped };
  unscoped.$transaction = async (fn) => fn(unscoped);
  m.prismaUnscoped = unscoped;
  // 業務用（テナント境界つき）のクライアント：ログイン前は既定の会社（Luma）として扱われ、ほかの会社の招待は見えない
  m.prisma = {
    user: userClient,
    userTenant: membershipClient,
    invite: {
      findUnique: async (a) => { const i = await inviteUnscoped.findUnique(a); return i && i.tenantId === LUMA ? i : null; },
      update: inviteUnscoped.update,
    },
    $transaction: async (fn) => fn(m.prisma),
  };
  return m;
}

const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;export const prismaUnscoped=mocks.prismaUnscoped;",
  "@/lib/auth": "export const createSessionToken=async()=>'token';export const hashPassword=async()=>'hash';export const setSessionCookie=async()=>{mocks.cookies++;};",
  "@/lib/tenant-context": `export const currentTenantId=()=>"${LUMA}";`,
};
const deps = ["src/lib/invite-membership.ts", "src/lib/self-registration.ts", "src/lib/email.ts"];
const loadRegister = (m) => offlineModule("src/app/api/auth/register/route.ts", m, boundaries, ["src/app/api/auth/register/route.ts", ...deps]);
const post = (body) => new Request("http://offline.invalid/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const future = new Date(Date.now() + 86_400_000);
const reageyInvite = { id: "inv-1", token: "tok-r", tenantId: OTHER, email: "new@example.invalid", name: "架空 新人", role: "manager", permission: "viewer", used: false, expiresAt: future };

test("招待で登録: 招待の会社（Luma 以外も）に、招待の権限・役職で所属させ、招待を使用済みにする", async () => {
  const m = setup({ invites: [reageyInvite] });
  const res = await (await loadRegister(m)).POST(post({ inviteToken: "tok-r", password: "password123" }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const user = m.users.find((u) => u.email === "new@example.invalid");
  assert.ok(user);
  assert.deepEqual(plain(m.memberships.filter((r) => r.userId === user.id)), [
    { userId: user.id, tenantId: OTHER, permission: "viewer", role: "manager", isDefault: true },
  ]);
  assert.equal(m.invites[0].used, true);
});

test("招待で登録: 所属が既にあれば作り直さない（upsert・update は空）", async () => {
  const lib = await offlineModule("src/lib/invite-membership.ts", setup(), boundaries, deps);
  const m = setup({ memberships: [{ userId: "u-1", tenantId: OTHER, permission: "admin", role: "sales", isDefault: true }] });
  const libM = await offlineModule("src/lib/invite-membership.ts", m, boundaries, deps);
  assert.equal(typeof lib.ensureTenantMembership, "function");
  await libM.ensureTenantMembership(m.prismaUnscoped, { userId: "u-1", tenantId: OTHER, permission: "viewer", role: "manager" });
  assert.equal(m.memberships.length, 1);
  assert.equal(m.memberships[0].permission, "admin", "既存の所属の権限は変えない");
  assert.deepEqual(m.upserts[0].where, { userId_tenantId: { userId: "u-1", tenantId: OTHER } });
});

test("招待なしの自己登録: 既定では受け付けない（403「招待URLから登録してください」）。ユーザーも所属も作らない", async () => {
  const m = setup();
  const res = await (await loadRegister(m)).POST(post({ email: "self@example.invalid", password: "password123" }));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /招待URLから登録してください/);
  assert.equal(m.users.length, 0);
  assert.equal(m.memberships.length, 0);
  assert.equal(m.cookies, 0);
});

test("招待なしの自己登録: ALLOW_SELF_REGISTRATION=1 のときだけ、移行期は既定の会社（Luma）に所属させる", async () => {
  const m = setup({ env: { NODE_ENV: "development", ALLOW_SELF_REGISTRATION: "1" } });
  const res = await (await loadRegister(m)).POST(post({ email: "self@example.invalid", password: "password123" }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const user = m.users.find((u) => u.email === "self@example.invalid");
  assert.deepEqual(plain(m.memberships.filter((r) => r.userId === user.id).map((r) => r.tenantId)), [LUMA]);
});

test("招待なしの自己登録: TENANT_STRICT=1 では、許可していても会社が決まらないので登録しない", async () => {
  const m = setup({ env: { NODE_ENV: "development", TENANT_STRICT: "1", ALLOW_SELF_REGISTRATION: "1" } });
  const res = await (await loadRegister(m)).POST(post({ email: "self@example.invalid", password: "password123" }));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /招待/);
  assert.equal(m.users.length, 0);
  assert.equal(m.cookies, 0);
});

test("招待URLの確認（GET /api/invites/[token]）: ログイン前でも Luma 以外の会社の招待を見つける", async () => {
  const m = setup({ invites: [reageyInvite] });
  const entry = "src/app/api/invites/[token]/route.ts";
  const route = await offlineModule(entry, m, boundaries, [entry, "src/lib/email.ts"]);
  const res = await route.GET(new Request("http://offline.invalid"), { params: Promise.resolve({ token: "tok-r" }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).invite.email, "new@example.invalid");
});

test("Google ログインの招待（src/auth.ts）も、同じ処理で招待の会社に所属させる", async () => {
  const source = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8");
  assert.match(source, /createInvitedUser\(prisma, invite,/);
  assert.doesNotMatch(source, /prisma\.user\.create\(/);
});

test("登録画面向けの案内（GET /api/auth/providers-info）: 招待なしの登録を受け付けるかを返す（既定は受け付けない）", async () => {
  const entry = "src/app/api/auth/providers-info/route.ts";
  const load = (env) => offlineModule(entry, { env }, { "@/auth": "export const isGoogleAuthEnabled=false;" }, [entry, "src/lib/self-registration.ts"]);
  assert.deepEqual(await (await (await load({ NODE_ENV: "development" })).GET()).json(), { google: false, selfRegistration: false });
  assert.equal((await (await (await load({ NODE_ENV: "development", ALLOW_SELF_REGISTRATION: "1" })).GET()).json()).selfRegistration, true);
  assert.equal((await (await (await load({ NODE_ENV: "development", ALLOW_SELF_REGISTRATION: "1", TENANT_STRICT: "1" })).GET()).json()).selfRegistration, false);
});
