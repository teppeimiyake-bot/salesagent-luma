import test from "node:test";
import assert from "node:assert/strict";
import { offlineModule } from "./helpers/offline-module.mjs";

const LUMA = { tenantId: "tenant-luma", code: "luma", crossTenant: false };
const DISPOSABLE = { tenantId: "tenant-disposable", code: "t01-demo", crossTenant: false };
const ALL = { tenantId: null, code: "__all__", crossTenant: true };

async function load() {
  const state = {
    ctx: undefined,
    requestCtx: null,
    reads: [],
    catalogs: {
      "tenant-luma": {
        products: [{ name: "映像制作", description: null, plans: [{ name: "採用動画", basePrice: 800000, description: null, sortOrder: 0 }] }],
        proposals: [{ name: "社員インタビュー", displayOrder: 0 }],
      },
      // A disposable verification tenant with an empty catalog.
      "tenant-disposable": { products: [], proposals: [] },
    },
  };
  const api = await offlineModule("src/lib/ai/luma-context.ts", state, {
    "@/lib/tenant-context": "export const currentTenant=()=>mocks.ctx;export const getRequestTenant=async()=>mocks.requestCtx;",
    // Mirrors src/lib/db.ts: explicit context, then the request tenant, then the Luma fallback;
    // the all-company view is not tenant-filtered.
    "@/lib/db": `
      const tenant=()=>mocks.ctx??mocks.requestCtx;
      const scope=()=>tenant()?.crossTenant?Object.values(mocks.catalogs):[mocks.catalogs[tenant()?.tenantId??"tenant-luma"]];
      export const prisma={
        product:{findMany:async()=>{mocks.reads.push(tenant()?.code??"none");return scope().flatMap(c=>c.products)}},
        planProposal:{findMany:async()=>scope().flatMap(c=>c.proposals)},
      };`,
  }, ["src/lib/ai/luma-context.ts", "src/lib/ai/luma-value-proposition.ts"]);
  return { api, state };
}

test("T09 a disposable tenant's empty catalog is never reused for the Luma tenant", async () => {
  const { api, state } = await load();
  state.ctx = LUMA;
  const luma = await api.getLumaContextText();
  // Prompt text for a single tenant is exactly the formatted catalog, as before.
  assert.equal(luma, api.formatLumaContextText(state.catalogs["tenant-luma"]));
  assert.match(luma, /# 商材カタログ\n- 映像制作\n {2}- 採用動画/u);
  state.ctx = DISPOSABLE;
  const disposable = await api.getLumaContextText();
  assert.equal(disposable, api.formatLumaContextText(state.catalogs["tenant-disposable"]));
  assert.match(disposable, /# 商材カタログ\n商材マスタ未登録/u);
  assert.doesNotMatch(disposable, /- 映像制作/u);
  state.ctx = LUMA;
  assert.equal(await api.getLumaContextText(), luma);
  state.ctx = DISPOSABLE;
  assert.equal(await api.getLumaContextText(), disposable);
  // Each tenant was read once and then served from its own cache entry.
  assert.deepEqual(Array.from(state.reads), ["luma", "t01-demo"]);
});

test("T09 a request-resolved tenant uses the same cache key as the tenant-scoped DB query", async () => {
  const { api, state } = await load();
  state.requestCtx = DISPOSABLE;
  const disposable = await api.getLumaContextText();
  assert.match(disposable, /# 商材カタログ\n商材マスタ未登録/u);
  state.requestCtx = LUMA;
  const luma = await api.getLumaContextText();
  assert.match(luma, /# 商材カタログ\n- 映像制作/u);
  state.requestCtx = null;
  state.ctx = DISPOSABLE;
  assert.equal(await api.getLumaContextText(), disposable);
  state.ctx = LUMA;
  assert.equal(await api.getLumaContextText(), luma);
  assert.deepEqual(Array.from(state.reads), ["t01-demo", "luma"]);
});

test("T09 deal-product context and the synchronous cached text stay tenant-scoped", async () => {
  const { api, state } = await load();
  state.ctx = LUMA;
  const catalog = await api.getLumaContextText();
  const withDeal = await api.getLumaContextText({ dealProducts: [{ productName: "採用動画", planName: null }] });
  assert.equal(withDeal, catalog.replace(/# この案件の提案中商材[\s\S]*$/u, "# この案件の提案中商材\n- 採用動画"));
  state.ctx = DISPOSABLE;
  const disposable = await api.getLumaContextText();
  assert.equal(api.getCachedLumaContextText(), disposable);
  state.ctx = LUMA;
  assert.equal(api.getCachedLumaContextText(), withDeal);
  state.ctx = undefined;
  assert.equal(api.getCachedLumaContextText(), "");
  state.ctx = ALL;
  assert.equal(api.getCachedLumaContextText(), "");
  assert.deepEqual(Array.from(state.reads), ["luma", "t01-demo"]);
});

test("T09 unknown tenants and the all-company view bypass the catalog cache", async () => {
  const { api, state } = await load();
  state.ctx = ALL;
  const merged = await api.getLumaContextText();
  assert.match(merged, /# 商材カタログ\n- 映像制作/u);
  await api.getLumaContextText();
  state.ctx = DISPOSABLE;
  assert.match(await api.getLumaContextText(), /# 商材カタログ\n商材マスタ未登録/u);
  state.ctx = undefined;
  state.requestCtx = null;
  await api.getLumaContextText();
  await api.getLumaContextText();
  assert.equal(api.getCachedLumaContextText(), "");
  state.ctx = LUMA;
  await api.getLumaContextText();
  assert.deepEqual(Array.from(state.reads), ["__all__", "__all__", "t01-demo", "none", "none", "luma"]);
});

test("T09 a tenant's cached catalog still expires after the TTL", async () => {
  const { api, state } = await load();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    state.ctx = LUMA;
    await api.getLumaContextText();
    clock += 3 * 60 * 1000 - 1;
    await api.getLumaContextText();
    clock += 2;
    await api.getLumaContextText();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(Array.from(state.reads), ["luma", "luma"]);
});
