// 全社統合ビューでは、ユーザーの追加・変更・削除と招待の発行をサーバーが 403 で止める。
// 画面でも操作を無効にして理由を出す（押しても何も起きないように見えないようにする）。
// あわせて、ユーザー管理の役職・権限の変更が失敗したときは、理由を画面に出す。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findAll, loadComponent, mountComponent, textOf } from "./helpers/component-harness.mjs";
import { offlineModule } from "./helpers/offline-module.mjs";

const REASON = "全社統合ビューではユーザーを追加・変更・削除できません。";
const USERS = [
  { id: "u-admin", name: "架空 管理", nameKana: null, email: "admin@example.invalid", role: "manager", permission: "admin", avatarColor: null },
  { id: "u-luma", name: "架空 太郎", nameKana: null, email: "taro@example.invalid", role: "sales", permission: "user", avatarColor: null },
];
const usersBundle = await loadComponent("src/components/admin/users-admin.tsx");
const invitesBundle = await loadComponent("src/components/admin/invites-admin.tsx");
const memberBundle = await loadComponent("src/components/team/new-member-dialog.tsx");

const selects = (tree) => findAll(tree, (n) => n.type === "Select");
const titled = (tree, title) => findAll(tree, (n) => n.props?.title === title);

test("ユーザー管理: 全社統合ビューでは、編集・役職・権限・削除の操作を無効にして理由を出す", async () => {
  const app = mountComponent(usersBundle, "UsersAdmin", { initial: USERS, currentUserId: "u-admin", readOnlyReason: REASON });
  await app.settle();
  const tree = app.tree();
  assert.match(textOf(tree), /全社統合ビューではユーザーを追加・変更・削除できません/);
  for (const title of ["氏名を編集", "フリガナ（カタカナ）を編集", "メールアドレスを編集"]) {
    assert.equal(titled(tree, title).length, 0, `${title} を出さない`);
  }
  assert.ok(selects(tree).length >= 4);
  for (const select of selects(tree)) assert.equal(select.props.disabled, true);
  const deletes = findAll(tree, (n) => n.type === "Button" && typeof n.props.title === "string" && textOf(n).includes("削除"));
  assert.ok(deletes.length >= 2);
  for (const button of deletes) {
    assert.equal(button.props.disabled, true);
    assert.equal(button.props.title, REASON);
  }
  assert.equal(app.requests.length, 0);
});

test("ユーザー管理: 役職・権限の変更が失敗したら、理由を画面に出す", async () => {
  const app = mountComponent(usersBundle, "UsersAdmin", { initial: USERS, currentUserId: "u-admin" }, (request) => {
    if (request.method === "PATCH") return Response.json({ error: "User not found" }, { status: 404 });
    return undefined;
  });
  await app.settle();
  const select = selects(app.tree()).find((n) => n.props.value === "user");
  assert.ok(select, "u-luma の権限");
  assert.notEqual(select.props.disabled, true);
  select.props.onValueChange("viewer");
  await app.settle();
  assert.equal(app.requests.filter((r) => r.method === "PATCH").length, 1);
  assert.match(textOf(app.tree()), /User not found/);
});

test("招待管理: 全社統合ビューでは、招待URLの発行・再発行・取消を無効にして理由を出す", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const app = mountComponent(invitesBundle, "InvitesAdmin", { readOnlyReason: REASON }, (request) => {
    if (request.method === "GET") {
      return Response.json({ invites: [{ id: "i1", email: "new@example.invalid", name: null, role: "sales", permission: "user", used: false, expiresAt: future, createdAt: future, usedAt: null }] });
    }
    return undefined;
  });
  await app.settle();
  const tree = app.tree();
  assert.match(textOf(tree), /全社統合ビューではユーザーを追加・変更・削除できません/);
  const issue = findAll(tree, (n) => n.type === "Button" && textOf(n).includes("招待URLを発行"))[0];
  assert.ok(issue);
  assert.equal(issue.props.disabled, true);
  for (const title of ["同じ条件で再発行（期限を更新）", "招待を取消"]) {
    const button = titled(tree, title)[0];
    assert.ok(button, title);
    assert.equal(button.props.disabled, true, title);
  }
});

test("メンバー追加（チーム画面）: 全社統合ビューでは、追加ボタンを無効にして理由を出す", async () => {
  const app = mountComponent(memberBundle, "NewMemberDialog", { disabledReason: REASON });
  await app.settle();
  const tree = app.tree();
  const button = findAll(tree, (n) => n.type === "Button" && textOf(n).includes("メンバー追加"))[0];
  assert.ok(button);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, REASON);
});

test("画面: 管理画面・チーム画面は、全社統合ビューのときだけ理由を渡す", async () => {
  const LUMA = "11111111-1111-4111-8111-111111111111";
  const load = (ctx) => offlineModule("src/lib/tenant-users.ts", {
    ctx, env: { NODE_ENV: "development" }, session: { userId: "u-admin" },
    prisma: { userTenant: { findFirst: async () => ({ userId: "u-admin" }) } },
  }, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>mocks.session;",
    "@/lib/tenant-context": `export const currentTenant=()=>mocks.ctx??undefined;export const getRequestTenant=async()=>null;export const currentTenantId=()=>"${LUMA}";`,
  }, ["src/lib/tenant-users.ts", "src/lib/tenant-user-admin.ts"]);
  const cross = await load({ tenantId: null, userId: "u-admin", permission: "viewer", crossTenant: true });
  assert.match((await cross.userAdminAccess()).readOnlyReason, /全社統合ビュー/);
  const luma = await load({ tenantId: LUMA, userId: "u-admin", permission: "admin", crossTenant: false });
  assert.equal((await luma.userAdminAccess()).readOnlyReason, null);

  const admin = await readFile(new URL("../src/app/(app)/admin/users/page.tsx", import.meta.url), "utf8");
  assert.match(admin, /userAdminAccess\(\)/);
  assert.match(admin, /<UsersAdmin[^>]*readOnlyReason=\{readOnlyReason\}/);
  assert.match(admin, /<InvitesAdmin[^>]*readOnlyReason=\{readOnlyReason\}/);
  const team = await readFile(new URL("../src/app/(app)/team/page.tsx", import.meta.url), "utf8");
  assert.match(team, /<NewMemberDialog disabledReason=\{/);
});

test("ユーザー管理: 狭い幅（390px）でも崩れない。名前の欄は縮みすぎず、役職・権限・削除は折り返して全部見える", async () => {
  const app = mountComponent(usersBundle, "UsersAdmin", { initial: USERS, currentUserId: "u-admin" });
  await app.settle();
  const tree = app.tree();
  const cls = (n) => String(n.props.className ?? "");
  const rows = findAll(tree, (n) => n.type === "div" && /\bpy-3\b/.test(cls(n)) && findAll(n.props.children, (c) => c.type === "Select").length > 0);
  assert.equal(rows.length, USERS.length);
  for (const row of rows) {
    assert.match(cls(row), /\bflex-wrap\b/, "行は折り返す");
    const info = findAll(row.props.children, (n) => n.type === "div" && /\bflex-1\b/.test(cls(n)))[0];
    assert.ok(info);
    assert.match(cls(info), /\bbasis-48\b/, "名前の欄は最低 12rem を確保（縦に折れない）");
    const actions = findAll(row.props.children, (n) => n.type === "div" && findAll(n.props.children, (c) => c.type === "Select").length === 2
      && findAll(n.props.children, (c) => c.type === "Button" && textOf(c).includes("削除")).length === 1)[0];
    assert.ok(actions, "役職・権限・削除を1つの欄にまとめる");
    assert.match(cls(actions), /\bw-full\b/);
    assert.match(cls(actions), /\bsm:w-auto\b/);
    assert.match(cls(actions), /\bflex-wrap\b/);
    for (const trigger of findAll(actions.props.children, (c) => c.type === "SelectTrigger")) {
      assert.doesNotMatch(cls(trigger), /(^|\s)w-36\b/, "狭い幅では選択欄を細くする");
    }
  }
});
