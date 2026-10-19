import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T14/T24: 狭い幅（md 未満）では、商談ページに限らずどのページでもサイドバーを畳んで
// 左上の「ナビゲーションを開く」ボタン＋ドロワーに切り替える。md 以上は常設のまま（見た目は変えない）。
// 以前は商談ページ（isDealsPage）だけが対象で、/admin/quote-settings などは 390px でも幅288pxの
// サイドバーが残り、本文が約100pxに潰れていた。
// 実物の Sidebar を束ね、フック・リンク・アイコン・Dialog などの部品だけ差し替えて描画木を調べる。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/components/layout/sidebar.tsx";
const lucideNames = /import\s*\{([^}]+)\}\s*from\s*"lucide-react"/.exec(readFileSync(path.join(ROOT, ENTRY), "utf8"))[1]
  .split(",").map((name) => name.trim()).filter(Boolean);
const component = (name) => `(props)=>({type:${JSON.stringify(name)},props})`;
const stubs = {
  react: "export const useState=(initial)=>[typeof initial==='function'?initial():initial,()=>{}];",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/link": `export default ${component("Link")};`,
  "next/navigation": "export const usePathname=()=>globalThis.__pathname;export const useRouter=()=>({push(){},refresh(){}});",
  "@/lib/utils": "export const cn=(...c)=>c.filter(Boolean).join(' ');",
  "@/components/ui/dialog": ["Dialog", "DialogContent", "DialogTitle", "DialogTrigger"].map((n) => `export const ${n}=${component(n)};`).join(""),
  "@/components/layout/tenant-tabs": `export const TenantTabs=${component("TenantTabs")};export const ALL_TENANTS_CODE="__all__";`,
  "lucide-react": lucideNames.map((name) => `export const ${name}=${component(name)};`).join(""),
};
const bundle = (await build({
  absWorkingDir: ROOT, entryPoints: [ENTRY], bundle: true, write: false, format: "cjs", platform: "neutral", jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "t24-sidebar-stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
      if (a.path in stubs) return { path: a.path, namespace: "stub" };
      return { errors: [{ text: `Unexpected dependency of ${ENTRY}: ${a.path}` }] };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
})).outputFiles[0].text;
const context = { module: { exports: {} }, fetch() { throw new Error("no network"); } };
context.exports = context.module.exports;
context.globalThis = context;
vm.runInNewContext(bundle, context);
const { Sidebar } = context.module.exports;

const user = { name: "管理者", email: "admin@example.invalid", avatarColor: null, permission: "admin" };
function render(pathname) {
  context.__pathname = pathname;
  return Sidebar({ user, quoteTemplatesEnabled: true });
}
const classes = (node) => String(node?.props?.className ?? "").split(/\s+/).filter(Boolean);
function find(node, pred, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) find(child, pred, found);
    return found;
  }
  // 差し替えた部品（Dialog・Link など）は関数なので、呼んで {type:"Dialog"} などの名前付きの節に展開する
  if (typeof node.type === "function") return find(node.type(node.props), pred, found);
  if (pred(node)) found.push(node);
  return find(node.props?.children, pred, found);
}

const PAGES = [
  "/admin/quote-settings", "/admin/quote-templates", "/admin/products", "/admin/trash",
  "/admin/industries", "/admin/users", "/dashboard", "/companies", "/kpi", "/deals", "/deals/d1",
];

for (const pathname of PAGES) {
  test(`T24 ${pathname}: the persistent sidebar is only shown from md up and a drawer trigger replaces it below md`, () => {
    const tree = render(pathname);
    // 常設サイドバーは md 未満で隠す（hidden md:block）の中にだけある
    const asides = find(tree, (n) => n.type === "aside");
    assert.ok(asides.length >= 1, "the sidebar is rendered");
    const desktop = find(tree, (n) => n.type === "div" && classes(n).includes("hidden") && classes(n).includes("md:block"));
    assert.equal(desktop.length, 1, "one desktop-only wrapper");
    assert.equal(find(desktop[0], (n) => n.type === "aside").length, 1, "the persistent sidebar sits inside the md-only wrapper");
    assert.equal(asides.length, 2, "the same sidebar is reused in the drawer, nothing else renders an aside");
    // ハンバーガーは md 以上で隠れ、ドロワー（Dialog）を開く
    const triggers = find(tree, (n) => n.type === "button" && n.props?.["aria-label"] === "ナビゲーションを開く");
    assert.equal(triggers.length, 1, "a navigation trigger is rendered");
    assert.ok(classes(triggers[0]).includes("md:hidden"), "the trigger is hidden from md up");
    const [dialog] = find(tree, (n) => n.type === "Dialog");
    assert.ok(dialog, "a drawer dialog is rendered");
    assert.equal(find(dialog, (n) => n.type === "DialogTitle")[0]?.props.children, "ナビゲーション");
    const [content] = find(dialog, (n) => n.type === "DialogContent");
    assert.equal(find(content, (n) => n.type === "aside").length, 1, "the drawer holds the sidebar");
    assert.ok(find(content, (n) => n.type === "Link" && n.props.href === "/deals").length === 1, "navigation links are reachable from the drawer");
  });
}

test("T24 the desktop sidebar keeps its width and look (w-72, not shrunk) on every page", () => {
  for (const pathname of PAGES) {
    const [aside] = find(render(pathname), (n) => n.type === "aside");
    assert.ok(classes(aside).includes("w-72") && classes(aside).includes("shrink-0"), pathname);
  }
});

test("T24 the header leaves room for the fixed trigger below md on every page, keeping px-8 from md up", () => {
  const source = readFileSync(path.join(ROOT, "src/components/layout/header.tsx"), "utf8");
  const header = /<header className=\{`([^`]*)`\}/.exec(source)?.[1] ?? "";
  assert.doesNotMatch(header, /compactOnMobile/, "the left padding does not depend on the page");
  for (const cls of ["pl-14", "md:px-8"]) assert.ok(header.split(/\s+/).includes(cls), cls);
});
