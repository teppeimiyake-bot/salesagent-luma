import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// T14/T24（RQ-07）：/agent は共通の Header ではなく独自ヘッダー（agent-workspace.tsx）を持つ。
// md 未満はサイドバーが左上の固定ボタン（fixed left-3 top-4）に畳まれるため、
// 以前は 390px でボタンがアイコン・タブに重なり、タイトルは幅0、タブは縦1文字ずつ、
// 「営業台帳を開く」は画面外に切れていた。
// 狭い幅では左余白を空け、タブを2行目の横スクロールに回す。xl 以上（1440px など）は従来どおり1行。
const source = readFileSync(new URL("../src/components/agent/agent-workspace.tsx", import.meta.url), "utf8");
const header = /<header\b[\s\S]*?<\/header>/.exec(source)?.[0] ?? "";
const classesOf = (re) => (re.exec(header)?.[1] ?? "").split(/\s+/).filter(Boolean);
const has = (list, cls, name) => assert.ok(list.includes(cls), `${name}: ${cls} in ${list.join(" ")}`);
const lacks = (list, cls, name) => assert.ok(!list.includes(cls), `${name}: ${cls} must not be there`);

test("RQ-07 the agent header row leaves room for the fixed nav trigger below md and wraps until xl", () => {
  assert.ok(header, "the agent header exists");
  const row = classesOf(/<header[^>]*>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<div className="([^"]+)"/);
  for (const cls of ["flex", "flex-wrap", "pl-14", "pr-3", "md:px-6", "xl:flex-nowrap", "justify-between"]) has(row, cls, "header row");
  lacks(row, "px-6", "header row (the unprefixed padding would hide under the trigger)");
  const title = classesOf(/<div className="([^"]+)">\s*<div className="flex h-9 w-9/);
  for (const cls of ["min-w-0", "flex-1", "xl:flex-none"]) has(title, cls, "title block");
});

test("RQ-07 the tabs move to their own scrollable row on narrow widths and never break per character", () => {
  const tabs = classesOf(/data-testid="agent-tabs" className="([^"]+)"/);
  for (const cls of ["order-last", "w-full", "overflow-x-auto", "xl:order-none", "xl:w-auto", "xl:overflow-visible"]) has(tabs, cls, "tabs");
  const button = /"(flex [^"]*rounded-lg px-3\.5 py-1\.5[^"]*)"/.exec(header)?.[1].split(/\s+/) ?? [];
  for (const cls of ["shrink-0", "whitespace-nowrap"]) has(button, cls, "tab button");
  for (const label of ["ワークスペース", "実行履歴", "概要", "候補リスト", "使い方"]) assert.ok(source.includes(`label: "${label}"`), label);
});

test("RQ-07 the ledger link and the status line stay on one line instead of being cut or stacked", () => {
  const link = classesOf(/href=\{LEDGER_SHEET_URL\}[\s\S]*?className="([^"]+)"/);
  for (const cls of ["shrink-0", "whitespace-nowrap"]) has(link, cls, "ledger link");
  const status = classesOf(/<div className="([^"]*text-\[11px\] text-zinc-500[^"]*)">/);
  for (const cls of ["overflow-hidden", "whitespace-nowrap"]) has(status, cls, "status line");
});
