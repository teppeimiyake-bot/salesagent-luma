import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// UI確認 2026-10-01（Edge/Chrome、1440px）：ダッシュボード「あなたの進行中商談」でネクストアクションの文が担当者のアバターと名前に重なり、
// 商談一覧（全件）では担当者のアバターの左半分がネクストアクションの入力欄の後ろに隠れた。
// 担当者の列（md:col-span-2 / xl:col-span-2）は右寄せ（justify-end）の flex で、担当者バッジ（inline-flex）が縮めないため、
// 長い名前では列の左側（ネクストアクションの列）へはみ出していた。
// 担当者バッジが列の幅まで縮み、名前が「…」で切り詰められる（全文は title で読める）ことを描画結果で確かめる。
const require = createRequire(import.meta.url);
const { AppRouterContext } = require("next/dist/shared/lib/app-router-context.shared-runtime");
const { DealsTable } = require("../src/components/dashboard/deals-table.tsx");

const router = { refresh() {}, push() {}, replace() {}, prefetch() {}, back() {}, forward() {} };
const OWNER = "架空検証・Edge 管理者";
const deal = {
  id: "d1", title: "商談", status: "PROPOSAL",
  nextAction: "営業担当が、来週の金曜日までに、撮影可能範囲を考慮した構成案と見積もり書を作成し、森田氏へ送付する。",
  nextActionAt: null,
  company: { id: "c1", name: "架空 みずなら精機株式会社（uicheck-20261001）", industry: null },
  owner: { id: "u1", name: OWNER, avatarColor: "#6366f1" },
  products: [],
};

const unescape = (s) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const classesOf = (tag) => unescape(/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

function render(props) {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
    createElement(DealsTable, { deals: [deal], canDelete: true, ...props })));
}

/** 担当者の列（セル）・名前を包む枠・担当者バッジの根・名前の <p> の開始タグを返す。 */
function ownerTags(html) {
  const nameAt = html.indexOf(`>${OWNER}</p>`);
  assert.ok(nameAt > 0, "owner name is rendered");
  const before = html.slice(0, nameAt + 1);
  const tags = [...before.matchAll(/<(div|p|span)\b[^>]*>/g)].map((m) => m[0]);
  const name = tags.at(-1);
  // バッジの根は「アバター＋名前」を並べる inline-flex。
  const badgeIdx = tags.findLastIndex((t) => classesOf(t).includes("inline-flex") && classesOf(t).includes("gap-2"));
  assert.ok(badgeIdx > 0, "owner badge root is rendered");
  const cellIdx = tags.findLastIndex((t) => classesOf(t).includes("justify-end") && classesOf(t).includes("gap-1"));
  assert.ok(cellIdx > 0 && cellIdx < badgeIdx, "owner cell is rendered");
  return { cell: tags[cellIdx], wrap: tags[badgeIdx - 1], badge: tags[badgeIdx], name };
}

for (const [label, props] of [
  ["dashboard (display only)", {}],
  ["deals list (editable, stackOnTablet)", { editable: true, stackOnTablet: true, showAllLink: false }],
]) {
  test(`owner badge shrinks to its column and truncates the name: ${label}`, () => {
    const { cell, wrap, badge, name } = ownerTags(render(props));
    // セルと枠は grid / flex の子として内容幅より狭くなれる。
    assert.ok(classesOf(cell).includes("min-w-0"), cell);
    assert.ok(classesOf(wrap).includes("min-w-0"), wrap);
    assert.ok(classesOf(wrap).includes("flex-1"), wrap);
    // バッジ自身も縮められ、列の幅を超えない（はみ出して左の列に重ならない）。
    assert.ok(classesOf(badge).includes("min-w-0"), badge);
    assert.ok(classesOf(badge).includes("max-w-full"), badge);
    // 名前は1行で「…」に切り詰め、全文は title で読める。
    assert.ok(classesOf(name).includes("truncate"), name);
    assert.match(wrap, new RegExp(`title="${OWNER}"`));
  });
}

test("owner column keeps its grid span (other columns keep their widths)", () => {
  // 列の配分（4/3/3/2）は変えず、はみ出しはバッジの切り詰めで吸収する。390px では col-span-12 で縦に積む。
  const html = render({ editable: true, stackOnTablet: true, showAllLink: false });
  const { cell } = ownerTags(html);
  assert.ok(classesOf(cell).includes("xl:col-span-2"), cell);
  assert.ok(classesOf(cell).includes("col-span-12"), cell);
});

// 追加調整（2026-10-01）：ダッシュボード（1440px、本文 約735px）では担当者の列が約103pxしかなく、削除ボタン・矢印を除くと
// 名前は約25px（2文字ほど）で「…」になっていた。lg 以上ではダッシュボードの列配分を 8:5:5:7 にし（提案金額とネクストアクションを少し狭める。1280px では右に AI チャットが出て本文が狭くなるため 6 では2px足りなかった）、
// ふつうの長さの名前（「開発 管理者」約59px）が読める幅（担当者の列 約163px）を確保する。md（768〜1023px）とスマホ幅は従来の配分のまま。
test("dashboard rows give the owner column a readable share from lg up, keeping md and phone layouts", () => {
  const html = render({});
  const row = /<div class="relative grid [^"]*"/.exec(html)?.[0];
  assert.ok(row, "row is rendered");
  assert.ok(classesOf(row).includes("grid-cols-12"), row);
  assert.ok(classesOf(row).includes("lg:grid-cols-[minmax(0,8fr)_minmax(0,5fr)_minmax(0,5fr)_minmax(0,7fr)]"), row);
  const cells = [...html.matchAll(/<div class="([^"]*)"/g)].map((m) => unescape(m[1]).split(/\s+/))
    .filter((c) => c.some((x) => /^md:col-span-\d+$/.test(x)));
  assert.deepEqual(cells.map((c) => c.find((x) => x.startsWith("md:col-span-"))), ["md:col-span-4", "md:col-span-3", "md:col-span-3", "md:col-span-2"]);
  for (const c of cells) assert.ok(c.includes("lg:col-span-1"), c.join(" "));
  // 商談一覧（stackOnTablet）は 1440px で名前が読める幅があるため、従来の xl:col-span の配分のまま。
  const list = render({ editable: true, stackOnTablet: true, showAllLink: false });
  assert.doesNotMatch(list, /lg:grid-cols-\[/);
});
