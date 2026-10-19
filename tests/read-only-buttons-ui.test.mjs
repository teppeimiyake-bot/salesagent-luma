// 閲覧のみ（操作中の会社での権限）では、書き込み・AI 呼び出し・外部取得のボタンを出さない・無効にする。
// API 側も 403 で止める（tests/write-guard-routes.test.mjs）が、押しても何も起きないように見えないよう画面でも止める。
// 実物のコンポーネントを最小のフック環境で動かす（tests/helpers/component-harness.mjs）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findAll, loadComponent, mountComponent, textOf } from "./helpers/component-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (file) => readFile(path.join(ROOT, file), "utf8");
// component-harness の読み込みに、next/link の差し替え（ただの要素）を足したもの
async function loadWithLink(entry) {
  const elements = "module.exports=Object.create(new Proxy({}, {get(_, name){if (typeof name !== 'string' || name === '__esModule' || name === 'then') return undefined;return (props)=>({type:name,props});}}));";
  const hooks = ["useState", "useRef", "useEffect", "useLayoutEffect", "useCallback", "useMemo", "useId", "useTransition"];
  const stubs = {
    react: hooks.map((h) => `export const ${h}=(...a)=>globalThis.__hooks.${h}(...a);`).join("") + "export default {};",
    "react/jsx-runtime": "export const Fragment=Symbol.for('fragment');export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;",
    "next/navigation": "export const useRouter=()=>globalThis.__router;",
    "next/link": "export default (props)=>({type:'Link',props});",
  };
  const result = await build({
    absWorkingDir: ROOT, entryPoints: [entry], bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic", logLevel: "silent",
    plugins: [{ name: "stubs", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.path in stubs) return { path: a.path, namespace: "stub" };
        if (a.path === "lucide-react" || a.path.startsWith("@/components/ui/")) return { path: a.path, namespace: "elements" };
        return undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js" }));
      b.onLoad({ filter: /.*/, namespace: "elements" }, () => ({ contents: elements, loader: "js" }));
    } }],
  });
  return result.outputFiles[0].text;
}
const buttons = (tree, match) => findAll(tree, (n) => (n.type === "Button" || n.type === "button") && match(n));

test("ToDo追加: 閲覧のみでは出さない", async () => {
  const bundle = await loadComponent("src/components/todos/new-task-dialog.tsx");
  const viewer = mountComponent(bundle, "NewTaskDialog", { canEdit: false });
  assert.equal(buttons(viewer.tree(), (n) => textOf(n).includes("ToDo追加")).length, 0);
  const user = mountComponent(bundle, "NewTaskDialog", {});
  assert.equal(buttons(user.tree(), (n) => textOf(n).includes("ToDo追加")).length, 1);
});

test("AIチャット: 閲覧のみでは送信・候補の質問を無効にし、理由を出す（履歴は読める）", async () => {
  const bundle = await loadComponent("src/components/dashboard/ai-chat.tsx");
  const app = mountComponent(bundle, "AiChat", { scope: "global", canSend: false }, (r) => (r.method === "GET" ? Response.json({ messages: [] }) : undefined));
  await app.settle();
  const tree = app.tree();
  assert.match(textOf(tree), /閲覧のみ/);
  const input = findAll(tree, (n) => n.type === "Input")[0];
  assert.equal(input.props.disabled, true);
  // 履歴の再読み込み（読み取り）以外のボタンはすべて無効
  for (const b of buttons(tree, (n) => n.props.title !== "再読み込み")) assert.equal(b.props.disabled, true, textOf(b));
  assert.equal(app.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(app.requests.filter((r) => r.method === "GET").length, 1, "履歴の取得はする");
});

test("ナレッジAI検索: 閲覧のみでは検索ボタンを無効にし、理由を出す", async () => {
  const bundle = await loadComponent("src/components/documents/knowledge-search.tsx");
  const app = mountComponent(bundle, "KnowledgeSearch", { canSearch: false });
  const tree = app.tree();
  assert.match(textOf(tree), /閲覧のみ/);
  for (const b of buttons(tree, () => true)) assert.equal(b.props.disabled, true, textOf(b));
});

const task = (id, extra = {}) => ({
  id, title: `架空のタスク${id}`, status: "OPEN", priority: null, impact: null, reason: null, expectedOutcome: null,
  isAiGenerated: false, dueDate: null, deal: { id: "deal-1", title: "架空商談", company: { name: "架空商事" }, owner: null }, ...extra,
});

test("タスク（商談詳細・ダッシュボード・ToDo一覧）: 閲覧のみでは完了・戻す・削除のボタンを無効にする", async () => {
  for (const [file, name] of [
    ["src/components/deals/tasks-list.tsx", "TasksList"],
    ["src/components/dashboard/ai-todo.tsx", "AiTodoList"],
    ["src/components/todos/tasks-all-list.tsx", "TasksAllList"],
  ]) {
    const bundle = await loadWithLink(file);
    const app = mountComponent(bundle, name, { tasks: [task("t1"), task("t2", { status: "DONE" })], canEdit: false });
    const actions = buttons(app.tree(), (n) => typeof n.props.onClick === "function" && n.type === "button");
    assert.ok(actions.length > 0, name);
    for (const b of actions) assert.equal(b.props.disabled, true, `${name}: ${b.props.title ?? textOf(b)}`);
    const writable = mountComponent(bundle, name, { tasks: [task("t1")] });
    assert.ok(buttons(writable.tree(), (n) => n.type === "button" && typeof n.props.onClick === "function" && !n.props.disabled).length > 0, `${name} 利用者は押せる`);
  }
});

test("ToDo一覧: 閲覧のみでは期日・ヨミ・金額の変更も無効にする", async () => {
  const text = await src("src/components/todos/tasks-all-list.tsx");
  assert.match(text, /export function TasksAllList\(\{ tasks, canEdit = true \}/);
  // 期日・ヨミ・金額・完了などの操作は pending で無効にしており、閲覧のみでは pending を常に true にする
  assert.match(text, /const pending = busy \|\| !canEdit;/);
});

test("AIパネル・商談の状態・会社: 閲覧のみでは「ToDoに追加」「AI提案」「ロゴ取得」「編集」「AI再要約」「連絡先の追加・編集・削除」を出さない", async () => {
  const panel = await src("src/components/deals/ai-panel.tsx");
  assert.match(panel, /canEdit = true/);
  assert.match(panel, /added \? \([\s\S]*?\) : canEdit \? \(/);
  const status = await src("src/components/deals/deal-status.tsx");
  assert.match(status, /\{canEdit && \(\s*<Button[\s\S]{0,200}onClick=\{suggestNext\}/);
  const hero = await src("src/components/companies/company-hero.tsx");
  assert.match(hero, /export function CompanyHero\(\{ company, stats, canEdit = true \}/);
  assert.match(hero, /\{canEdit && company\.websiteUrl && \(/);
  assert.match(hero, /\{canEdit && \(\s*<Button[\s\S]{0,120}setEditing\(!editing\)/);
  const tabs = await src("src/components/companies/company-tabs.tsx");
  assert.match(tabs, /\{canEdit && \(\s*<Button[\s\S]{0,120}onClick=\{fetchSummary\}/);
  assert.match(tabs, /<ContactsList[\s\S]{0,200}canEdit=\{canEdit\}/);
  assert.match(tabs, /\{canEdit && !adding && \(\s*<Button size="sm" variant="primary" onClick=\{\(\) => setAdding\(true\)\}/);
  assert.match(tabs, /<ContactCard key=\{c\.id\} contact=\{c\} canEdit=\{canEdit\}/);
  assert.match(tabs, /\{canEdit && \(\s*<div className="flex items-center gap-1 shrink-0">/);
});

test("画面: 各ページが操作中の会社の権限（canEdit）を部品に渡す", async () => {
  const dashboard = await src("src/app/(app)/dashboard/page.tsx");
  assert.match(dashboard, /right=\{canEdit \? <NewTaskDialog \/> : null\}/);
  assert.match(dashboard, /<AiTodoList tasks=\{merged\} canEdit=\{canEdit\} \/>/);
  assert.match(dashboard, /<AiChat scope="global" canSend=\{canEdit\} \/>/);
  const todos = await src("src/app/(app)/todos/page.tsx");
  assert.match(todos, /getCurrentPermission\(\)/);
  assert.match(todos, /right=\{canEdit \? <NewTaskDialog \/> : null\}/);
  assert.match(todos, /<TasksAllList tasks=\{merged\} canEdit=\{canEdit\} \/>/);
  const deal = await src("src/app/(app)/deals/[id]/page.tsx");
  assert.match(deal, /<TasksList tasks=\{deal\.tasks\} canEdit=\{canEdit\} \/>/);
  assert.match(deal, /<AiPanel dealId=\{deal\.id\} meeting=\{latestMeeting\} canEdit=\{canEdit\} \/>/);
  assert.match(deal, /<AiChat scope=\{`deal:\$\{deal\.id\}`\} canSend=\{canEdit\} \/>/);
  const docs = await src("src/app/(app)/documents/page.tsx");
  assert.match(docs, /<KnowledgeSearch canSearch=\{permission !== "viewer"\} \/>/);
  const company = await src("src/app/(app)/companies/[id]/page.tsx");
  assert.match(company, /<CompanyHero[\s\S]{0,40}canEdit=\{canEdit\}/);
});
