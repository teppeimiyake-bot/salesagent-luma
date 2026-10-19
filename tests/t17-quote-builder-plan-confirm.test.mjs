import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";

// T17: プラン/企画案（DealProduct）を選ぶと明細が提案内容で置き換わる。
// テンプレート適用と同じく、入力済みの明細があるときは画面内で確認し、やめたら明細も選択も元のまま残す。
// 明細が空（初期状態・空行を足しただけ）のときは確認を挟まない。
// 「入力あり」は初期の空行と1項目でも違うこと（品目名・単価に限らず、補足・数量・単位・税区分も守る）。
// テンプレート適用も同じ判定を使うので、テンプレート側も合わせて確かめる。
// 実物の QuoteBuilder を最小のフック実行環境で動かし、UI部品・アイコン・React は差し替える
// （tests/t14-quote-builder-notes.test.mjs と同じ描き方）。
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
  plugins: [{ name: "t17-builder-stubs", setup(b) {
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

const DEAL_PRODUCTS = [
  { id: "dp-a", productName: "採用動画", planName: "スタンダード", planProposals: ["社員インタビュー", "職場紹介"], amount: 500_000 },
  { id: "dp-b", productName: "SNS運用", planName: null, planProposals: [], amount: 200_000 },
];
const SUGGESTED = { "dp-a": 480_000, "dp-b": 180_000 };

function createServer({ quotes = [], templates = [] } = {}) {
  const server = {
    suggests: [],
    writes: [],
    async fetch(url, init = {}) {
      const method = init.method ?? "GET";
      if (url === "/api/admin/quote-settings/defaults") return Response.json({ issuer: null, notes: null, canManage: false });
      if (url === "/api/quote-templates") return Response.json({ templates });
      if (url === "/api/deals/deal/quotes" && method === "GET") return Response.json({ quotes });
      if (url === "/api/quotes/suggest" && method === "POST") {
        const { dealProductId } = JSON.parse(init.body);
        server.suggests.push(dealProductId);
        return Response.json({ amount: SUGGESTED[dealProductId], source: "median", sampleSize: 3 });
      }
      if (method === "POST" || method === "PATCH") {
        server.writes.push({ method, url, body: JSON.parse(init.body) });
        return Response.json({ quote: { id: "saved" } });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    },
  };
  return server;
}

async function renderBuilder(server, { featureV2 = true } = {}) {
  const mocks = {};
  const loaded = { exports: {} };
  vm.runInNewContext(bundle, {
    module: loaded, exports: loaded.exports, mocks, fetch: (url, init) => server.fetch(url, init),
    setTimeout: () => 0, console,
  });
  const { QuoteBuilder } = loaded.exports;
  const runtime = mount(() => ({
    type: QuoteBuilder,
    props: { dealId: "deal", companyName: "架空商事株式会社", dealProducts: DEAL_PRODUCTS, canEdit: true, featureV2 },
  }));
  mocks.hooks = runtime.hooks;
  runtime.start();
  await settle();
  const all = (match) => findAll(runtime.tree(), match);
  const inputs = (placeholder) => all((n) => n.type === "Input" && n.props.placeholder === placeholder);
  const view = {
    tree: () => runtime.tree(),
    text: () => textOf(runtime.tree()),
    buttons: (label) => all((n) => n.type === "Button" && textOf(n).includes(label)),
    async click(label) {
      const button = view.buttons(label)[0];
      assert.ok(button, `button ${label}`);
      await button.props.onClick();
      await settle();
    },
    async change(node, target) {
      await node.props.onChange({ target });
      await settle();
    },
    selectWith: (optionLabel) => all((n) => n.type === "select" && findAll(n, (o) => o.type === "option" && textOf(o) === optionLabel).length > 0),
    planSelect: () => view.selectWith("（手動で組む）")[0],
    async pickPlan(id) {
      await view.change(view.planSelect(), { value: id });
    },
    async pickTemplate(id) {
      const select = view.selectWith("（テンプレートを選択）")[0];
      assert.ok(select, "template select");
      await view.change(select, { value: id });
    },
    prompt: () => all((n) => n.type === "div" && /入力中の明細を「[^」]*」の内容で置き換えます。よろしいですか？/.test(textOf(n)) && n.props.className?.includes("bg-amber-50"))[0],
    templatePrompt: () => all((n) => n.type === "div" && /入力中の明細をテンプレートの内容で置き換えます。よろしいですか？/.test(textOf(n)) && n.props.className?.includes("bg-amber-50"))[0],
    subject: () => inputs("例: 採用動画制作一式")[0].props.value,
    // 1行ぶんの入力欄の値（単価 0 は空文字、税区分は選択肢の値）
    row: (index = 0) => ({
      name: inputs("品目")[index].props.value,
      detail: inputs("補足（任意）")[index].props.value,
      qty: inputs("数量")[index].props.value,
      unit: inputs("単位")[index]?.props.value,
      price: inputs("単価(税抜)")[index].props.value,
      tax: view.selectWith("不課税")[index]?.props.value,
    }),
    async setField(placeholder, value, index = 0) {
      await view.change(inputs(placeholder)[index], { value });
    },
    async setTax(value, index = 0) {
      await view.change(view.selectWith("不課税")[index], { value });
    },
    lines: () => {
      const names = inputs("品目");
      const prices = inputs("単価(税抜)");
      return names.map((name, i) => [name.props.value, prices[i].props.value]);
    },
    async setItem(name, index = 0) {
      await view.change(inputs("品目")[index], { value: name });
    },
    async setPrice(price, index = 0) {
      await view.change(inputs("単価(税抜)")[index], { value: price });
    },
  };
  return view;
}

// 単価 0 は入力欄では空文字で出る（parseOptionalYen の逆）
const PLAN_A_LINES = [["採用動画 / スタンダード", 480_000]];
const PLAN_B_LINES = [["SNS運用", 180_000]];

test("T17 picking a plan on untouched lines fills them without asking (also after only adding blank rows)", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.click("明細を追加");
  assert.deepEqual(view.lines(), [["", ""], ["", ""]], "two blank rows, nothing typed");
  await view.pickPlan("dp-a");
  assert.equal(view.prompt(), undefined, "no confirmation when nothing would be lost");
  assert.deepEqual(server.suggests, ["dp-a"]);
  assert.equal(view.planSelect().props.value, "dp-a");
  assert.deepEqual(view.lines(), PLAN_A_LINES);
});

test("T17 picking a plan over typed lines asks first; cancelling keeps the lines and the previous selection", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.setItem("独自の撮影費");
  await view.setPrice("123000");
  await view.pickPlan("dp-a");

  const prompt = view.prompt();
  assert.ok(prompt, "an in-page confirmation is shown");
  assert.match(textOf(prompt), /入力中の明細を「採用動画 \/ スタンダード」の内容で置き換えます。よろしいですか？/);
  assert.deepEqual(server.suggests, [], "nothing is fetched or replaced before the user answers");
  assert.deepEqual(view.lines(), [["独自の撮影費", 123_000]]);
  assert.equal(view.planSelect().props.value, "", "the selection stays on the previous value while asking");

  await view.click("やめる");
  assert.equal(view.prompt(), undefined, "the confirmation closes");
  assert.deepEqual(server.suggests, []);
  assert.deepEqual(view.lines(), [["独自の撮影費", 123_000]], "the typed lines survive");
  assert.equal(view.planSelect().props.value, "", "the previous selection survives");

  await view.click("下書き保存");
  assert.equal(server.writes.length, 1);
  assert.equal(server.writes[0].body.dealProductId, null, "the cancelled plan is not saved");
  assert.deepEqual(server.writes[0].body.lines.map((l) => [l.name, l.unitPrice]), [["独自の撮影費", 123_000]]);
});

test("T17 confirming the replacement applies the plan's suggestion and selects it", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.setItem("独自の撮影費");
  await view.pickPlan("dp-a");
  await view.click("置き換える");
  assert.equal(view.prompt(), undefined);
  assert.deepEqual(server.suggests, ["dp-a"]);
  assert.equal(view.planSelect().props.value, "dp-a");
  assert.deepEqual(view.lines(), PLAN_A_LINES);
  assert.match(view.text(), /過去3件の中央値で単価をサジェストしました/);
});

test("T17 a price typed without an item name also counts as input to protect", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.setPrice("50000");
  await view.pickPlan("dp-b");
  assert.ok(view.prompt(), "confirmation for a typed unit price");
  assert.match(textOf(view.prompt()), /「SNS運用」/, "a plan without a plan name is shown by its product name");
  assert.deepEqual(server.suggests, []);
  assert.deepEqual(view.lines(), [["", 50_000]]);
});

test("T17 switching from one plan to another asks before discarding the first plan's lines, and keeps it selected on cancel", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.pickPlan("dp-a");
  assert.deepEqual(view.lines(), PLAN_A_LINES);
  await view.setPrice("470000");

  await view.pickPlan("dp-b");
  assert.ok(view.prompt());
  await view.click("やめる");
  assert.equal(view.planSelect().props.value, "dp-a", "the previously chosen plan stays selected");
  assert.deepEqual(view.lines(), [["採用動画 / スタンダード", 470_000]], "the adjusted price survives");
  assert.deepEqual(server.suggests, ["dp-a"]);

  await view.pickPlan("dp-b");
  await view.click("置き換える");
  assert.equal(view.planSelect().props.value, "dp-b");
  assert.deepEqual(view.lines(), PLAN_B_LINES);
  assert.deepEqual(server.suggests, ["dp-a", "dp-b"]);
});

test("T17 editing a saved quote: picking a plan does not silently replace the saved lines", async () => {
  const quote = {
    id: "q1", clientName: "架空社", clientHonorific: "御中", subject: "既存件名", note: null,
    taxRate: 10, version: null, status: "draft", documentId: null, createdAt: "2026-09-30T00:00:00+09:00",
    issueDate: "2026-09-30T00:00:00+09:00", dealProduct: { id: "dp-a", productName: "採用動画", planName: "スタンダード" },
    lines: [{ name: "保存済みの明細", qty: 2, unitPrice: 300_000, unit: "本", taxCategory: "taxable", taxRate: 10 }],
  };
  const server = createServer({ quotes: [quote] });
  const view = await renderBuilder(server);
  // 新規フォームで確認を出したまま、一覧の「編集」に移っても前の確認は持ち越さない
  await view.click("新規作成");
  await view.setItem("書きかけの明細");
  await view.pickPlan("dp-b");
  assert.ok(view.prompt());
  await view.click("編集");
  assert.equal(view.prompt(), undefined, "the question from the other form is gone");
  assert.equal(view.planSelect().props.value, "dp-a");
  await view.pickPlan("dp-b");
  assert.ok(view.prompt());
  await view.click("やめる");
  assert.equal(view.planSelect().props.value, "dp-a");
  assert.deepEqual(view.lines(), [["保存済みの明細", 300_000]]);
  await view.click("下書き保存");
  assert.deepEqual(server.writes.map((w) => [w.method, w.url, w.body.dealProductId, w.body.lines.map((l) => l.name)]), [
    ["PATCH", "/api/quotes/q1", "dp-a", ["保存済みの明細"]],
  ]);
  assert.deepEqual(server.suggests, []);
});

test("T17 an unanswered confirmation does not linger into the next form, and choosing manual entry dismisses it", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.setItem("独自の撮影費");
  await view.pickPlan("dp-a");
  assert.ok(view.prompt());
  await view.click("キャンセル");
  await view.click("新規作成");
  assert.equal(view.prompt(), undefined, "a new form starts without the old question");
  assert.deepEqual(view.lines(), [["", ""]]);

  await view.setItem("独自の撮影費");
  await view.pickPlan("dp-a");
  assert.ok(view.prompt());
  await view.pickPlan("");
  assert.equal(view.prompt(), undefined, "switching back to manual entry replaces nothing and closes the question");
  assert.equal(view.planSelect().props.value, "");
  assert.deepEqual(view.lines(), [["独自の撮影費", ""]]);
  assert.deepEqual(server.suggests, []);
});

test("T17 the confirmation also protects typed lines when the quote PDF v2 flag is off", async () => {
  const server = createServer();
  const view = await renderBuilder(server, { featureV2: false });
  await view.click("新規作成");
  await view.setItem("旧画面で入力した明細");
  await view.pickPlan("dp-a");
  assert.ok(view.prompt());
  await view.click("やめる");
  assert.deepEqual(view.lines(), [["旧画面で入力した明細", ""]]);
  assert.equal(view.planSelect().props.value, "");
  assert.deepEqual(server.suggests, []);
});

// ---- 入力判定は「初期の空行と違うか」（品目名・単価以外だけを変えた行も守る） ----

const TEMPLATE = {
  id: "tpl-1", name: "標準一式",
  lines: [{ id: "tl-1", templateId: "tpl-1", name: "テンプレ行", detail: "テンプレ補足", qty: 2, unitPrice: 1_000, unit: "式", taxCategory: "taxable", taxRate: 10 }],
};

const BLANK_ROW = { name: "", detail: "", qty: 1, unit: "式", price: "", tax: "taxable" };
// 品目名・単価には触れず、1項目だけを初期値から変える操作
const SINGLE_FIELD_EDITS = [
  { label: "補足", edit: (view, i) => view.setField("補足（任意）", "撮影2日・編集込み", i), expect: { detail: "撮影2日・編集込み" } },
  { label: "数量", edit: (view, i) => view.setField("数量", "5", i), expect: { qty: 5 } },
  { label: "単位", edit: (view, i) => view.setField("単位", "本", i), expect: { unit: "本" } },
  { label: "税区分", edit: (view, i) => view.setTax("non_taxable", i), expect: { tax: "non_taxable" } },
];

for (const { label, edit, expect } of SINGLE_FIELD_EDITS) {
  test(`T17 a plan does not silently replace a line where only the ${label} was changed`, async () => {
    const server = createServer();
    const view = await renderBuilder(server);
    await view.click("新規作成");
    await edit(view, 0);
    const edited = { ...BLANK_ROW, ...expect };
    assert.deepEqual(view.row(0), edited, `only the ${label} differs from a blank line`);

    await view.pickPlan("dp-a");
    assert.ok(view.prompt(), `a changed ${label} alone asks before replacing`);
    assert.deepEqual(server.suggests, [], "nothing is fetched before the user answers");
    await view.click("やめる");
    assert.deepEqual(view.row(0), edited, `the ${label} survives cancelling`);
    assert.equal(view.planSelect().props.value, "");
    assert.deepEqual(server.suggests, []);
  });

  test(`T17 a template does not silently replace a line where only the ${label} was changed`, async () => {
    const server = createServer({ templates: [TEMPLATE] });
    const view = await renderBuilder(server);
    await view.click("新規作成");
    await edit(view, 0);
    const edited = { ...BLANK_ROW, ...expect };
    await view.pickTemplate("tpl-1");
    assert.ok(view.templatePrompt(), `a changed ${label} alone asks before applying the template`);
    assert.deepEqual(view.row(0), edited, "nothing is replaced before the user answers");
    await view.click("やめる");
    assert.equal(view.templatePrompt(), undefined);
    assert.deepEqual(view.row(0), edited, `the ${label} survives cancelling`);
  });
}

test("T17 a template on untouched lines applies without asking; typed-then-cleared or blank-looking lines are still untouched", async () => {
  const server = createServer({ templates: [TEMPLATE] });
  const view = await renderBuilder(server);
  await view.click("新規作成");
  // 入力してから元に戻した行・空白だけの品目名・空行の追加は「入力あり」にしない（比べるのは中身）
  await view.setItem("書いて消した");
  await view.setItem("");
  await view.setField("補足（任意）", "  ");
  await view.setField("単位", " 式 ");
  await view.click("明細を追加");
  await view.pickTemplate("tpl-1");
  assert.equal(view.templatePrompt(), undefined, "nothing would be lost, so no question");
  assert.deepEqual(view.lines(), [["テンプレ行", 1_000]]);
  assert.equal(view.row(0).detail, "テンプレ補足");
});

test("T17 a saved line is compared only on the fields a blank line has (a stored id or a null 補足 is not input)", async () => {
  const quote = {
    id: "q-blank", clientName: "架空社", clientHonorific: "御中", subject: null, note: null,
    taxRate: 10, version: null, status: "draft", documentId: null, createdAt: "2026-09-30T00:00:00+09:00",
    issueDate: "2026-09-30T00:00:00+09:00", dealProduct: null,
    lines: [{ id: "ql-1", quoteId: "q-blank", sortOrder: 0, name: "", detail: null, qty: 1, unitPrice: 0, unit: "式", taxCategory: "taxable", taxRate: 10 }],
  };
  const server = createServer({ quotes: [quote] });
  const view = await renderBuilder(server);
  await view.click("編集");
  await view.pickPlan("dp-b");
  assert.equal(view.prompt(), undefined, "a line equal to a blank line apart from its stored ids asks nothing");
  assert.deepEqual(server.suggests, ["dp-b"]);
  assert.deepEqual(view.lines(), PLAN_B_LINES);
});

test("T17 input only on the second (or a later) line still asks before a plan or a template replaces the lines", async () => {
  const server = createServer({ templates: [TEMPLATE] });
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.click("明細を追加");
  await view.click("明細を追加");
  await view.setItem("3行目だけの明細", 2);
  assert.deepEqual(view.lines(), [["", ""], ["", ""], ["3行目だけの明細", ""]]);

  await view.pickPlan("dp-a");
  assert.ok(view.prompt(), "a later line with input is protected too");
  await view.click("やめる");
  assert.deepEqual(view.lines(), [["", ""], ["", ""], ["3行目だけの明細", ""]]);
  assert.deepEqual(server.suggests, []);

  await view.pickTemplate("tpl-1");
  assert.ok(view.templatePrompt(), "the template path uses the same check");
  await view.click("やめる");
  assert.deepEqual(view.lines(), [["", ""], ["", ""], ["3行目だけの明細", ""]]);

  // 2行目の補足だけ、でも同じ
  const server2 = createServer();
  const view2 = await renderBuilder(server2);
  await view2.click("新規作成");
  await view2.click("明細を追加");
  await view2.setField("補足（任意）", "2行目の補足", 1);
  await view2.pickPlan("dp-b");
  assert.ok(view2.prompt());
  assert.deepEqual(server2.suggests, []);
});

// ---- 登録済みのプランかどうかの判定（「（手動で組む）」は置き換えないので確認しない） ----

test("T17 after a plan filled and the user edited the lines, choosing manual entry follows the choice without asking and keeps the lines", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.pickPlan("dp-a");
  assert.equal(view.planSelect().props.value, "dp-a");
  await view.setPrice("470000");

  await view.pickPlan("");
  assert.equal(view.prompt(), undefined, "manual entry replaces nothing, so there is nothing to confirm");
  assert.equal(view.planSelect().props.value, "", "the selection follows the user's choice of manual entry");
  assert.deepEqual(view.lines(), [["採用動画 / スタンダード", 470_000]], "the edited lines stay");
  assert.deepEqual(server.suggests, ["dp-a"], "nothing more is fetched");

  await view.click("下書き保存");
  assert.equal(server.writes.length, 1);
  assert.equal(server.writes[0].body.dealProductId, null, "the draft no longer points at plan A");
  assert.deepEqual(server.writes[0].body.lines.map((l) => [l.name, l.unitPrice]), [["採用動画 / スタンダード", 470_000]]);
});

// ---- 「やめる」は件名も変えない ----

test("T17 cancelling the confirmation leaves the subject (件名) as it was", async () => {
  const server = createServer();
  const view = await renderBuilder(server);
  await view.click("新規作成");
  await view.setItem("独自の撮影費");
  await view.pickPlan("dp-a");
  assert.ok(view.prompt());
  assert.equal(view.subject(), "", "the subject is not filled while asking");
  await view.click("やめる");
  assert.equal(view.subject(), "", "nor after cancelling");

  await view.click("下書き保存");
  assert.equal(server.writes[0].body.subject, null, "the cancelled plan's name is not saved as the subject");
  assert.equal(server.writes[0].body.dealProductId, null);

  // 置き換えたときだけ件名が入る（件名欄が空の場合）
  const server2 = createServer();
  const view2 = await renderBuilder(server2);
  await view2.click("新規作成");
  await view2.setItem("独自の撮影費");
  await view2.pickPlan("dp-a");
  await view2.click("置き換える");
  assert.equal(view2.subject(), "採用動画 / スタンダード");
});

// ---- テンプレートのプルダウンは確認の結果に合わせて戻る（非制御の select だと名前が残った） ----

test("T17 the template select shows the picked template only while asking, and returns to the placeholder after cancel or apply", async () => {
  const server = createServer({ templates: [TEMPLATE] });
  const view = await renderBuilder(server);
  const templateSelect = () => view.selectWith("（テンプレートを選択）")[0];
  await view.click("新規作成");
  assert.equal(templateSelect().props.value, "", "starts on the placeholder");
  assert.equal("defaultValue" in templateSelect().props, false, "the select is controlled");

  await view.setItem("独自の撮影費");
  await view.pickTemplate("tpl-1");
  assert.ok(view.templatePrompt());
  assert.equal(templateSelect().props.value, "tpl-1", "the picked template is shown while asking");

  await view.click("やめる");
  assert.equal(view.templatePrompt(), undefined);
  assert.equal(templateSelect().props.value, "", "cancelling returns to the placeholder so it does not look applied");
  assert.deepEqual(view.lines(), [["独自の撮影費", ""]]);

  // 同じテンプレートを選び直せる（値が変わるので change が起きる）
  await view.pickTemplate("tpl-1");
  assert.ok(view.templatePrompt(), "the same template can be picked again");
  await view.click("置き換える");
  assert.equal(view.templatePrompt(), undefined);
  assert.deepEqual(view.lines(), [["テンプレ行", 1_000]]);
  assert.equal(templateSelect().props.value, "", "after applying the select is ready for the next pick");

  // 確認を出したままフォームを閉じても次のフォームへ持ち越さない
  await view.setPrice("2000");
  await view.pickTemplate("tpl-1");
  assert.ok(view.templatePrompt());
  await view.click("キャンセル");
  await view.click("新規作成");
  assert.equal(view.templatePrompt(), undefined, "a new form starts without the old template question");
  assert.equal(templateSelect().props.value, "");
});

// ---- T14: 明細の数量・単位・単価が狭いカードでも読める幅を持つ ----

test("T14 quantity, unit and unit price inputs keep a readable width instead of a 1/12 grid column", async () => {
  for (const featureV2 of [true, false]) {
    const server = createServer();
    const view = await renderBuilder(server, { featureV2 });
    await view.click("新規作成");
    const tree = view.tree();
    const labels = findAll(tree, (n) => n.type === "label");
    const wrapperOf = (placeholder) => labels.find((label) => findAll(label, (n) => n.type === "Input" && n.props.placeholder === placeholder).length > 0);
    const expected = featureV2
      ? [["数量", /\bw-20\b/, "数量"], ["単位", /\bw-20\b/, "単位"], ["単価(税抜)", /\bmin-w-\[9rem\]/, "単価（税抜）"]]
      : [["数量", /\bw-20\b/, "数量"], ["単価(税抜)", /\bmin-w-\[9rem\]/, "単価（税抜）"]];
    for (const [placeholder, width, caption] of expected) {
      const wrapper = wrapperOf(placeholder);
      assert.ok(wrapper, `${placeholder} has a labelled wrapper (featureV2=${featureV2})`);
      assert.match(wrapper.props.className, width, `${placeholder} has a fixed minimum width`);
      assert.match(textOf(wrapper), new RegExp(caption.replace(/[()（）]/g, "\\$&")), `${placeholder} shows a visible caption`);
      const input = findAll(wrapper, (n) => n.type === "Input")[0];
      assert.match(input.props.className, /\bpx-2\b/, `${placeholder} uses a smaller horizontal padding`);
    }
    assert.equal(findAll(tree, (n) => typeof n.props?.className === "string" && /\bcol-span-1\b|\bgrid-cols-12\b/.test(n.props.className)).length, 0,
      "no line field sits in a 1/12 grid column");
    const rows = findAll(tree, (n) => typeof n.props?.className === "string" && n.props.className.includes("flex-wrap") && findAll(n, (c) => c.type === "Input" && c.props.placeholder === "数量").length > 0 && !findAll(n, (c) => c.type === "Input" && c.props.placeholder === "品目").length);
    assert.equal(rows.length, 1, "the numeric fields wrap onto the next line when the card is narrow");
  }
});
