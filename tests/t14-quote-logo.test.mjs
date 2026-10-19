import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";
import { loadFinalize, finalize } from "./helpers/t14-harness.mjs";

// T14（2026-10-01 UI確認 MX-05/06）：発行者設定のロゴに到達できない https のURLを入れても、保存も発行も
// 黙って通り、PDF を開くまでロゴが無いことに気づけなかった（404 では発行に11.2秒）。
// サーバーからロゴを取りに行くときは SSRF にならないよう、https・公開アドレスだけ・リダイレクト先も確かめる。
const require = createRequire(import.meta.url);
const logo = require("../src/lib/quote-logo.ts");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const PUBLIC = async () => [{ address: "93.184.215.14", family: 4 }];

/** 偽の取得処理。URLごとに応答を決め、呼ばれたURLを記録する（外部へは出ない）。 */
function fakeRequest(routes) {
  const calls = [];
  const request = async (url, init) => {
    calls.push(url.toString());
    const route = routes[url.toString()];
    if (!route) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    if (route === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    const body = route.body ?? Buffer.alloc(0);
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body: (async function* () { yield body; })(),
    };
  };
  return { request, calls };
}

test("T14 logo fetch: blocks non-https and internal addresses before connecting", async () => {
  const { request, calls } = fakeRequest({});
  for (const url of [
    "http://example.com/logo.png",
    "https://localhost/logo.png",
    "https://foo.localhost/logo.png",
    "https://127.0.0.1/logo.png",
    "https://10.0.0.5/logo.png",
    "https://172.16.3.4/logo.png",
    "https://192.168.1.10/logo.png",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/logo.png",
    "https://0.0.0.0/logo.png",
    "https://[::1]/logo.png",
    "https://[fd00::1]/logo.png",
    "https://[fe80::1]/logo.png",
    "https://[::ffff:127.0.0.1]/logo.png",
    "https://[::ffff:a9fe:a9fe]/logo.png",
    "https://user:pass@example.com/logo.png",
    "https://example.com:8443/logo.png",
  ]) {
    const result = await logo.fetchQuoteLogo(url, { timeoutMs: 1000, request, resolve: PUBLIC });
    assert.equal(result.ok, false, url);
  }
  assert.deepEqual(calls, [], "nothing is requested for blocked targets");
  for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700::1111"]) assert.equal(logo.isBlockedAddress(ip), false, ip);
  for (const ip of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "::1", "::ffff:10.0.0.1", "fc00::1", "224.0.0.1", "::", "3fff::1", "5f00::1"]) {
    assert.equal(logo.isBlockedAddress(ip), true, ip);
  }
});

test("T14 logo fetch: a host name that resolves to an internal address is refused at connect time", async () => {
  const resolved = [];
  const resolve = async (host) => { resolved.push(host); return [{ address: "169.254.169.254", family: 4 }]; };
  // 既定の取得処理（node:https）を使い、接続先の名前解決で内部アドレスを断ることを確かめる（外へは出ない）。
  const result = await logo.fetchQuoteLogo("https://metadata.example.test/logo.png", { timeoutMs: 2000, resolve });
  assert.equal(result.ok, false);
  assert.match(result.reason, /内部/);
  assert.deepEqual(resolved, ["metadata.example.test"]);
  const mixed = async () => [{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.1", family: 4 }];
  const mixedResult = await logo.fetchQuoteLogo("https://mixed.example.test/logo.png", { timeoutMs: 2000, resolve: mixed });
  assert.equal(mixedResult.ok, false);
  assert.match(mixedResult.reason, /内部/);
});

test("T14 logo fetch: PNG/JPEG becomes a data URL; 404, non-images, oversize and unresolvable hosts fail with a reason", async () => {
  const { request } = fakeRequest({
    "https://cdn.example.com/logo.png": { body: PNG, headers: { "content-type": "image/png" } },
    "https://cdn.example.com/logo.jpg": { body: JPEG, headers: { "content-type": "image/jpeg" } },
    "https://cdn.example.com/missing.png": { status: 404, body: Buffer.from("not found") },
    "https://cdn.example.com/page.html": { body: Buffer.from("<html></html>"), headers: { "content-type": "text/html" } },
    "https://cdn.example.com/logo.svg": { body: Buffer.from("<svg/>"), headers: { "content-type": "image/svg+xml" } },
    "https://cdn.example.com/huge.png": { body: Buffer.concat([PNG, Buffer.alloc(logo.MAX_LOGO_BYTES)]) },
    "https://cdn.example.com/huge-declared.png": { body: PNG, headers: { "content-length": String(logo.MAX_LOGO_BYTES + 1) } },
  });
  const options = { timeoutMs: 1000, request, resolve: PUBLIC };
  const png = await logo.fetchQuoteLogo("https://cdn.example.com/logo.png", options);
  assert.equal(png.ok, true);
  assert.equal(png.dataUrl, `data:image/png;base64,${PNG.toString("base64")}`);
  const jpeg = await logo.fetchQuoteLogo("https://cdn.example.com/logo.jpg", options);
  assert.equal(jpeg.ok, true);
  assert.match(jpeg.dataUrl, /^data:image\/jpeg;base64,/);

  const expectations = {
    "https://cdn.example.com/missing.png": /404/,
    "https://cdn.example.com/page.html": /PNG か JPEG/,
    "https://cdn.example.com/logo.svg": /PNG か JPEG/,
    "https://cdn.example.com/huge.png": /大きすぎ/,
    "https://cdn.example.com/huge-declared.png": /大きすぎ/,
    "https://logo.uicheck-20261001-mx.invalid/logo.png": /見つかりません/,
  };
  for (const [url, reason] of Object.entries(expectations)) {
    const result = await logo.fetchQuoteLogo(url, options);
    assert.equal(result.ok, false, url);
    assert.match(result.reason, reason, url);
  }
});

test("T14 logo fetch: redirects are followed only to public https targets, a few times at most", async () => {
  const { request, calls } = fakeRequest({
    "https://a.example.com/logo.png": { status: 302, headers: { location: "/real/logo.png" } },
    "https://a.example.com/real/logo.png": { body: PNG },
    "https://b.example.com/logo.png": { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data/" } },
    "https://c.example.com/logo.png": { status: 302, headers: { location: "http://c.example.com/logo.png" } },
    "https://d.example.com/0": { status: 302, headers: { location: "/1" } },
    "https://d.example.com/1": { status: 302, headers: { location: "/2" } },
    "https://d.example.com/2": { status: 302, headers: { location: "/3" } },
    "https://d.example.com/3": { status: 302, headers: { location: "/4" } },
    "https://d.example.com/4": { body: PNG },
  });
  const options = { timeoutMs: 1000, request, resolve: PUBLIC };
  assert.equal((await logo.fetchQuoteLogo("https://a.example.com/logo.png", options)).ok, true);
  const internal = await logo.fetchQuoteLogo("https://b.example.com/logo.png", options);
  assert.equal(internal.ok, false);
  assert.match(internal.reason, /内部/);
  assert.equal(calls.includes("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal((await logo.fetchQuoteLogo("https://c.example.com/logo.png", options)).ok, false);
  const loop = await logo.fetchQuoteLogo("https://d.example.com/0", options);
  assert.equal(loop.ok, false);
  assert.match(loop.reason, /リダイレクト/);
});

test("T14 logo fetch: gives up within the timeout instead of waiting for a slow server", async () => {
  const { request } = fakeRequest({ "https://slow.example.com/logo.png": "hang" });
  const started = Date.now();
  const result = await logo.fetchQuoteLogo("https://slow.example.com/logo.png", { timeoutMs: 200, request, resolve: PUBLIC });
  assert.equal(result.ok, false);
  assert.match(result.reason, /時間内/);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
});

test("T14 PDF logo: only embedded PNG/JPEG data URLs are drawn (react-pdf never fetches URLs or files itself)", () => {
  const { renderableQuoteLogo } = require("../src/lib/pdf/quote-pdf.tsx");
  const dataPng = `data:image/png;base64,${PNG.toString("base64")}`;
  assert.equal(renderableQuoteLogo(dataPng), dataPng);
  for (const value of ["https://example.com/logo.png", "http://example.com/logo.png", "file:///etc/passwd", "data:image/svg+xml;base64,PHN2Zz4=", null, undefined, ""]) {
    assert.equal(renderableQuoteLogo(value), null, String(value));
  }
});

// ---- 発行（POST /api/quotes/[id]/finalize）----

function setupFinalize(logoUrl, logoResult) {
  const row = { id: "quote", tenantId: "tenant", dealId: "deal", status: "draft", clientName: "架空社", clientHonorific: "御中", issueDate: new Date(), updatedAt: new Date(), quoteNumber: null, idempotencyKey: null, lines: [{ name: "架空", qty: 1, unitPrice: 100, unit: "式", taxCategory: "taxable", taxRate: 10 }] };
  const profile = { legalName: "架空社", postalCode: "100-0000", addressLine1: "架空県", addressLine2: "1-1", logoUrl, numberPrefix: "D", nextQuoteNumber: 2 };
  const m = { row, uploads: 0, deleted: 0, docs: 0, logoCalls: [], logoResult };
  const tx = {
    quote: { findUnique: async () => structuredClone(row), update: async ({ data }) => { Object.assign(row, data); row.updatedAt = new Date(row.updatedAt.getTime() + 1); return structuredClone(row); } },
    quoteIssuerProfile: { findFirst: async () => ({ ...profile }), update: async () => ({ ...profile }) },
    document: { create: async () => { m.docs++; return { id: "document" }; } }, $executeRaw: async () => {},
  };
  m.prisma = { ...tx, $transaction: async (fn) => fn(tx) };
  return m;
}

test("T14 issue: an unreachable logo is left out with a notice in the result; a reachable one is embedded as data", async () => {
  const failed = setupFinalize("https://logo.uicheck-20261001-mx.invalid/logo.png", { ok: false, reason: "サーバーが見つかりません（名前解決できません）" });
  const response = await finalize(await loadFinalize(failed));
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.match(json.logoWarning, /ロゴを取得できなかったため、ロゴなしで発行しました/);
  assert.match(json.logoWarning, /名前解決/);
  assert.equal(failed.rendered.issuer.logoUrl, null, "the PDF is drawn without a logo");
  assert.equal(failed.row.issuerSnapshot.logoUrl, "https://logo.uicheck-20261001-mx.invalid/logo.png", "the snapshot keeps the configured value");
  assert.deepEqual(failed.logoCalls.map((c) => c.url), ["https://logo.uicheck-20261001-mx.invalid/logo.png"]);
  assert.ok(failed.logoCalls[0].timeoutMs <= 5000, "a short timeout is used while issuing");

  const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`;
  const ok = setupFinalize("https://cdn.example.com/logo.png", { ok: true, dataUrl });
  const okJson = await (await finalize(await loadFinalize(ok))).json();
  assert.equal(okJson.logoWarning, undefined);
  assert.equal(ok.rendered.issuer.logoUrl, dataUrl);

  const none = setupFinalize(null, { ok: false, reason: "呼ばれない" });
  const noneJson = await (await finalize(await loadFinalize(none))).json();
  assert.equal(noneJson.logoWarning, undefined);
  assert.equal(none.logoCalls.length, 0);
});

// ---- 管理画面の保存（PATCH /api/admin/quote-settings）----

const SETTINGS = "src/app/api/admin/quote-settings/route.ts";
function settingsState(savedLogo, logoResult) {
  const s = { permission: "admin", tenantCtx: { tenantId: "tenant-luma", crossTenant: false }, updates: [], logoCalls: [], logoResult };
  s.profile = {
    id: "profile", tenantId: "tenant-luma", legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋",
    addressLine2: "2-7-3 柄澤ビル3F", logoUrl: savedLogo, defaultNotes: "", travelExpenseNote: null, numberPrefix: "L", nextQuoteNumber: 3,
  };
  s.prisma = {
    quoteIssuerProfile: {
      findFirst: async () => ({ ...s.profile }),
      update: async ({ data }) => { s.updates.push(data); Object.assign(s.profile, data); return { ...s.profile }; },
      updateMany: async ({ data }) => { s.updates.push(data); Object.assign(s.profile, data); return { count: 1 }; },
    },
    tenant: { findUnique: async () => ({ name: "株式会社Luma", code: "luma" }) },
  };
  return s;
}
const settingsBoundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getCurrentPermission=async()=>mocks.permission;",
  "@/lib/tenant-context": "export const getRequestTenant=async()=>mocks.tenantCtx;",
  "@/lib/quote-logo": "export const LOGO_SAVE_TIMEOUT_MS=5000;export const fetchQuoteLogo=async(url,o)=>{mocks.logoCalls.push({url,timeoutMs:o?.timeoutMs});return mocks.logoResult;};",
};
const loadSettings = (s) => offlineModule(SETTINGS, s, settingsBoundaries, [SETTINGS, "src/lib/quote-issuer-server.ts", "src/lib/quote-issuer.ts"]);
const settingsBody = (logoUrl) => ({
  legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F",
  logoUrl, defaultNotes: "", travelExpenseNote: null, numberPrefix: "L",
});
const patchSettings = (route, payload) => route.PATCH(new Request("http://offline.invalid/api/admin/quote-settings", { method: "PATCH", body: JSON.stringify(payload) }));

test("T14 settings: a new https logo is fetched on save, and an unreachable one is refused with the reason", async () => {
  const s = settingsState(null, { ok: false, reason: "画像が見つかりません（HTTP 404）" });
  const route = await loadSettings(s);
  const refused = await patchSettings(route, settingsBody("https://upload.example.org/missing.png"));
  assert.equal(refused.status, 400);
  const error = (await refused.json()).error;
  assert.match(error, /ロゴの画像を取得できませんでした/);
  assert.match(error, /404/);
  assert.equal(s.updates.length, 0, "nothing is saved");
  assert.equal(s.logoCalls[0].url, "https://upload.example.org/missing.png");
  assert.ok(s.logoCalls[0].timeoutMs <= 5000);

  s.logoResult = { ok: true, dataUrl: `data:image/png;base64,${PNG.toString("base64")}` };
  const saved = await patchSettings(route, settingsBody("https://upload.example.org/logo.png"));
  assert.equal(saved.status, 200);
  assert.equal(s.profile.logoUrl, "https://upload.example.org/logo.png", "the URL itself is saved");
  assert.equal((await saved.json()).logoWarning, undefined);
});

test("T14 settings: an already saved logo that stopped loading does not block other edits, but is reported", async () => {
  const s = settingsState("https://upload.example.org/old.png", { ok: false, reason: "時間内に取得できませんでした（5秒）" });
  const route = await loadSettings(s);
  const response = await patchSettings(route, { ...settingsBody("https://upload.example.org/old.png"), legalName: "株式会社Luma（新）" });
  assert.equal(response.status, 200);
  assert.equal(s.profile.legalName, "株式会社Luma（新）");
  assert.match((await response.json()).logoWarning, /ロゴの画像を取得できませんでした.*ロゴなしで発行/);

  const calls = s.logoCalls.length;
  for (const logoUrl of [null, `data:image/png;base64,${PNG.toString("base64")}`]) {
    assert.equal((await patchSettings(route, settingsBody(logoUrl))).status, 200);
  }
  assert.equal(s.logoCalls.length, calls, "no fetch for no logo or an uploaded image");
});

test("T14 settings: an upper-case scheme or surrounding spaces are normalized, so the URL is still checked before saving", async () => {
  const s = settingsState(null, { ok: false, reason: "画像が見つかりません（HTTP 404）" });
  const route = await loadSettings(s);
  for (const logoUrl of ["HTTPS://cdn.example.com/x.png", " https://cdn.example.com/x.png ", "\thttps://cdn.example.com/x.png"]) {
    const response = await patchSettings(route, settingsBody(logoUrl));
    assert.equal(response.status, 400, JSON.stringify(logoUrl));
  }
  assert.equal(s.updates.length, 0);
  assert.deepEqual(s.logoCalls.map((c) => c.url), Array(3).fill("https://cdn.example.com/x.png"));

  s.logoResult = { ok: true, dataUrl: `data:image/png;base64,${PNG.toString("base64")}` };
  assert.equal((await patchSettings(route, settingsBody(" HTTPS://CDN.example.com/x.png"))).status, 200);
  assert.equal(s.profile.logoUrl, "https://cdn.example.com/x.png", "the normalized URL is saved");
});
