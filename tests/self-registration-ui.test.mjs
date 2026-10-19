// 招待なしの登録は既定で受け付けない（ALLOW_SELF_REGISTRATION=1 のときだけ）。
// ログイン画面の「新規登録」と、招待URLなしで開いた登録画面は、受け付けないときは招待URLからの登録を案内する。
// 招待URLからの登録の画面はこれまでどおり。実物のページを最小のフック環境で動かす。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findAll, textOf } from "./helpers/component-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const elementProxy = "module.exports=new Proxy({}, {get(_, name){if (typeof name !== 'string' || name === '__esModule' || name === 'then') return undefined;return (props)=>({type:name,props});}});";
const stubs = {
  react: "export const useState=(...a)=>globalThis.__hooks.useState(...a);export const useEffect=(...a)=>globalThis.__hooks.useEffect(...a);export const Suspense=(p)=>p.children;",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/navigation": "export const useRouter=()=>({push(){},refresh(){}});export const useSearchParams=()=>globalThis.__search;",
  "next/link": "export default (props)=>({type:'Link',props});",
};
async function bundle(entry) {
  return (await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "neutral",
    jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "page-stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        if (a.path === "lucide-react" || a.path.startsWith("@/components/ui/")) return { path: a.path, namespace: "elements" };
        return { errors: [{ text: `Unexpected dependency of ${entry}: ${a.path}` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "elements" }, () => ({ contents: elementProxy, loader: "js" }));
    } }],
  })).outputFiles[0].text;
}

function render(code, { search = "", info }) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let tree = null;
  let scheduled = false;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
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
  const expand = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props ?? {}));
    return { type: node.type, props: { ...node.props, children: expand(node.props?.children) } };
  };
  const requests = [];
  const fetch = async (url) => {
    requests.push(String(url));
    if (String(url) === "/api/auth/providers-info") return Response.json(info);
    if (String(url).startsWith("/api/invites/")) {
      return Response.json({ invite: { email: "new@example.invalid", name: null, role: "sales", permission: "user", expiresAt: "2099-01-01T00:00:00Z" } });
    }
    throw Error(`unexpected ${url}`);
  };
  const context = { module: { exports: {} }, fetch, Response, URLSearchParams, queueMicrotask, console, window: { location: { href: "" } } };
  context.globalThis = context;
  context.__hooks = hooks;
  context.__search = new URLSearchParams(search);
  vm.runInNewContext(code, context);
  const Page = context.module.exports.default;
  function commit() {
    cursor = 0;
    effects = [];
    tree = expand({ type: Page, props: {} });
    for (const [i, effect, deps] of effects) slots[i] = { deps, cleanup: effect() };
  }
  commit();
  return {
    tree: () => tree,
    requests,
    async settle() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); },
  };
}

const loginCode = await bundle("src/app/login/page.tsx");
const registerCode = await bundle("src/app/register/page.tsx");
const links = (tree, href) => findAll(tree, (n) => n.type === "Link" && n.props.href === href);
const forms = (tree) => findAll(tree, (n) => n.type === "form");

test("ログイン画面: 招待なしの登録を受け付けないときは「新規登録」を出さず、招待URLからの登録を案内する", async () => {
  const page = render(loginCode, { info: { google: false, selfRegistration: false } });
  await page.settle();
  assert.equal(links(page.tree(), "/register").length, 0);
  assert.match(textOf(page.tree()), /管理者から届く招待URL/);
});

test("ログイン画面: 受け付けるとき（ALLOW_SELF_REGISTRATION=1）は「新規登録」を出す", async () => {
  const page = render(loginCode, { info: { google: false, selfRegistration: true } });
  await page.settle();
  assert.equal(links(page.tree(), "/register").length, 1);
});

test("登録画面（招待URLなし）: 受け付けないときは登録フォームを出さず、招待URLからの登録を案内する", async () => {
  const page = render(registerCode, { info: { google: false, selfRegistration: false } });
  await page.settle();
  assert.equal(forms(page.tree()).length, 0);
  assert.match(textOf(page.tree()), /招待URLから登録してください/);
  assert.equal(links(page.tree(), "/login").length, 1);
});

test("登録画面（招待URLなし）: 受け付けるときは登録フォームを出す", async () => {
  const page = render(registerCode, { info: { google: false, selfRegistration: true } });
  await page.settle();
  assert.equal(forms(page.tree()).length, 1);
});

test("登録画面（招待URLあり）: 招待なしの登録を受け付けなくても、これまでどおり招待で登録できる", async () => {
  const page = render(registerCode, { search: "invite=tok-1", info: { google: false, selfRegistration: false } });
  await page.settle();
  assert.equal(forms(page.tree()).length, 1);
  assert.match(textOf(page.tree()), /招待を確認しました/);
});
