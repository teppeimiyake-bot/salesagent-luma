import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T14: 「契約書 自動生成」で契約書を作ると、同じ商談ページの「この商談の個別契約書」一覧が取り直される。
// 一覧はクライアント側で fetch しているため router.refresh() だけでは更新されず、
// 「下の「個別契約書」に表示されます」と案内しても再読み込みまで 0 件のままだった。
// 2つの実物のコンポーネントを別々の最小フック環境で動かし、同じ window を共有させて確かめる
// （tests/t17-quote-builder-plan-confirm.test.mjs と同じ描き方）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const element = (type) => `(props)=>({type:${JSON.stringify(type)},props})`;
const components = (...names) => names.map((name) => `export const ${name}=${element(name)};`).join("");
const stubs = {
  react: "export const useState=(...a)=>mocks.hooks.useState(...a);export const useEffect=(...a)=>mocks.hooks.useEffect(...a);export const useTransition=()=>[false,(fn)=>fn()];",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const useRouter=()=>({refresh(){mocks.refreshes=(mocks.refreshes??0)+1;}});",
  "lucide-react": ["FileSignature", "Upload", "Download", "Trash2", "ExternalLink", "Link2", "FileText", "Wand2"].map((name) => `export const ${name}=()=>null;`).join(""),
  "@/lib/utils": "export const formatDate=(d)=>String(d);",
  "@/components/ui/card": components("Card", "CardHeader", "CardTitle", "CardContent"),
  "@/components/ui/button": components("Button"),
  "@/components/ui/input": components("Input"),
  "@/components/ui/label": components("Label"),
  "@/components/ui/badge": components("Badge"),
};
const REAL = { "@/components/deals/deal-contracts": "src/components/deals/deal-contracts.tsx", "@/lib/document-upload": "src/lib/document-upload.ts" };

async function bundle(entry) {
  return (await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "t14-contract-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        if (a.path in REAL) return { path: path.join(ROOT, REAL[a.path]) };
        return { errors: [{ text: `Unexpected dependency of ${entry}: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
    } }],
  })).outputFiles[0].text;
}
const contractsBundle = await bundle("src/components/deals/deal-contracts.tsx");
const generatorBundle = await bundle("src/components/deals/contract-generator.tsx");

const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
function expand(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: expand(node.props?.children) } };
}
function findAll(node, match, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) { for (const child of node) findAll(child, match, found); return found; }
  if (match(node)) found.push(node);
  return findAll(node.props?.children, match, found);
}
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return String(node);
  return textOf(node.props?.children);
}
function mount(render) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let scheduled = false;
  let tree = null;
  const commit = () => {
    cursor = 0;
    effects = [];
    tree = expand(render());
    for (const [i, effect, deps] of effects) {
      slots[i]?.cleanup?.();
      slots[i] = { deps, cleanup: effect() };
    }
  };
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) {
        const slot = { value: typeof initial === "function" ? initial() : initial };
        slot.set = (next) => {
          const value = typeof next === "function" ? next(slot.value) : next;
          if (Object.is(value, slot.value)) return;
          slot.value = value;
          if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; commit(); }); }
        };
        slots[i] = slot;
      }
      return [slots[i].value, slots[i].set];
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) effects.push([i, effect, deps]);
    },
  };
  const unmount = () => { for (const slot of slots) slot?.cleanup?.(); };
  return { hooks, start: commit, tree: () => tree, unmount };
}

function load(code, globals, exportName, props) {
  const mocks = {};
  const loaded = { exports: {} };
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, mocks, setTimeout: () => 0, console, ...globals });
  const runtime = mount(() => ({ type: loaded.exports[exportName], props }));
  mocks.hooks = runtime.hooks;
  runtime.start();
  return runtime;
}

function createServer() {
  const server = {
    docs: [],
    listCalls: [],
    async fetch(url, init = {}) {
      const method = init.method ?? "GET";
      if (method === "GET" && url.startsWith("/api/documents?")) {
        server.listCalls.push(url);
        return Response.json({ documents: server.docs });
      }
      const generate = /^\/api\/deal-products\/([^/?]+)\/contract/.exec(url);
      if (generate && method === "POST") {
        const skipped = server.docs.length > 0;
        if (!skipped) server.docs.push({ id: `doc-${generate[1]}`, name: "映像契約書ドラフト（架空）", description: null, fileUrl: "gcs://x", fileSize: 1, mimeType: "application/pdf", category: "contract", version: null, createdAt: "2026-09-30" });
        return Response.json({ ok: true, documentId: "doc", skipped, category: "映像" });
      }
      if (generate) return Response.json({ error: "x" }, { status: 400 });
      throw new Error(`unexpected request ${method} ${url}`);
    },
  };
  return server;
}

const DEAL_PRODUCTS = [{ id: "dp-video", productName: "採用動画", planName: "スタンダード", category: "映像", amount: 500_000, yomiStatus: "A+ヨミ" }];

async function renderPage(server, { dealId = "deal-1" } = {}) {
  const window = new EventTarget();
  const globals = { fetch: (url, init) => server.fetch(url, init), window, CustomEvent, Event, EventTarget };
  const contracts = load(contractsBundle, globals, "DealContracts", { dealId, companyName: "架空商事" });
  const generator = load(generatorBundle, globals, "ContractGenerator", { dealProducts: DEAL_PRODUCTS, canEdit: true });
  await settle();
  return {
    window,
    contracts,
    count: () => textOf(findAll(contracts.tree(), (n) => n.type === "Badge")[0]),
    listText: () => textOf(contracts.tree()),
    async generate() {
      const button = findAll(generator.tree(), (n) => n.type === "Button" && textOf(n).includes("契約書を生成"))[0];
      assert.ok(button, "generate button");
      await button.props.onClick();
      await settle();
    },
    generatorText: () => textOf(generator.tree()),
  };
}

test("T14 generating a contract reloads the deal's contract list without a page reload", async () => {
  const server = createServer();
  const page = await renderPage(server);
  assert.equal(page.count(), "0");
  assert.match(page.listText(), /この商談用の個別契約書はまだありません。/);
  assert.equal(server.listCalls.length, 1, "the list is fetched once on first render");

  await page.generate();
  assert.match(page.generatorText(), /映像契約書ドラフトを生成しました。下の「個別契約書」に表示されます。/);
  assert.equal(server.listCalls.length, 2, "the list is fetched again after generating");
  assert.equal(server.listCalls[1], "/api/documents?dealId=deal-1&category=contract");
  assert.equal(page.count(), "1", "the generated draft appears right away, as the message says");
  assert.match(page.listText(), /映像契約書ドラフト（架空）/);

  // 既存ドラフトがあって重複生成を止めたときも、一覧は取り直す（案内どおり下を見れば出ている）
  await page.generate();
  assert.match(page.generatorText(), /既にこの商材の契約書ドラフトがあります/);
  assert.equal(server.listCalls.length, 3);
  assert.equal(page.count(), "1");
});

test("T14 the contract list only reloads for its own deal and stops listening when unmounted", async () => {
  const server = createServer();
  const page = await renderPage(server, { dealId: "deal-1" });
  const { notifyDealContractsChanged, DEAL_CONTRACTS_CHANGED_EVENT } = (() => {
    const loaded = { exports: {} };
    vm.runInNewContext(contractsBundle, { module: loaded, exports: loaded.exports, mocks: {}, window: page.window, CustomEvent });
    return loaded.exports;
  })();
  assert.equal(typeof DEAL_CONTRACTS_CHANGED_EVENT, "string");
  assert.equal(server.listCalls.length, 1);

  notifyDealContractsChanged({ dealId: "another-deal" });
  await settle();
  assert.equal(server.listCalls.length, 1, "a change on another deal is ignored");

  notifyDealContractsChanged({ dealId: "deal-1" });
  await settle();
  assert.equal(server.listCalls.length, 2);

  page.contracts.unmount();
  notifyDealContractsChanged();
  await settle();
  assert.equal(server.listCalls.length, 2, "the listener is removed on unmount");
});

test("T14 a failed generation does not reload the contract list", async () => {
  const server = createServer();
  const original = server.fetch;
  server.fetch = async (url, init) => (/\/contract/.test(url) ? Response.json({ error: "テンプレートが見つかりません" }, { status: 400 }) : original(url, init));
  const page = await renderPage(server);
  await page.generate();
  assert.match(page.generatorText(), /テンプレートが見つかりません/);
  assert.equal(server.listCalls.length, 1);
});
