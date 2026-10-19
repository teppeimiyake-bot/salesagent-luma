import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

// T14: 発行者設定の API。管理画面（/admin/quote-settings）が PATCH し、見積作成画面が defaults を読む。
const SETTINGS = "src/app/api/admin/quote-settings/route.ts";
const DEFAULTS = "src/app/api/admin/quote-settings/defaults/route.ts";
const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getCurrentPermission=async()=>mocks.permission;export const hasPermission=(p,r)=>({viewer:1,user:2,admin:3}[p??'viewer']??0)>=({viewer:1,user:2,admin:3}[r]);",
  "@/lib/feature-flags": "export const isQuotePdfV2Enabled=()=>mocks.v2!==false;",
  "@/lib/tenant-context": "export const getRequestTenant=async()=>mocks.tenantCtx;",
  // ロゴの取得（外部へ出ない偽物。取得できた扱い）。取れないときの動きは t14-quote-logo.test.mjs。
  "@/lib/quote-logo": "export const LOGO_SAVE_TIMEOUT_MS=5000;export const fetchQuoteLogo=async()=>({ok:true,dataUrl:'data:image/png;base64,iVBORw0KGgo='});",
};

const TENANTS = { "tenant-luma": { name: "株式会社Luma", code: "luma" }, "tenant-reagey": { name: "株式会社リージー", code: "reagey" } };

function state({ profile = {}, issued = 0, permission = "admin" } = {}) {
  const s = {
    permission, v2: true, issued, updates: [], creates: [], reads: [],
    tenantCtx: { tenantId: "tenant-luma", crossTenant: false },
    // 読み取りの直後に割り込む処理（採番の競合を再現する）
    afterRead: null,
    profile: profile === null ? null : {
      id: "profile", tenantId: "tenant-luma", legalName: "株式会社Luma", postalCode: "170-0013",
      addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F", logoUrl: null,
      defaultNotes: "標準1\n標準2", travelExpenseNote: "交通費A\n交通費B", numberPrefix: "L", nextQuoteNumber: 12, ...profile,
    },
  };
  // where が無い読み取りは、全社統合ビューで tenant 条件が付かないときと同じく、どの会社の行でも返す
  const matches = (where = {}) => !!s.profile
    && (where.tenantId === undefined || where.tenantId === s.profile.tenantId)
    && (where.id === undefined || where.id === s.profile.id)
    && (where.nextQuoteNumber === undefined || where.nextQuoteNumber === s.profile.nextQuoteNumber);
  s.prisma = {
    quoteIssuerProfile: {
      findFirst: async (args = {}) => {
        s.reads.push(JSON.parse(JSON.stringify(args)));
        const row = matches(args.where) ? { ...s.profile } : null;
        s.afterRead?.();
        return row;
      },
      create: async ({ data }) => { s.creates.push(data); s.profile = { id: "created", nextQuoteNumber: 1, ...data }; return { ...s.profile }; },
      update: async ({ where, data }) => { s.updates.push({ where, data }); Object.assign(s.profile, data); return { ...s.profile }; },
      // 条件付き更新（UPDATE … WHERE id = ? AND next_quote_number = ?）。条件に合わなければ 0 件
      updateMany: async ({ where, data }) => {
        s.updates.push({ where, data });
        if (!matches(where)) return { count: 0 };
        Object.assign(s.profile, data);
        return { count: 1 };
      },
    },
    quoteTemplate: { findMany: async () => [] },
    // 発行済み＝番号が付いた見積（VM 内のオブジェクトなので JSON で比べる）
    quote: {
      count: async ({ where }) => {
        assert.equal(JSON.stringify(where), JSON.stringify({ quoteNumber: { not: null } }));
        const issuedNow = s.issued;
        s.afterRead?.();
        return issuedNow;
      },
    },
    tenant: {
      findFirst: async () => ({ id: "tenant-luma", ...TENANTS["tenant-luma"] }),
      findUnique: async ({ where }) => TENANTS[where.id] ?? null,
    },
  };
  return s;
}
/** 見積が1件発行される（採番が1つ進む）。発行者設定の保存と同時に起きたときの再現用。 */
const issueOne = (s) => { s.profile.nextQuoteNumber += 1; s.issued += 1; s.afterRead = null; };
const CROSS_TENANT = { tenantId: null, code: "__all__", crossTenant: true };

const body = (patch = {}) => ({
  legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F",
  logoUrl: null, defaultNotes: "標準1\n標準2", travelExpenseNote: "交通費A\n交通費B", numberPrefix: "L", ...patch,
});
const patch = (route, payload) => route.PATCH(new Request("http://offline.invalid/api/admin/quote-settings", { method: "PATCH", body: JSON.stringify(payload) }));
const loadSettings = (s) => offlineModule(SETTINGS, s, boundaries, [SETTINGS, "src/lib/quote-issuer-server.ts", "src/lib/quote-issuer.ts"]);
const loadDefaults = (s) => offlineModule(DEFAULTS, s, boundaries, [DEFAULTS, "src/lib/quote-issuer-server.ts", "src/lib/quote-issuer.ts", "src/lib/quote-notes.ts"]);

test("T14 quote settings stay admin-only", async () => {
  const s = state({ permission: "user" });
  const route = await loadSettings(s);
  assert.equal((await route.GET()).status, 403);
  assert.equal((await patch(route, body())).status, 403);
  assert.equal(s.updates.length, 0);
});

test("T14 quote settings accept only https or PNG/JPEG data URLs as the logo", async () => {
  const s = state();
  const route = await loadSettings(s);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
  for (const logoUrl of ["https://example.com/logo.png", png, "data:image/jpeg;base64,/9j/4AAQ", null]) {
    const response = await patch(route, body({ logoUrl }));
    assert.equal(response.status, 200, String(logoUrl).slice(0, 40));
    assert.equal(s.profile.logoUrl, logoUrl);
  }
  const rejected = [
    "javascript:alert(1)", "http://example.com/logo.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+",
    "not a url", `data:image/png;base64,${"A".repeat(400_000)}`,
  ];
  for (const logoUrl of rejected) {
    const response = await patch(route, body({ logoUrl }));
    assert.equal(response.status, 400, logoUrl.slice(0, 40));
    assert.match((await response.json()).error, /https のURLか PNG\/JPEG/);
  }
  assert.equal(s.updates.length, 4);
});

test("T14 the next quote number (start number) changes only when sent, and cannot go back once numbers were issued", async () => {
  const s = state({ issued: 3 });
  const route = await loadSettings(s);
  assert.equal((await patch(route, body())).status, 200);
  assert.equal("nextQuoteNumber" in s.updates[0].data, false, "an untouched form does not overwrite the counter");
  assert.equal((await patch(route, body({ nextQuoteNumber: 958 }))).status, 200);
  assert.equal(s.profile.nextQuoteNumber, 958);
  const lowered = await patch(route, body({ nextQuoteNumber: 5 }));
  assert.equal(lowered.status, 409);
  assert.match((await lowered.json()).error, /現在の値（958）より小さくできません/);
  assert.equal(s.profile.nextQuoteNumber, 958);
  for (const nextQuoteNumber of [0, 1.5, "10"]) assert.equal((await patch(route, body({ nextQuoteNumber }))).status, 400, String(nextQuoteNumber));

  const fresh = state({ issued: 0, profile: { nextQuoteNumber: 40 } });
  const freshRoute = await loadSettings(fresh);
  assert.equal((await patch(freshRoute, body({ nextQuoteNumber: 1 }))).status, 200, "before the first issue the start number can be reset");
  assert.equal(fresh.profile.nextQuoteNumber, 1);
});

test("T14 quote defaults: sales users read the issuer and note presets from the settings, without numbering internals", async () => {
  const s = state({ permission: "user", profile: { logoUrl: "https://example.com/logo.png" } });
  const route = await loadDefaults(s);
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    issuer: { legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F", logoUrl: "https://example.com/logo.png" },
    notes: { standard: ["標準1", "標準2"], travel: ["交通費A", "交通費B"] },
    canManage: false,
  });
  s.permission = "admin";
  assert.equal((await (await route.GET()).json()).canManage, true);
  s.permission = "viewer";
  assert.equal((await route.GET()).status, 403);
  s.permission = "user";
  s.v2 = false;
  assert.equal((await route.GET()).status, 404);
});

test("T14 quote defaults before the first issue: the tenant's initial values with the sample notes, without creating a row", async () => {
  const s = state({ permission: "user", profile: null });
  const route = await loadDefaults(s);
  const json = await (await route.GET()).json();
  assert.equal(json.issuer.legalName, "株式会社Luma");
  assert.equal(json.issuer.addressLine2, "2-7-3 柄澤ビル3F");
  assert.deepEqual(json.notes.standard, ["※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。", "※消費税はご契約日時点での税率となります。"]);
  assert.equal(json.notes.travel.length, 2);
  assert.equal(s.updates.length, 0);
  s.tenantCtx = { tenantId: null, crossTenant: true };
  const crossTenant = await (await route.GET()).json();
  assert.equal(crossTenant.issuer, null, "the all-company view has no single issuer");
  assert.equal(crossTenant.notes.standard.length, 2);
});

test("T14 quote settings in the all-company view: nothing is read from another company's row and nothing is written", async () => {
  // 全社統合ビューでは tenant 条件が付かないため、findFirst() は Luma かリージーのどちらかの行を返してしまう
  const s = state();
  s.tenantCtx = CROSS_TENANT;
  const settings = await loadSettings(s);
  const get = await settings.GET();
  assert.equal(get.status, 409);
  assert.match((await get.json()).error, /会社（Luma \/ リージー）を切り替えて/);
  const patched = await patch(settings, body({ legalName: "上書き株式会社", nextQuoteNumber: 99 }));
  assert.equal(patched.status, 409);
  assert.match((await patched.json()).error, /全社統合ビューでは発行者設定を扱えません/);
  assert.deepEqual([s.updates, s.creates], [[], []], "no write is attempted");
  assert.equal(s.profile.legalName, "株式会社Luma");

  const defaults = await loadDefaults(s);
  s.permission = "user";
  const json = await (await defaults.GET()).json();
  assert.equal(json.issuer, null, "the all-company view shows no company's issuer");
  assert.deepEqual(json.notes.standard, ["※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。", "※消費税はご契約日時点での税率となります。"], "the sample notes, not another company's");
  assert.deepEqual(s.reads, [], "the issuer table is not read without a single company");

  s.tenantCtx = { tenantId: null, crossTenant: false };
  assert.equal((await (await defaults.GET()).json()).issuer, null, "no tenant at all behaves the same");
  s.permission = "admin";
  assert.equal((await patch(settings, body())).status, 409);
  assert.deepEqual(s.reads, []);
});

test("T14 quote settings read and create the row of the active company only", async () => {
  const s = state();
  s.tenantCtx = { tenantId: "tenant-reagey", code: "reagey", crossTenant: false };
  const defaults = await loadDefaults(s);
  s.permission = "user";
  const json = await (await defaults.GET()).json();
  assert.equal(json.issuer.legalName, "株式会社リージー", "Luma's row is not used for リージー");
  assert.deepEqual(s.reads.map((r) => r.where), [{ tenantId: "tenant-reagey" }]);

  s.permission = "admin";
  const settings = await loadSettings(s);
  assert.equal((await settings.GET()).status, 404, "リージー has no settings yet");
  const saved = await patch(settings, body({ legalName: "株式会社リージー", numberPrefix: "R" }));
  assert.equal(saved.status, 200);
  assert.equal(s.creates.length, 1);
  assert.equal(s.creates[0].tenantId, "tenant-reagey", "the row is created for the active company, not the first one");
  assert.equal(s.profile.numberPrefix, "R");
});

test("T14 the start number is written only if no quote was issued between the check and the write", async () => {
  // 管理者が保存するのと同時に見積が発行され、採番が 12 → 13 に進んだ場合（12 は発行済み）
  const same = state({ issued: 3 });
  const route = await loadSettings(same);
  same.afterRead = () => issueOne(same);
  const conflict = await patch(route, body({ nextQuoteNumber: 12 }));
  assert.equal(conflict.status, 409, "writing 12 back would issue L-…-0012 twice");
  assert.match((await conflict.json()).error, /次の番号が変わりました。画面を再読み込み/);
  assert.equal(same.profile.nextQuoteNumber, 13, "the counter advanced by the issue is kept");
  assert.deepEqual(JSON.parse(JSON.stringify(same.updates.at(-1).where)), { id: "profile", nextQuoteNumber: 12 }, "a single conditional update");

  // 発行前は開始番号を下げられるが、確認（発行0件）の直後に最初の見積が発行されたら書き換えない
  const fresh = state({ issued: 0, profile: { nextQuoteNumber: 40 } });
  const freshRoute = await loadSettings(fresh);
  // 1回目の読み取り（行の取得）では割り込まず、発行済み件数の確認の直後に割り込む
  let calls = 0;
  fresh.afterRead = () => { calls += 1; if (calls === 2) issueOne(fresh); };
  const lowered = await patch(freshRoute, body({ nextQuoteNumber: 1 }));
  assert.equal(lowered.status, 409);
  assert.equal(fresh.profile.nextQuoteNumber, 41);

  // 競合が無ければ、そのまま保存して保存後の行を返す
  const calm = state({ issued: 3 });
  const calmRoute = await loadSettings(calm);
  const raised = await patch(calmRoute, body({ nextQuoteNumber: 500, legalName: "株式会社Luma（本社）" }));
  assert.equal(raised.status, 200);
  const saved = (await raised.json()).profile;
  assert.equal(saved.nextQuoteNumber, 500);
  assert.equal(saved.legalName, "株式会社Luma（本社）");
});

// ---- 管理画面 /admin/quote-settings（Server Component）----
// 実物のページを esbuild で束ね、UI部品・DB・セッションだけ差し替えて描画結果（要素の木）を調べる。
const PAGE = "src/app/(app)/admin/quote-settings/page.tsx";
const pageStubs = {
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const redirect=(to)=>{throw Object.assign(new Error('redirect'),{to});};",
  "@/components/layout/header": "export const Header=(props)=>({type:'Header',props});",
  "@/components/ui/card": "export const Card=(props)=>({type:'Card',props});export const CardContent=(props)=>({type:'CardContent',props});",
  "@/components/ui/badge": "export const Badge=(props)=>({type:'Badge',props});",
  "@/components/admin/quote-settings-form": "export const QuoteSettingsForm=(props)=>({type:'QuoteSettingsForm',props});",
  ...boundaries,
  "@/lib/auth": `${boundaries["@/lib/auth"]}export const getSession=async()=>({userId:'admin-user'});`,
};
async function loadPage(mocks) {
  const { build } = await import("esbuild");
  const path = await import("node:path");
  const vm = await import("node:vm");
  const root = path.resolve(import.meta.dirname, "..");
  const real = new Set(["@/lib/quote-issuer-server", "@/lib/quote-issuer"]);
  const code = (await build({
    absWorkingDir: root, entryPoints: [PAGE], bundle: true, write: false, format: "cjs", platform: "neutral", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "t14-page", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(root, a.path) };
        if (a.path in pageStubs) return { path: a.path, namespace: "stub" };
        if (real.has(a.path)) return { path: path.join(root, "src", `${a.path.slice(2)}.ts`) };
        return { errors: [{ text: `Unexpected dependency of ${PAGE}: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: pageStubs[a.path], loader: "js" }));
    } }],
  })).outputFiles[0].text;
  const loaded = { exports: {} };
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, mocks, process: { env: {} } });
  return loaded.exports.default;
}
function pageTree(node) {
  if (node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(pageTree);
  if (typeof node.type === "function") return pageTree(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: pageTree(node.props?.children) } };
}
const pageText = (node) => (node === null || node === undefined || typeof node === "boolean" ? ""
  : Array.isArray(node) ? node.map(pageText).join("") : typeof node === "object" ? pageText(node.props?.children) : String(node));
function pageFind(node, type, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) { for (const child of node) pageFind(child, type, found); return found; }
  if (node.type === type) found.push(node);
  return pageFind(node.props?.children, type, found);
}

test("T14 the settings page in the all-company view asks to switch the company and shows no form (so nothing can be saved there)", async () => {
  const s = state();
  s.prisma.user = { findUnique: async () => ({ permission: "admin" }) };
  s.prisma.quote.count = async () => 7;
  const Page = await loadPage(s);

  const luma = pageTree(await Page());
  const forms = pageFind(luma, "QuoteSettingsForm");
  assert.equal(forms.length, 1, "a single company gets the form");
  assert.equal(forms[0].props.initial.legalName, "株式会社Luma");
  assert.equal(forms[0].props.saved, true);
  assert.equal(forms[0].props.hasIssuedNumbers, true);

  s.tenantCtx = CROSS_TENANT;
  s.reads.length = 0;
  const all = pageTree(await Page());
  assert.equal(pageFind(all, "QuoteSettingsForm").length, 0, "no form, so no PATCH can be sent from the all-company view");
  assert.match(pageText(all), /会社（Luma \/ リージー）を切り替えてから開いてください。全社統合ビューでは設定できません。/);
  assert.doesNotMatch(pageText(all), /保存/);
  assert.deepEqual(s.reads, [], "another company's row is not read");
  assert.deepEqual([s.updates, s.creates], [[], []]);
});
