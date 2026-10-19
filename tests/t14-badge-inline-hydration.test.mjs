import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// T14: /admin/quote-settings・quote-templates・products・trash を直接開くと React #418（hydration 不一致）が出ていた。
// どの画面も「管理者専用」の Badge を <p> の中に置いており、Badge が <div> を描いていた。
// HTML の規則では <p> の中に <div> が来るとブラウザが <p> をそこで閉じるため、
// ブラウザが組み立てた DOM がサーバーの HTML（= React の期待する木）と食い違う。
// Badge を行内要素 <span> で描けば <p> の中に置いても DOM は組み替わらない。
const require = createRequire(import.meta.url);
const { Badge } = require("../src/components/ui/badge.tsx");

// ブラウザが <p> を暗黙に閉じる要素（HTML Living Standard の "in body" 挿入モード）。
const CLOSES_P = /<(address|article|aside|blockquote|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|main|menu|nav|ol|p|pre|section|table|ul)\b/;

test("T14 Badge renders an inline <span> keeping the variant classes", () => {
  const html = renderToStaticMarkup(createElement(Badge, { variant: "danger", className: "extra" }, "管理者専用"));
  assert.match(html, /^<span class="[^"]*inline-flex[^"]*bg-red-100[^"]*extra[^"]*">管理者専用<\/span>$/);
});

test("T14 a Badge inside a <p> does not make the browser close the paragraph (no hydration mismatch)", () => {
  const html = renderToStaticMarkup(createElement("p", { className: "inline-flex" },
    createElement(Badge, { variant: "danger" }, "管理者専用"), "見積書PDFの右上に出る発行者を設定します。"));
  const inner = /^<p[^>]*>([\s\S]*)<\/p>$/.exec(html)?.[1];
  assert.ok(inner, html);
  assert.doesNotMatch(inner, CLOSES_P, html);
});

test("T14 the admin pages that failed still place the admin badge inside a paragraph, which is now safe", () => {
  // 画面側の <p> 構造を前提にした修正なので、前提が変わったらこのテストで気付けるようにしておく。
  for (const page of ["quote-settings", "quote-templates", "products", "trash"]) {
    const source = readFileSync(new URL(`../src/app/(app)/admin/${page}/page.tsx`, import.meta.url), "utf8");
    assert.match(source, /<p\b[^>]*>\s*<Badge variant="danger">管理者専用<\/Badge>/, page);
  }
});
