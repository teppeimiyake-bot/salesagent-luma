import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T14 AC-07: 見積作成画面の備考は発行者設定の文面から組み立てる（標準備考は既定ON、交通費備考は選択式）。
// 画面内プレビューの発行者も設定の値を出す（株式会社Luma の直書きをしない）。
// 実物の QuoteBuilder を最小のフック実行環境で動かし、UI部品・アイコン・React は差し替える。
// 見積の計算・備考の組み立て（quote-notes / quote-issuer）は実物を使う。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/components/deals/quote-builder.tsx";
const REAL = new Set(["@/lib/quote-calculation", "@/lib/quote-version", "@/lib/quote-template", "@/lib/quote-notes", "@/lib/quote-issuer"]);

const lucideNames = /import\s*\{([^}]+)\}\s*from\s*"lucide-react"/.exec(readFileSync(path.join(ROOT, ENTRY), "utf8"))[1]
  .split(",").map((name) => name.trim()).filter(Boolean);
const element = (type) => `(props)=>({type:${JSON.stringify(type)},props})`;
const components = (...names) => names.map((name) => `export const ${name}=${element(name)};`).join("");
const stubs = {
  react: "export const useState=(...a)=>mocks.hooks.useState(...a);export const useEffect=(...a)=>mocks.hooks.useEffect(...a);export const useRef=(...a)=>mocks.hooks.useRef(...a);",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const useRouter=()=>({refresh(){}});",
  "lucide-react": lucideNames.map((name) => `export const ${name}=()=>null;`).join(""),
  "@/lib/utils": "export const formatDate=(d)=>String(d);",
  "@/components/ui/card": components("Card", "CardHeader", "CardTitle", "CardContent"),
  "@/components/ui/button": components("Button"),
  "@/components/ui/input": components("Input"),
  "@/components/ui/label": components("Label"),
  "@/components/ui/badge": components("Badge"),
  "@/components/ui/dialog": components("Dialog", "DialogContent", "DialogDescription", "DialogHeader", "DialogTitle"),
};

const bundle = (await build({
  absWorkingDir: ROOT, entryPoints: [ENTRY], bundle: true, write: false, format: "cjs", platform: "neutral",
  jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "t14-builder-stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
      if (a.path in stubs) return { path: a.path, namespace: "stub" };
      if (REAL.has(a.path)) return { path: path.join(ROOT, "src", `${a.path.slice(2)}.ts`) };
      return { errors: [{ text: `Unexpected dependency of ${ENTRY}: ${a.path}` }] };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
})).outputFiles[0].text;

const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
function expand(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object") return node;
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: expand(node.props?.children) } };
}
function findAll(node, match, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
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
    for (const [i, effect, deps] of effects) slots[i] = { deps, cleanup: effect() };
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
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => { scheduled = false; commit(); });
          }
        };
        slots[i] = slot;
      }
      return [slots[i].value, slots[i].set];
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!slots[i] || !sameDeps(slots[i].deps, deps)) effects.push([i, effect, deps]);
    },
    // QG26-10: the builder guards its submits with a ref (same-tick double click).
    useRef(initial) {
      const i = cursor++;
      slots[i] ??= { current: initial };
      return slots[i];
    },
  };
  return { hooks, start: commit, tree: () => tree };
}

const SETTINGS = {
  issuer: { legalName: "架空発行者株式会社", postalCode: "100-0001", addressLine1: "東京都千代田区架空1-1", addressLine2: "架空ビル1F", logoUrl: null },
  notes: { standard: ["標準A", "標準B"], travel: ["交通費1", "交通費2"] },
  canManage: true,
};

function createServer({ settings = SETTINGS, settingsStatus = 200, quotes = [] } = {}) {
  const server = {
    writes: [],
    async fetch(url, init = {}) {
      const method = init.method ?? "GET";
      if (url === "/api/admin/quote-settings/defaults") return Response.json(settingsStatus === 200 ? settings : { error: "x" }, { status: settingsStatus });
      if (url === "/api/quote-templates") return Response.json({ templates: [] });
      if (url === "/api/deals/deal/quotes" && method === "GET") return Response.json({ quotes });
      if (method === "POST" || method === "PATCH") {
        server.writes.push({ method, url, body: JSON.parse(init.body) });
        return Response.json({ quote: { id: "saved" } });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  };
  return server;
}

async function renderBuilder(server) {
  const mocks = {};
  const loaded = { exports: {} };
  vm.runInNewContext(bundle, {
    module: loaded, exports: loaded.exports, mocks, fetch: (url, init) => server.fetch(url, init),
    setTimeout: () => 0, console,
  });
  const { QuoteBuilder } = loaded.exports;
  const runtime = mount(() => ({ type: QuoteBuilder, props: { dealId: "deal", companyName: "架空商事株式会社", dealProducts: [], canEdit: true, featureV2: true } }));
  mocks.hooks = runtime.hooks;
  runtime.start();
  await settle();
  const all = (match) => findAll(runtime.tree(), match);
  const view = {
    text: () => textOf(runtime.tree()),
    async click(label) {
      const button = all((n) => n.type === "Button" && textOf(n).includes(label))[0];
      assert.ok(button, `button ${label}`);
      await button.props.onClick();
      await settle();
    },
    checkbox: () => all((n) => n.type === "input" && n.props.type === "checkbox")[0],
    travel: () => all((n) => n.type === "select" && n.props.id === "quote-travel-note")[0],
    extra: () => all((n) => n.type === "textarea")[0],
    async change(node, target) {
      node.props.onChange({ target });
      await settle();
    },
    async setItem(name) {
      await view.change(all((n) => n.type === "Input" && n.props.placeholder === "品目")[0], { value: name });
    },
    adminLink: () => all((n) => n.type === "a" && n.props.href === "/admin/quote-settings")[0],
    previewNote: () => all((n) => n.type === "p" && textOf(n).startsWith("備考")).map(textOf)[0],
  };
  return view;
}

test("T14 a new quote starts with the configured standard notes ON; the travel note is chosen from the configured variants", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  assert.equal(view.checkbox().props.checked, true, "standard notes are ON by default");
  assert.deepEqual(findAll(view.travel(), (n) => n.type === "option").map(textOf), ["入れない", "交通費1", "交通費2"]);
  assert.equal(view.travel().props.value, "", "no travel note by default");
  assert.equal(view.previewNote(), "備考標準A\n標準B");
  assert.match(view.text(), /架空発行者株式会社〒100-0001東京都千代田区架空1-1架空ビル1F/, "the preview shows the configured issuer");
  assert.doesNotMatch(view.text(), /株式会社Luma|柄澤ビル/);
  assert.ok(view.adminLink(), "admins get a link to the settings screen");

  await view.setItem("映像制作費");
  await view.change(view.travel(), { value: "1" });
  await view.change(view.extra(), { value: "撮影は1日を想定" });
  assert.equal(view.previewNote(), "備考標準A\n標準B\n交通費2\n撮影は1日を想定");
  await view.click("下書き保存");
  assert.equal(server.writes.length, 1);
  assert.equal(server.writes[0].url, "/api/deals/deal/quotes");
  assert.equal(server.writes[0].body.note, "標準A\n標準B\n交通費2\n撮影は1日を想定");
});

test("T14 editing a saved quote restores the note selection, and turning the standard notes off removes them", async () => {
  const quote = {
    id: "q9", clientName: "架空社", clientHonorific: "御中", subject: null, note: "標準A\n標準B\n交通費1\n自由記述",
    taxRate: 10, version: null, status: "draft", documentId: null, createdAt: "2026-09-30T00:00:00+09:00",
    issueDate: "2026-09-30T00:00:00+09:00", lines: [{ name: "映像", qty: 1, unitPrice: 1000, unit: "式", taxCategory: "taxable", taxRate: 10 }],
  };
  const server = createServer({ quotes: [quote], settings: { ...SETTINGS, canManage: false } });
  const view = await renderBuilder(server);
  await view.click("編集");
  assert.equal(view.checkbox().props.checked, true);
  assert.equal(view.travel().props.value, 0);
  assert.equal(view.extra().props.value, "自由記述");
  assert.equal(view.adminLink(), undefined, "non-admins do not get the settings link");
  await view.change(view.checkbox(), { checked: false });
  await view.click("下書き保存");
  assert.deepEqual(server.writes.map((w) => [w.method, w.url, w.body.note]), [["PATCH", "/api/quotes/q9", "交通費1\n自由記述"]]);
});

test("T14 when the settings cannot be read, the sample wording is used and the preview does not invent an issuer", async () => {
  const server = createServer({ settingsStatus: 500 });
  const view = await renderBuilder(server);
  await view.click("新規作成");
  assert.match(view.text(), /発行者設定を読み込めませんでした/);
  await view.setItem("映像制作費");
  await view.click("下書き保存");
  assert.equal(server.writes[0].body.note, "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。\n※消費税はご契約日時点での税率となります。");
});

test("T14 a new quote after saving or editing another one starts again from the default note selection", async () => {
  // resetForm が備考の選択も戻さないと、前の見積の「標準備考OFF・交通費・自由記述」が次の新規見積に残る
  const saved = {
    id: "q7", clientName: "架空社", clientHonorific: "御中", subject: null, note: "交通費2\n前回の自由記述",
    taxRate: 10, version: null, status: "draft", documentId: null, createdAt: "2026-09-30T00:00:00+09:00",
    issueDate: "2026-09-30T00:00:00+09:00", lines: [{ name: "映像", qty: 1, unitPrice: 1000, unit: "式", taxCategory: "taxable", taxRate: 10 }],
  };
  const server = createServer({ quotes: [saved] });
  const view = await renderBuilder(server);
  const expectDefaults = (when) => {
    assert.equal(view.checkbox().props.checked, true, `${when}: standard notes are ON again`);
    assert.equal(view.travel().props.value, "", `${when}: no travel note`);
    assert.equal(view.extra().props.value, "", `${when}: the free text is empty`);
    assert.equal(view.previewNote(), "備考標準A\n標準B", when);
  };

  await view.click("新規作成");
  await view.setItem("映像制作費");
  await view.change(view.checkbox(), { checked: false });
  await view.change(view.travel(), { value: "0" });
  await view.change(view.extra(), { value: "今回だけの備考" });
  await view.click("下書き保存");
  assert.equal(server.writes.at(-1).body.note, "交通費1\n今回だけの備考");
  await view.click("新規作成");
  expectDefaults("after saving a draft");

  await view.click("編集");
  assert.deepEqual([view.checkbox().props.checked, view.travel().props.value, view.extra().props.value], [false, 1, "前回の自由記述"]);
  await view.click("キャンセル");
  await view.click("新規作成");
  expectDefaults("after cancelling an edit");
  await view.setItem("映像制作費");
  await view.click("下書き保存");
  assert.equal(server.writes.at(-1).body.note, "標準A\n標準B", "the new quote does not carry the previous quote's notes");
});
