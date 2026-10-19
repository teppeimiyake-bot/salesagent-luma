import assert from "node:assert/strict";
import { createRequire } from "node:module";
import React from "react";
import type { CalculableQuoteLine } from "../src/lib/quote-calculation";

const require = createRequire(import.meta.url);
const { calculateQuote, normalizeHonorific, validateQuoteLines } = require("../src/lib/quote-calculation.ts") as typeof import("../src/lib/quote-calculation");
const { quoteNumber } = require("../src/lib/quote-issuer.ts") as typeof import("../src/lib/quote-issuer");
const { QuotePdfV2 } = require("../src/lib/pdf/quote-pdf.tsx") as typeof import("../src/lib/pdf/quote-pdf");
const { renderPdfBuffer } = require("../src/lib/pdf/render.ts") as typeof import("../src/lib/pdf/render");

const taxable = (name: string, unitPrice: number, qty = 1, unit = "式"): CalculableQuoteLine => ({
  name, qty, unitPrice, unit, taxCategory: "taxable", taxRate: 10,
});

const samples: Array<{ id: string; lines: CalculableQuoteLine[]; subtotal: number; tax: number; total: number; taxableBase?: number; nonTaxableBase?: number }> = [
  { id: "S01", subtotal: 600_000, tax: 60_000, total: 660_000, lines: [
    taxable("A案映像制作費", 550_000, 1, "本"),
    taxable("映像素材費", 50_000),
  ]},
  { id: "S02", subtotal: 600_000, tax: 60_000, total: 660_000, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    taxable("映像制作費", 450_000, 1, "本"),
    taxable("映像素材費", 50_000),
  ]},
  { id: "S03", subtotal: 680_000, tax: 68_000, total: 748_000, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    taxable("映像制作費", 450_000, 1, "本"),
    taxable("映像素材費", 50_000),
    taxable("キャスティング費用", 50_000, 1, "人"),
    taxable("機材費", 30_000),
  ]},
  { id: "S04", subtotal: 552_640, tax: 55_264, total: 607_904, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    taxable("映像制作費", 450_000, 1, "本"),
    taxable("撮影交通費", 880, 3, "人"),
  ]},
  { id: "S05", subtotal: 607_840, tax: 60_784, total: 668_624, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    taxable("映像制作費", 450_000, 1, "本"),
    taxable("撮影交通費", 28_920, 2, "人"),
  ]},
  { id: "S06", subtotal: 585_010, tax: 58_000, total: 643_010, taxableBase: 580_000, nonTaxableBase: 5_010, lines: [
    taxable("映像制作", 580_000),
    { name: "撮影交通費", qty: 1, unitPrice: 5_010, unit: "式", taxCategory: "non_taxable", taxRate: 0 },
  ]},
  { id: "S06-sample", subtotal: 585_010, tax: 58_000, total: 643_010, taxableBase: 580_000, nonTaxableBase: 5_010, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    taxable("映像制作費", 450_000, 1, "本"),
    taxable("映像素材費", 30_000),
    { name: "撮影交通費", qty: 3, unitPrice: 1_670, unit: "人", taxCategory: "non_taxable", taxRate: 0 },
  ]},
  { id: "S07", subtotal: 1_780_000, tax: 178_000, total: 1_958_000, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    { ...taxable("プレミアム", 280_000, 6, "月"), detail: "月6本×6か月＝36本" },
  ]},
  { id: "S08", subtotal: 1_300_000, tax: 130_000, total: 1_430_000, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    { ...taxable("スタンダード", 200_000, 6, "ヵ月"), detail: "月4本×6か月＝24本" },
  ]},
  { id: "S09", subtotal: 940_000, tax: 94_000, total: 1_034_000, lines: [
    taxable("初期費用", 100_000, 1, "回"),
    { ...taxable("ライト", 140_000, 6, "ヵ月"), detail: "月2本×6か月＝12本" },
  ]},
];

for (const sample of samples) {
  assert.equal(validateQuoteLines(sample.lines), null, sample.id);
  const totals = calculateQuote(sample.lines);
  assert.equal(totals.subtotal, sample.subtotal, `${sample.id} subtotal`);
  assert.equal(totals.taxTotal, sample.tax, `${sample.id} tax`);
  assert.equal(totals.grandTotal, sample.total, `${sample.id} total`);
  if (sample.taxableBase != null) assert.equal(totals.taxableBase, sample.taxableBase, `${sample.id} taxable`);
  if (sample.nonTaxableBase != null) assert.equal(totals.nonTaxableBase, sample.nonTaxableBase, `${sample.id} non-taxable`);
}

const s06 = samples.find((sample) => sample.id === "S06")!.lines;
assert.deepEqual(normalizeHonorific("株式会社サンプル 御中", "御中"), { clientName: "株式会社サンプル", honorific: "御中" });
assert.deepEqual(normalizeHonorific("山田 太郎 様", "様"), { clientName: "山田 太郎", honorific: "様" });
assert.equal(quoteNumber("L", "2026-08-17T00:00:00+09:00", 12), "L-20260817-0012");

const pdf = await renderPdfBuffer(React.createElement(QuotePdfV2, { data: {
  quoteNumber: "L-20260817-0012", clientName: "株式会社サンプル 御中", clientHonorific: "御中",
  subject: "S06検算", issueDate: "2026-08-17T00:00:00+09:00", issuer: {
    legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F",
  }, note: "標準備考1\n標準備考2", lines: s06,
} }));
assert.ok(pdf.length > 10_000, `PDF buffer is unexpectedly small: ${pdf.length}`);

console.log(`T14 checks passed: S01-S09 totals, honorific normalization, JST quote numbering, PDF render (${pdf.length} bytes)`);

// Local verification artifact; never uploads a document.
if (process.env.T14_TEST_OUTPUT) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(process.env.T14_TEST_OUTPUT, pdf);
}

const { execFileSync } = await import("node:child_process");
const renderedText=execFileSync("pdftotext", ["-layout", "-", "-"], {input:pdf}).toString();
assert.match(renderedText,/1\s*\/\s*1/,"page footer must render");
assert.match(renderedText,/643,010/);
