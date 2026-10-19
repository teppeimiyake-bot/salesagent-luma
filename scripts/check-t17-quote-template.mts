import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { QuoteChainNode } from "../src/lib/quote-version";
import type { TemplateLineLike } from "../src/lib/quote-template";

const require = createRequire(import.meta.url);
const { nextQuoteVersion, quoteRevisionLabel, buildQuoteChains } = require("../src/lib/quote-version.ts") as typeof import("../src/lib/quote-version");
const { templateLinesToQuoteLines, hasUserEnteredLines } = require("../src/lib/quote-template.ts") as typeof import("../src/lib/quote-template");
const { calculateQuote, validateQuoteLines } = require("../src/lib/quote-calculation.ts") as typeof import("../src/lib/quote-calculation");

// ------------------------------------------------------------
// 1) 版番号の採番
// ------------------------------------------------------------
assert.equal(nextQuoteVersion(null), "v2");
assert.equal(nextQuoteVersion(undefined), "v2");
assert.equal(nextQuoteVersion(""), "v2");
assert.equal(nextQuoteVersion("   "), "v2");
assert.equal(nextQuoteVersion("v1"), "v2");
assert.equal(nextQuoteVersion("v9"), "v10");
assert.equal(nextQuoteVersion("V2"), "v3");
assert.equal(nextQuoteVersion("v1.2"), "v1.3");
assert.equal(nextQuoteVersion("v1.9"), "v1.10");
assert.equal(nextQuoteVersion("改訂A"), "改訂A-改訂");
// 全域関数：どんな入力でも投げない
for (const weird of ["v", "vv1", "1", "v-1", "v01", "値引き案"]) {
  assert.equal(typeof nextQuoteVersion(weird), "string", weird);
}
assert.equal(nextQuoteVersion("v01"), "v2"); // ゼロ埋めは数値として解釈する

// ------------------------------------------------------------
// 2) 版ラベル
// ------------------------------------------------------------
assert.equal(quoteRevisionLabel("v2", "L-20260817-0012"), "v2（L-20260817-0012 の改訂）");
assert.equal(quoteRevisionLabel("v2", null), "v2");
assert.equal(quoteRevisionLabel(null, "L-20260817-0012"), "L-20260817-0012 の改訂");
assert.equal(quoteRevisionLabel(null, null), "");
assert.equal(quoteRevisionLabel("", ""), "");

// ------------------------------------------------------------
// 3) 改訂チェーンの構築
// ------------------------------------------------------------
const node = (
  id: string,
  supersedesQuoteId: string | null,
  version: string | null = null,
): QuoteChainNode => ({ id, version, quoteNumber: null, status: "draft", supersedesQuoteId });

// 一覧は createdAt desc なので新しい順で渡す（c → b → a）
const chain3 = buildQuoteChains([node("c", "b", "v3"), node("b", "a", "v2"), node("a", null, "v1")]);
assert.equal(chain3.length, 1);
assert.equal(chain3[0].rootId, "a");
assert.deepEqual(chain3[0].nodes.map((n) => n.id), ["a", "b", "c"]);

// 独立した2件は2チェーン
const twoChains = buildQuoteChains([node("x", null), node("y", null)]);
assert.equal(twoChains.length, 2);
assert.deepEqual(twoChains.map((c) => c.rootId), ["x", "y"]);
assert.deepEqual(twoChains.map((c) => c.nodes.length), [1, 1]);

// 親が一覧に居ない孤児は自分がルート
const orphan = buildQuoteChains([node("o", "missing-parent"), node("z", null)]);
assert.equal(orphan.length, 2);
assert.deepEqual(orphan.map((c) => c.rootId), ["o", "z"]);

// 循環（不正データ）でも停止する
const cyclic = buildQuoteChains([node("p", "q"), node("q", "p")]);
assert.ok(cyclic.length >= 1, "循環でもチェーンが返ること");
assert.equal(cyclic.reduce((sum, c) => sum + c.nodes.length, 0), 2, "循環でも件数は失われない");

// 空配列
assert.deepEqual(buildQuoteChains([]), []);

// ------------------------------------------------------------
// 4) テンプレート明細 → 見積明細の変換
// ------------------------------------------------------------
const templateLines: TemplateLineLike[] = [
  { id: "tl1", templateId: "t1", tenantId: "tn1", sortOrder: 0, name: "初期費用", detail: "初回のみ", qty: 1, unit: "回", unitPrice: 100_000, taxCategory: "taxable", taxRate: 10 },
  { id: "tl2", templateId: "t1", tenantId: "tn1", sortOrder: 1, name: "映像制作費", detail: null, qty: 1, unit: "本", unitPrice: 450_000, taxCategory: "taxable", taxRate: 10 },
  { id: "tl3", templateId: "t1", tenantId: "tn1", sortOrder: 2, name: "撮影交通費", detail: null, qty: 3, unit: "人", unitPrice: 1_670, taxCategory: "non_taxable", taxRate: 10 },
];

const converted = templateLinesToQuoteLines(templateLines);
// テンプレート固有のフィールドは落ちている
for (const line of converted) {
  for (const dropped of ["id", "templateId", "tenantId", "sortOrder"]) {
    assert.ok(!(dropped in line), `${dropped} は見積明細に持ち込まない`);
  }
}
// 業務データは保持され、順序も保たれる
assert.deepEqual(converted.map((l) => l.name), ["初期費用", "映像制作費", "撮影交通費"]);
assert.deepEqual(converted[0], { name: "初期費用", detail: "初回のみ", qty: 1, unit: "回", unitPrice: 100_000, taxCategory: "taxable", taxRate: 10 });
assert.equal(converted[1].detail, null);
// 不課税行は税率0に寄せる（calculateQuote と同じ扱い）
assert.equal(converted[2].taxCategory, "non_taxable");
assert.equal(converted[2].taxRate, 0);

// 変換結果はそのまま見積として成立する（T14 の S06-sample と同じ数字）
assert.equal(validateQuoteLines(converted), null);
const totals = calculateQuote(converted);
assert.equal(totals.subtotal, 555_010);
assert.equal(totals.taxableBase, 550_000);
assert.equal(totals.nonTaxableBase, 5_010);
assert.equal(totals.taxTotal, 55_000);
assert.equal(totals.grandTotal, 610_010);

// 欠損値のフォールバック（手動SQL投入のテンプレートを想定）
const sloppy = templateLinesToQuoteLines([{ name: "一式" }]);
assert.deepEqual(sloppy[0], { name: "一式", detail: null, qty: 1, unit: "式", unitPrice: 0, taxCategory: "taxable", taxRate: 10 });

// ------------------------------------------------------------
// 5) テンプレート適用前の確認判定
// ------------------------------------------------------------
assert.equal(hasUserEnteredLines([{ name: "", unitPrice: 0 }]), false);
assert.equal(hasUserEnteredLines([{ name: "  ", unitPrice: 0 }]), false);
assert.equal(hasUserEnteredLines([{ name: "映像制作費", unitPrice: 0 }]), true);
assert.equal(hasUserEnteredLines([{ name: "", unitPrice: 1 }]), true);

console.log(
  `T17 checks passed: nextQuoteVersion (${converted.length} template lines converted), quoteRevisionLabel, buildQuoteChains (3-chain / 2-chain / orphan / cycle-safe), template→quote line conversion totals ¥${totals.grandTotal.toLocaleString("ja-JP")}`,
);
