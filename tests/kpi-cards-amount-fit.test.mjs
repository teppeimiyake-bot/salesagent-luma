import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// UI確認 2026-10-01：xl 以上の6列並びで「提案金額合計 ¥44,830,000」の末尾がカードからはみ出した。
// 6列に固定すると 1280〜1535px でカードが 95〜113px になり、金額が3〜4行に折れた。列数はカード幅（12rem 以上）から決め、
// スマホ幅（2列）だけ金額を一段小さくする。収まらない幅では切らずに折り返す。アイコンは縮めない。
test("KPI card amounts shrink on the six-column layout and never overflow the card", () => {
  const src = readFileSync(new URL("../src/components/dashboard/kpi-cards.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /xl:grid-cols-6/);
  assert.match(src, /grid-cols-2 sm:grid-cols-\[repeat\(auto-fit,minmax\(12rem,1fr\)\)\]/);
  assert.match(src, /<div className="min-w-0">/);
  assert.match(src, /text-base sm:text-xl[^"]*\[overflow-wrap:anywhere\]/);
  assert.match(src, /shrink-0 rounded-md p-1\.5/);
});
