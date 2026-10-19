import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// T14 AC-07 / D-05: 標準備考2行（サンプル原文）を既定ON、交通費備考は2種類から選ぶ。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { DEFAULT_QUOTE_NOTES, DEFAULT_TRAVEL_NOTE } = require("../src/lib/quote-issuer.ts");
const notes = require("../src/lib/quote-notes.ts");

const STANDARD = [
  "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。",
  "※消費税はご契約日時点での税率となります。",
];
const TRAVEL = [
  "※撮影交通費は撮影地をご相談の上、別途実費分をご負担いただきます。",
  "※撮影交通費は別途ご相談の上貴社にご負担いただきます",
];

test("T14 issuer defaults are the sample wording: two standard lines and two travel variants", () => {
  assert.equal(DEFAULT_QUOTE_NOTES, STANDARD.join("\n"));
  assert.equal(DEFAULT_TRAVEL_NOTE, TRAVEL.join("\n"));
  assert.deepEqual(notes.quoteNotePresets(null), { standard: STANDARD, travel: TRAVEL });
  assert.deepEqual(
    notes.quoteNotePresets({ defaultNotes: " 行A \r\n\n行B", travelExpenseNote: null }),
    { standard: ["行A", "行B"], travel: [] },
    "settings are read one item per line; blank lines are ignored",
  );
});

test("T14 a new quote starts with the standard notes ON and no travel note; travel is one of the variants", () => {
  const presets = notes.quoteNotePresets(null);
  const initial = notes.initialNoteSelection();
  assert.deepEqual(initial, { standard: true, travelIndex: null, extra: "" });
  assert.equal(notes.composeQuoteNote(presets, initial), STANDARD.join("\n"));
  assert.equal(notes.composeQuoteNote(presets, { ...initial, travelIndex: 0 }), [...STANDARD, TRAVEL[0]].join("\n"));
  assert.equal(notes.composeQuoteNote(presets, { ...initial, travelIndex: 1, extra: "  別途協議\n2行目 " }), [...STANDARD, TRAVEL[1], "別途協議\n2行目"].join("\n"));
  assert.equal(notes.composeQuoteNote(presets, { standard: false, travelIndex: null, extra: "" }), "");
  assert.equal(notes.composeQuoteNote(presets, { standard: false, travelIndex: 5, extra: "" }), "", "an out-of-range travel choice adds nothing");
});

test("T14 saved notes split back into the same selection, and unknown wording is kept as free text", () => {
  const presets = notes.quoteNotePresets(null);
  const selections = [
    { standard: true, travelIndex: null, extra: "" },
    { standard: true, travelIndex: 1, extra: "" },
    { standard: false, travelIndex: 0, extra: "" },
    { standard: true, travelIndex: 0, extra: "撮影は2日間を想定\n納品はMP4" },
    { standard: false, travelIndex: null, extra: "手入力の備考のみ" },
  ];
  for (const selection of selections) {
    const text = notes.composeQuoteNote(presets, selection);
    assert.deepEqual(notes.splitQuoteNote(text, presets), selection, text);
  }
  const legacy = "本見積書の有効期限は発行日より30日間です。\n業務内容の変更がある場合は別途お見積りいたします。";
  assert.deepEqual(notes.splitQuoteNote(legacy, presets), { standard: false, travelIndex: null, extra: legacy });
  assert.deepEqual(notes.splitQuoteNote(null, presets), { standard: false, travelIndex: null, extra: "" });
  assert.deepEqual(notes.splitQuoteNote("何か", { standard: [], travel: [] }), { standard: false, travelIndex: null, extra: "何か" });
});

const SAMPLE_DIR = path.join(ROOT, "00_Docs/999_サンプル/見積書");
const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;
const samples = existsSync(SAMPLE_DIR) ? readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".pdf")) : [];

test("T14 the defaults match the notes printed in the sample quotes (00_Docs/999_サンプル/見積書)", {
  skip: !hasPdftotext ? "pdftotext (poppler) is not installed" : samples.length === 0 ? "sample PDFs are not in this checkout" : false,
}, () => {
  assert.equal(samples.length, 9);
  const travelSeen = new Set();
  for (const file of samples) {
    const text = spawnSync("pdftotext", ["-raw", path.join(SAMPLE_DIR, file), "-"]).stdout.toString();
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("※"));
    assert.deepEqual(lines.slice(0, 2), STANDARD, `${file}: the standard two lines`);
    for (const line of lines.slice(2)) {
      assert.ok(TRAVEL.includes(line), `${file}: travel wording ${line}`);
      travelSeen.add(line);
    }
  }
  assert.deepEqual([...travelSeen].sort(), [...TRAVEL].sort(), "both travel variants come from the samples");
});
