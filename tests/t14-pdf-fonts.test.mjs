import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";

// T14 AC-07/AC-09: 同梱フォントの文字表（cmap）に、見積書で使う文字がすべてあること。
// 以前の NotoSansJP サブセット（6,886字）には ※ ～ ○ ◎ △ □ ㈱ 髙 﨑 ① などが無く、PDFから黙って消えていた。
// react-pdf が使う fontkit で開き、同じ判定（hasGlyphForCodePoint）で確かめる。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = path.join(ROOT, "src/lib/pdf/fonts");
const require = createRequire(import.meta.url);
const { DEFAULT_QUOTE_NOTES, DEFAULT_TRAVEL_NOTE } = require("../src/lib/quote-issuer.ts");

const fonts = ["NotoSansJP-Regular.ttf", "NotoSansJP-Bold.ttf"].map((file) => ({ file, font: fontkit.openSync(path.join(FONT_DIR, file)) }));

// サンプル見積書（00_Docs/999_サンプル/見積書/*.pdf）の備考の原文
const SAMPLE_NOTES = [
  "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。",
  "※消費税はご契約日時点での税率となります。",
  "※撮影交通費は撮影地をご相談の上、別途実費分をご負担いただきます。",
  "※撮影交通費は別途ご相談の上貴社にご負担いただきます",
].join("");
const KIGOU = "※～〜○◎●△▲▽▼□■◇◆★☆①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳ⅠⅡⅢⅰⅱⅲ㈱㈲㈹℡〒〓№≒≡∵∴←→↑↓♪†‡§×÷±°′″℃￥＄¢£％＃＆＊＠・：；？！「」『』（）【】〔〕";
const NAMES = "株式会社髙﨑㈱工業 德島 塚本 吉野家 𠮷 淸水 神﨑";
const PDF_LABELS = "見積書御中様件名見積番号発行日御見積金額税込品目単価数量単位価格小計対象消費税不課税合計備考〒";

function jisX0208() {
  // WHATWG の EUC-JP は JIS X 0208 の94区（NEC特殊文字の13区・NEC選定IBM拡張の89〜92区を含む）を復号する
  const decoder = new TextDecoder("euc-jp");
  const chars = [];
  for (let a = 0xa1; a <= 0xfe; a++) {
    for (let b = 0xa1; b <= 0xfe; b++) {
      const ch = decoder.decode(Uint8Array.of(a, b));
      if (ch !== "\uFFFD" && [...ch].length === 1) chars.push(ch);
    }
  }
  return chars;
}

function ibmExtension() {
  // Shift_JIS（CP932）の IBM 拡張文字 FA40〜FC4B（髙 﨑 など）
  const decoder = new TextDecoder("shift_jis");
  const chars = [];
  for (let a = 0xfa; a <= 0xfc; a++) {
    for (let b = 0x40; b <= 0xfc; b++) {
      if (b === 0x7f) continue;
      const ch = decoder.decode(Uint8Array.of(a, b));
      if (ch !== "\uFFFD" && [...ch].length === 1) chars.push(ch);
    }
  }
  return chars;
}

const fullWidthAscii = Array.from({ length: 0xff5e - 0xff01 + 1 }, (_, i) => String.fromCodePoint(0xff01 + i));

function missing(font, text) {
  return [...new Set([...text])].filter((ch) => ch.trim() !== "" && !font.hasGlyphForCodePoint(ch.codePointAt(0)));
}

test("T14 bundled fonts are static TrueType (glyf) Noto Sans JP within the size budget, with the OFL next to them", () => {
  for (const { file, font } of fonts) {
    assert.equal(font.type, "TTF", file);
    assert.ok(font.directory.tables.glyf, `${file} has glyf outlines`);
    assert.ok(!font.directory.tables.fvar, `${file} is a static instance`);
    assert.equal(font.familyName, "Noto Sans JP", file);
    const size = statSync(path.join(FONT_DIR, file)).size;
    assert.ok(size < 6_000_000, `${file} is ${size} bytes`);
  }
  assert.deepEqual(fonts.map(({ font }) => font.subfamilyName), ["Regular", "Bold"]);
  const ofl = path.join(FONT_DIR, "OFL.txt");
  assert.ok(existsSync(ofl), "OFL.txt is shipped with the fonts");
  assert.match(readFileSync(ofl, "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("T14 fonts cover the sample notes, kigou, names with IBM/NEC kanji and the PDF labels", () => {
  const required = SAMPLE_NOTES + DEFAULT_QUOTE_NOTES + DEFAULT_TRAVEL_NOTE + KIGOU + NAMES + PDF_LABELS;
  for (const { file, font } of fonts) assert.deepEqual(missing(font, required), [], file);
});

test("T14 fonts cover all of JIS X 0208 (with NEC row 13 / NEC-selected IBM), the IBM extension and full-width ASCII", () => {
  const jis = jisX0208();
  const ibm = ibmExtension();
  assert.ok(jis.length > 7_000, `decoded ${jis.length} JIS X 0208 characters`);
  assert.ok(ibm.length > 350, `decoded ${ibm.length} IBM extension characters`);
  for (const { file, font } of fonts) {
    assert.deepEqual(missing(font, jis.join("")), [], `${file} JIS X 0208`);
    assert.deepEqual(missing(font, ibm.join("")), [], `${file} IBM extension`);
    assert.deepEqual(missing(font, fullWidthAscii.join("")), [], `${file} full-width ASCII`);
  }
});
