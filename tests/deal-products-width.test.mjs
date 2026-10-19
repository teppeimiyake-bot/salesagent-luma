import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 商談詳細「プロダクト構成」表の幅。PC（ウィンドウ約1700px）では左カラムが約780px しかなく、
// 表の最小幅がそれを超えると削除ボタンが横スクロールの先に隠れる。
// 列幅の合計と min-w を実際の描画結果から読み、PC幅に収まることを確かめる。
// それより狭いPC幅（1280〜1457px）では横スクロールが残るため、削除列は右端に sticky で固定する。
const require = createRequire(import.meta.url);
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime");
const { DealProductsPanel } = require("../src/components/deals/deal-products-panel.tsx");

// 1700px 時の実測（約782px、スクロールバー10px込み）に余裕を持たせた上限。
const PC_LEFT_COLUMN_PX = 760;
// rem の基準は globals.css の html { font-size }（15px）。Tailwind v4 の spacing 1 単位は 0.25rem。
const ROOT_FONT_PX = Number(
  /html,\s*body\s*\{[^}]*\bfont-size:\s*(\d+(?:\.\d+)?)px/.exec(
    readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8"),
  )?.[1],
);
const SPACING_PX = ROOT_FONT_PX / 4;
const router = { refresh() {}, push() {}, replace() {}, prefetch() {}, back() {}, forward() {} };

function renderPanel(canEdit) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(DealProductsPanel, {
      dealId: "d1",
      canEdit,
      planProposalMasters: [],
      products: [{ id: "p1", name: "アライアンス", category: null, plans: [{ id: "pl1", name: "スタンダード", basePrice: 300000 }] }],
      initial: [{
        id: "dp1", productId: "p1", productName: "アライアンス", planName: "スタンダード", planProposals: [],
        probability: 30, amount: 12000000, yomiStatus: "締結済み", ownerUserId: null, notes: null, owner: null,
        product: { id: "p1", name: "アライアンス" },
      }],
    })));
}

function tableWidths(html) {
  const table = /<table class="([^"]*)"/.exec(html);
  assert.ok(table, "product table is rendered");
  const minWidth = Number(/\bmin-w-\[(\d+)px\]/.exec(table[1])?.[1]);
  const header = /<thead>(.*?)<\/thead>/s.exec(html)[1];
  const columns = [...header.matchAll(/<th class="[^"]*\bw-\[(\d+)px\][^"]*"/g)].map((m) => Number(m[1]));
  return { minWidth, columns, sum: columns.reduce((a, b) => a + b, 0) };
}

// renderToStaticMarkup は属性値の & > などを実体参照にするので戻してから比べる。
const unescape = (s) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const classesOf = (tag) => unescape(tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);

test("root font size is read from globals.css", () => {
  assert.equal(ROOT_FONT_PX, 15);
});

test("editable product table fits the PC left column with the delete button", () => {
  const html = renderPanel(true);
  const { minWidth, columns, sum } = tableWidths(html);
  assert.equal(columns.length, 5);
  // table-fixed: 表の幅は max(min-w, 列幅合計)。どちらも PC の左カラムに収まること。
  assert.equal(sum, minWidth);
  assert.ok(minWidth <= PC_LEFT_COLUMN_PX, `min width ${minWidth}px exceeds ${PC_LEFT_COLUMN_PX}px`);
  // 提案金額列は入力欄 w-32(120px)+px-2 左右(15px)、削除列はボタン h-7 w-7(26.25px)+px-2 左右を下回らない。
  assert.match(html, /<input[^>]*class="[^"]*\bw-32\b/);
  const amountMin = 32 * SPACING_PX + 2 * 2 * SPACING_PX;
  assert.ok(columns[3] >= amountMin, `amount column ${columns[3]}px is narrower than its input (${amountMin}px)`);
  assert.match(html, /<button[^>]*class="[^"]*\bh-7 w-7\b[^"]*"[^>]*title="削除"/);
  const actionMin = 7 * SPACING_PX + 2 * 2 * SPACING_PX;
  assert.ok(columns[4] >= actionMin, `action column ${columns[4]}px is narrower than the delete button (${actionMin}px)`);
  // スマホ幅では従来どおり横スクロールで逃がす。
  // Phones keep horizontal scrolling; the scroll padding keeps a focused input clear of the sticky delete column.
  assert.match(html, /<div data-product-table-scroll="true" class="overflow-x-auto \[scroll-padding-inline-end:calc\(50px\+0\.5rem\)\]"><table /);
});

test("delete column stays pinned to the right edge with an opaque background", () => {
  const html = renderPanel(true);
  const header = /<thead>(.*?)<\/thead>/s.exec(html)[1];
  const lastTh = [...header.matchAll(/<th\b[^>]*>/g)].at(-1)[0];
  for (const c of ["sticky", "right-0", "bg-white"]) assert.ok(classesOf(lastTh).includes(c), `delete header lacks ${c}`);

  const rows = [...html.matchAll(/<tr class="([^"]*)">(.*?)<\/tr>/gs)].filter((m) => m[2].includes('title="削除"'));
  assert.ok(rows.length > 0, "a row with the delete button is rendered");
  for (const [, trClass, body] of rows) {
    // 行 hover:bg-zinc-50/50 に合わせ、削除セルは group-hover で同じ色（白地に重ねた不透明色）にする。
    assert.ok(trClass.split(/\s+/).includes("group/row"), "product row is the hover group");
    assert.ok(trClass.split(/\s+/).includes("hover:bg-zinc-50/50"));
    const lastTd = [...body.matchAll(/<td\b[^>]*>/g)].at(-1)[0];
    assert.match(body.slice(body.lastIndexOf(lastTd)), /title="削除"/, "delete button is in the last cell");
    const cls = classesOf(lastTd);
    for (const c of ["sticky", "right-0", "bg-white"]) assert.ok(cls.includes(c), `delete cell lacks ${c}`);
    assert.ok(
      cls.includes("group-hover/row:bg-[color-mix(in_srgb,var(--color-zinc-50)_50%,white)]"),
      "delete cell matches the row hover colour",
    );
  }
});

test("long product and plan names can shrink inside their select triggers", () => {
  const html = renderPanel(true);
  // Radix の SelectValue はトリガー（flex）直下の pointer-events:none の span。min-width:auto のままだと縮まず、
  // 内側の truncate が効かないまま隣の列にはみ出す。SelectValue は className を捨てるので、
  // トリガーの [&>span]:min-w-0 で値の span に min-width:0 を当てていることを確かめる。
  for (const name of ["アライアンス", "スタンダード"]) {
    const trigger = new RegExp(
      `(<button[^>]*role="combobox"[^>]*>)<span style="pointer-events:none"><span class="block truncate text-left">${name}</span></span>`,
    ).exec(html);
    assert.ok(trigger, `select value for ${name} is the trigger's direct child span`);
    assert.ok(classesOf(trigger[1]).includes("[&>span]:min-w-0"), `value span for ${name} cannot shrink (no [&>span]:min-w-0)`);
  }
});

test("read-only product table keeps the same minimum width without the action column", () => {
  const html = renderPanel(false);
  const { minWidth, columns, sum } = tableWidths(html);
  assert.equal(columns.length, 4);
  assert.ok(sum <= minWidth);
  assert.ok(minWidth <= PC_LEFT_COLUMN_PX);
  assert.doesNotMatch(html, /title="削除"/);
  assert.doesNotMatch(html, /\bsticky right-0\b/);
});
