import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// T16（2026-09-30 meet-status、仕様確認扱い）：自動取得を打ち切った自社Meetの商談は、商談一覧でも小さな「要対応」で気付けるようにする。
// 判定（dealIdsNeedingMeetAttention）は tests/t16-ingest.test.mjs、ここでは一覧の行の表示と、一覧ページのつなぎ込みを確かめる。
const require = createRequire(import.meta.url);
const { DealsTable } = require("../src/components/dashboard/deals-table.tsx");

const row = (id, extra = {}) => ({
  id, title: `商談${id}`, status: "LEAD", nextAction: null, nextActionAt: null,
  company: { id: `c-${id}`, name: `デモ企業${id}`, industry: null }, owner: null, products: [], ...extra,
});
const rowHtml = (html, id) => {
  const start = html.indexOf(`href="/deals/${id}"`);
  const next = html.indexOf('href="/deals/', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
};

test("T16 deals list shows a small 要対応 only on rows whose Meet record needs attention", () => {
  const html = renderToStaticMarkup(createElement(DealsTable, {
    deals: [row("a", { meetAttention: true }), row("b", { meetAttention: false }), row("c")],
  }));
  assert.equal(html.match(/data-testid="deal-meet-attention"/g)?.length, 1);
  assert.match(rowHtml(html, "a"), /data-testid="deal-meet-attention"[^>]*>.*要対応<\/span>/s);
  assert.match(rowHtml(html, "a"), /title="Meetの記録を自動で取り込めませんでした/);
  for (const id of ["b", "c"]) assert.doesNotMatch(rowHtml(html, id), /要対応/, id);
});

test("T16 deals list page asks only for own-Meet rows it shows, and only when auto-record is on", () => {
  const page = readFileSync(new URL("../src/app/(app)/deals/page.tsx", import.meta.url), "utf8");
  assert.match(page, /isMeetAutoRecordEnabled\(\)\s*\?\s*await dealIdsNeedingMeetAttention\(visibleDeals\.filter\(\(d\) => isOwnMeet\(d\.meetingOwnerType\)\)\)/);
  assert.match(page, /deals=\{tableDeals\}/);
  // The list query itself is unchanged: no meetings are included per deal.
  assert.doesNotMatch(page.slice(page.indexOf("prisma.deal.findMany"), page.indexOf("prisma.dealProduct.groupBy")), /meetings/);
});
