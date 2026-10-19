import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T14: 見積書の発行者設定（/admin/quote-settings）はサイドバーの管理者メニューから開ける。
// 見積テンプレート（T17）の隣に置き、同じく FEATURE_QUOTE_PDF_V2 がOFFなら出さない（quoteV2Only）。
// 実物の Sidebar を束ね、フック・リンク・アイコンなどの部品だけ差し替えて描画する。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/components/layout/sidebar.tsx";
const lucideNames = /import\s*\{([^}]+)\}\s*from\s*"lucide-react"/.exec(readFileSync(path.join(ROOT, ENTRY), "utf8"))[1]
  .split(",").map((name) => name.trim()).filter(Boolean);
const component = (name) => `(props)=>({type:${JSON.stringify(name)},props})`;
const stubs = {
  react: "export const useState=(initial)=>[typeof initial==='function'?initial():initial,()=>{}];",
  "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props)=>({type,props});export const jsxs=jsx;",
  "next/link": `export default ${component("Link")};`,
  "next/navigation": "export const usePathname=()=>'/dashboard';export const useRouter=()=>({push(){},refresh(){}});",
  "@/lib/utils": "export const cn=(...c)=>c.filter(Boolean).join(' ');",
  "@/components/ui/dialog": ["Dialog", "DialogContent", "DialogTitle", "DialogTrigger"].map((n) => `export const ${n}=${component(n)};`).join(""),
  "@/components/layout/tenant-tabs": `export const TenantTabs=${component("TenantTabs")};export const ALL_TENANTS_CODE="__all__";`,
  "lucide-react": lucideNames.map((name) => `export const ${name}=${component(name)};`).join(""),
};
const bundle = (await build({
  absWorkingDir: ROOT, entryPoints: [ENTRY], bundle: true, write: false, format: "cjs", platform: "neutral", jsx: "automatic", logLevel: "silent",
  plugins: [{ name: "t14-sidebar-stubs", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      if (a.kind === "entry-point") return { path: path.join(ROOT, a.path) };
      if (a.path in stubs) return { path: a.path, namespace: "stub" };
      return { errors: [{ text: `Unexpected dependency of ${ENTRY}: ${a.path}` }] };
    });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
  } }],
})).outputFiles[0].text;
const loaded = { exports: {} };
vm.runInNewContext(bundle, { module: loaded, exports: loaded.exports, fetch() { throw new Error("no network"); } });
const { Sidebar } = loaded.exports;

function links(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) links(child, found);
    return found;
  }
  if (typeof node.type === "function") return links(node.type(node.props), found);
  if (node.type === "Link") found.push({ href: node.props.href, label: [node.props.children].flat().filter((c) => typeof c === "string").join("") });
  return links(node.props?.children, found);
}
const user = (permission) => ({ name: "管理者", email: "admin@example.invalid", avatarColor: null, permission });
const hrefs = (props) => links(Sidebar(props)).map((link) => link.href);

test("T14 the admin menu links to the issuer settings right after the quote templates when quote PDF v2 is on", () => {
  const menu = hrefs({ user: user("admin"), quoteTemplatesEnabled: true });
  const at = menu.indexOf("/admin/quote-templates");
  assert.ok(at >= 0, "the quote templates link is there");
  assert.equal(menu[at + 1], "/admin/quote-settings", "the issuer settings sit next to the quote templates");
  const link = links(Sidebar({ user: user("admin"), quoteTemplatesEnabled: true })).find((l) => l.href === "/admin/quote-settings");
  assert.equal(link.label, "見積書の発行者設定");
});

test("T14 the issuer settings link follows the quote templates gating: hidden when quote PDF v2 is off and for non-admins", () => {
  const off = hrefs({ user: user("admin"), quoteTemplatesEnabled: false });
  assert.ok(off.includes("/admin/users"), "the admin menu is still shown");
  assert.equal(off.includes("/admin/quote-templates"), false);
  assert.equal(off.includes("/admin/quote-settings"), false, "the settings are hidden with the flag off, like the templates");
  for (const permission of ["user", "viewer"]) {
    assert.equal(hrefs({ user: user(permission), quoteTemplatesEnabled: true }).includes("/admin/quote-settings"), false, permission);
  }
});
