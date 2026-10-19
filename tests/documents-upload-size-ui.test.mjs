// 資料の添付の画面（商談の提案書・商談の個別契約書・資料ライブラリのアップロード）で、
// 上限（24MB）を超えるファイルは送る前に止めて、理由を日本語で案内する。上限内のファイルはそのまま送る。
// 実物のコンポーネントを最小のフック環境で動かす（tests/t14-contract-list-refresh.test.mjs と同じ描き方）。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MiB = 1024 * 1024;
const element = (type) => `(props)=>({type:${JSON.stringify(type)},props})`;
const components = (...names) => names.map((name) => `export const ${name}=${element(name)};`).join("");
const icons = ["FileSignature", "Upload", "Download", "Trash2", "ExternalLink", "Link2", "FileText", "FolderOpen"];
const stubs = {
  react: "export const useState=(...a)=>mocks.hooks.useState(...a);export const useEffect=(...a)=>mocks.hooks.useEffect(...a);export const useTransition=()=>[false,(fn)=>fn()];",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const useRouter=()=>({refresh(){}});",
  "lucide-react": icons.map((name) => `export const ${name}=()=>null;`).join(""),
  "@/lib/utils": "export const formatDate=(d)=>String(d);",
  "@/components/ui/card": components("Card", "CardHeader", "CardTitle", "CardContent"),
  "@/components/ui/button": components("Button"),
  "@/components/ui/input": components("Input"),
  "@/components/ui/label": components("Label"),
  "@/components/ui/badge": components("Badge"),
  "@/components/ui/textarea": components("Textarea"),
  "@/components/ui/select": components("Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"),
  "@/components/ui/dialog": components("Dialog", "DialogContent", "DialogDescription", "DialogHeader", "DialogTitle", "DialogTrigger"),
};
const REAL = { "@/lib/document-upload": "src/lib/document-upload.ts" };

async function bundle(entry) {
  return (await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "document-upload-stubs", setup(b) {
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

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
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
  return { hooks, start: commit, tree: () => tree };
}

const CASES = [
  { entry: "src/components/deals/deal-documents.tsx", exportName: "DealDocuments", props: { dealId: "deal-1", companyName: "架空商事" }, toggle: true },
  { entry: "src/components/deals/deal-contracts.tsx", exportName: "DealContracts", props: { dealId: "deal-1", companyName: "架空商事" }, toggle: true },
  { entry: "src/components/documents/document-upload-dialog.tsx", exportName: "DocumentUploadDialog", props: {}, toggle: false, name: "架空の提案書" },
];

async function render({ entry, exportName, props }) {
  const code = await bundle(entry);
  const posts = [];
  const fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") return Response.json({ documents: [] });
    posts.push({ url, init });
    return Response.json({ document: { id: "doc-1" } });
  };
  const mocks = {};
  const loaded = { exports: {} };
  vm.runInNewContext(code, { module: loaded, exports: loaded.exports, mocks, setTimeout: () => 0, console, fetch, FormData, Response, window: new EventTarget(), CustomEvent, confirm: () => true });
  const runtime = mount(() => ({ type: loaded.exports[exportName], props }));
  mocks.hooks = runtime.hooks;
  runtime.start();
  await settle();
  return { runtime, posts, text: () => textOf(runtime.tree()) };
}

async function pickAndSubmit(page, c, size) {
  if (c.toggle) {
    const open = findAll(page.runtime.tree(), (n) => n.type === "Button" && textOf(n).includes("追加"))[0];
    assert.ok(open, "追加ボタン");
    open.props.onClick();
    await settle();
  }
  const input = findAll(page.runtime.tree(), (n) => n.type === "input" && n.props.type === "file")[0];
  assert.ok(input, "ファイルの選択欄");
  const file = new File([new Uint8Array(0)], "架空の提案書.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  input.props.onChange({ target: { files: [file] } });
  await settle();
  if (c.name) {
    const nameInput = findAll(page.runtime.tree(), (n) => n.type === "Input")[0];
    nameInput.props.onChange({ target: { value: c.name } });
    await settle();
  }
  const form = findAll(page.runtime.tree(), (n) => n.type === "form")[0];
  assert.ok(form, "フォーム");
  await form.props.onSubmit({ preventDefault() {} });
  await settle();
}

for (const c of CASES) {
  const label = path.basename(c.entry);
  test(`${label}: 24MB を超える資料は送らずに、理由と上限を日本語で案内する`, async () => {
    const page = await render(c);
    await pickAndSubmit(page, c, 30 * MiB);
    assert.equal(page.posts.length, 0, "POST /api/documents を送らない");
    assert.match(page.text(), /ファイルが大きすぎます（30\.0MB）/);
    assert.match(page.text(), /24MBまで/);
  });

  test(`${label}: 上限内の資料はそのまま送る`, async () => {
    const page = await render(c);
    await pickAndSubmit(page, c, 5 * MiB);
    assert.equal(page.posts.length, 1);
    assert.equal(page.posts[0].url, "/api/documents");
    assert.doesNotMatch(page.text(), /ファイルが大きすぎます/);
  });
}
