import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";

// check-t14 と同じく tsx 経由で TS を require する（ESM の名前付き import は tsx の CJS 変換で拾えない）
const require = createRequire(import.meta.url);
const { LONG_LATIN_RUN, splitForLineBreak } = require("../src/lib/pdf/line-break.ts");
const { QuotePdf, QuotePdfV2 } = require("../src/lib/pdf/quote-pdf.tsx");
const { VideoContractPdf } = require("../src/lib/pdf/contract-video-pdf.tsx");
const { SnsContractPdf } = require("../src/lib/pdf/contract-sns-pdf.tsx");
const { NO_HYPHENATION_PENALTY, Text } = require("../src/lib/pdf/text.tsx");
const { PDF_FONT_FAMILY } = require("../src/lib/pdf/fonts.ts");
const { renderPdfBuffer } = require("../src/lib/pdf/render.ts");
const { Document, Page, View } = require("@react-pdf/renderer");

// T14 AC-09: 日本語はハイフン無しで文字単位に折り返し、列からはみ出さない。
// react-pdf（textkit）は「空でない音節どうしが直接並ぶ位置」をハイフン付きの改行位置にする。
// 空文字の音節を挟んだ位置は幅0の glue になり、そこで改行しても「-」は足されない。
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const segmentsOf = (parts) => parts.filter((part) => part !== "");
const noHyphenPoints = (parts) => parts.every((part, i) => i === parts.length - 1 || part === "" || parts[i + 1] === "");

test("T14 line break: Japanese splits per character with only hyphen-free break points", () => {
  const word = "一般社団法人日本映像コンテンツ制作振興協会";
  const parts = splitForLineBreak(word);
  assert.equal(parts.join(""), word);
  assert.deepEqual(segmentsOf(parts), Array.from(word));
  assert.ok(noHyphenPoints(parts), JSON.stringify(parts));
  assert.equal(parts[0], "", "a word starting with kanji may break before it (run boundary) without a hyphen");

  const kana = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん".repeat(2).slice(0, 80);
  const kanaParts = splitForLineBreak(kana);
  assert.equal(kanaParts.join(""), kana);
  assert.equal(segmentsOf(kanaParts).length, 80, "an 80-char kana run gets a break point between every character");
  assert.ok(noHyphenPoints(kanaParts));
});

test("T14 line break: kinsoku keeps closing marks, small kana and ー off the line start and opening brackets off the line end", () => {
  const cases = [
    ["お願いいたします。", ["お", "願", "い", "い", "た", "し", "ま", "す。"]],
    ["「見積」（税込）", ["「見", "積」", "（税", "込）"]],
    ["コーヒー、ちょっと", ["コー", "ヒー、", "ちょっ", "と"]],
    ["事務局　御中", ["事", "務", "局　", "御", "中"]],
    ["※恐れ入りますが", ["※", "恐", "れ", "入", "り", "ま", "す", "が"]],
    ["待機……完了", ["待", "機……", "完", "了"]],
  ];
  for (const [word, expected] of cases) {
    const parts = splitForLineBreak(word);
    assert.equal(parts.join(""), word);
    assert.deepEqual(segmentsOf(parts), expected, word);
    assert.ok(noHyphenPoints(parts), word);
  }
});

test("T14 line break: English words and short tokens stay whole; long unbroken tokens may wrap without a hyphen", () => {
  for (const word of ["English", "Full-width", "e\u2011mail", "L-20260930-0001", "¥1,234,567", "MP4/MOV", "internationalization"]) {
    assert.deepEqual(splitForLineBreak(word), [word], word);
  }
  assert.deepEqual(splitForLineBreak("Luma株式会社"), ["Luma", "", "株", "", "式", "", "会", "", "社"]);
  assert.deepEqual(splitForLineBreak("映像MP4/MOV納品"), ["", "映", "", "像", "", "MP4/MOV", "", "納", "", "品"]);
  const url = "https://example.com/quotes/L-20260930-0001/preview";
  assert.ok(url.length > LONG_LATIN_RUN);
  const urlParts = splitForLineBreak(url);
  assert.equal(urlParts.join(""), url);
  assert.ok(segmentsOf(urlParts).length > 10, "a long token can wrap instead of overflowing its column");
  assert.ok(noHyphenPoints(urlParts));
  // 空白だけの語は textkit が glue として扱うのでそのまま返す
  assert.deepEqual(splitForLineBreak(" "), [" "]);
  assert.deepEqual(splitForLineBreak("　"), ["　"]);
  // 異体字セレクタ（IVS）・結合文字は直前の文字から切り離さない
  assert.deepEqual(segmentsOf(splitForLineBreak("葛\u{E0100}城")), ["葛\u{E0100}", "城"]);
  assert.deepEqual(segmentsOf(splitForLineBreak("がき")), ["が", "き"]);
});

const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;
const KANA80 = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ";
const RECIPIENT = "一般社団法人日本映像コンテンツ制作振興協会映像文化推進本部事務局";
const NOTE_LINES = [
  "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。",
  "※消費税はご契約日時点での税率となります。",
  "※撮影交通費は撮影地をご相談の上、別途実費分をご負担いただきます。",
  `補足：${"撮影スケジュールは天候により前後する場合があります。".repeat(4)}`,
];

function words(pdf) {
  return parseWords(spawnSync("pdftotext", ["-bbox-layout", "-", "-"], { input: pdf }).stdout.toString());
}
function parseWords(html) {
  const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"");
  return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
    .map((m) => ({ xMin: Number(m[1]), yMin: Number(m[2]), xMax: Number(m[3]), yMax: Number(m[4]), text: decode(m[5]) }));
}

test("T14 QuotePdfV2 wraps a long recipient, an 80-char kana item and long notes inside their columns with no inserted hyphen", {
  skip: hasPdftotext ? false : "pdftotext (poppler) is not installed",
}, async () => {
  const pdf = await renderPdfBuffer(React.createElement(QuotePdfV2, { data: {
    quoteNumber: "L-20260930-0001", clientName: RECIPIENT, clientHonorific: "御中",
    subject: "採用ブランディング映像制作（一般社団法人日本映像コンテンツ制作振興協会様向け）",
    issueDate: "2026-09-30T00:00:00+09:00",
    issuer: { legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F" },
    note: NOTE_LINES.join("\n"),
    lines: [
      { name: "一般社団法人日本映像コンテンツ制作振興協会向け採用ブランディング映像制作費（本編3分・縦型ショート3本）", detail: "撮影2日・編集・BGM・ナレーション収録・字幕（日英）", qty: 1, unitPrice: 1_234_567, unit: "式", taxCategory: "taxable", taxRate: 10 },
      { name: KANA80, detail: null, qty: 2, unitPrice: 98_000, unit: "本", taxCategory: "taxable", taxRate: 10 },
      { name: "株式会社髙﨑㈱工業 ①〜⑳ ○◎△□", detail: null, qty: 3, unitPrice: 1_670, unit: "人", taxCategory: "non_taxable", taxRate: 0 },
    ],
  } }));
  const all = words(pdf);
  assert.ok(all.length > 20, "pdftotext found the rendered words");
  const hyphenated = all.filter((w) => /-$/.test(w.text) || new RegExp(`${CJK.source}-|-${CJK.source}`, "u").test(w.text));
  assert.deepEqual(hyphenated.map((w) => w.text), [], "no hyphen is inserted into Japanese text");

  // 列の位置は QuotePdfV2 のスタイル（A4 595pt、左右余白 38pt、品目列 42%、宛名 54%、備考は全幅）
  const left = 38, width = 595 - 38 * 2, eps = 0.5;
  const kanaWords = all.filter((w) => /^[\p{Script=Hiragana}]+$/u.test(w.text));
  assert.equal(kanaWords.map((w) => w.text).join(""), KANA80, "the 80-char kana item is complete");
  assert.ok(kanaWords.length >= 3, `the kana item wraps onto several lines (${kanaWords.length})`);
  for (const w of kanaWords) assert.ok(w.xMin >= left && w.xMax <= left + width * 0.42 + eps, `kana stays in the item column: ${JSON.stringify(w)}`);

  const recipientWords = all.filter((w) => w.yMax < 150 && w.xMin < left + width * 0.54 && CJK.test(w.text) && !/見|積|書/.test(w.text[0]));
  assert.equal(recipientWords.map((w) => w.text).join(""), `${RECIPIENT}御中`);
  for (const w of recipientWords) assert.ok(w.xMax <= left + width * 0.54 + eps, `recipient stays in its block: ${JSON.stringify(w)}`);

  const notesTop = all.find((w) => w.text === "備考")?.yMin;
  assert.ok(notesTop, "the notes box is rendered");
  const noteWords = all.filter((w) => w.yMin > notesTop && w.yMin < 800);
  const noteText = noteWords.map((w) => w.text).join("");
  for (const line of NOTE_LINES) assert.ok(noteText.includes(line), `note line is rendered with every glyph: ${line}`);
  for (const w of noteWords) assert.ok(w.xMax <= left + width - 8 + eps, `note stays inside the box: ${JSON.stringify(w)}`);
  assert.ok(all.some((w) => w.text.includes("株式会社髙﨑㈱工業")), "IBM/NEC extension kanji and ㈱ are rendered");
});

// ---- 文字種の境目の改行（レビュー B1） ----
// textkit はコールバックを呼ぶ前に、文字列を文字種ごとのラン（漢字｜かな｜英字）と JSX の文字列ごとに分ける。
// コールバックはランの境目（「編集データは｜Adobe」「立ち会｜って」）を見られないため、そこには「-」付きの
// 改行位置が残る。半角スペースを含む段落では Knuth–Plass がそこを選んでいた（「編集データは-／Adobe」）。
// text.tsx の Text は hyphenationPenalty を 10000（textkit の無限大）にして、その位置を改行候補から外す。
const MIXED_NOTES = [
  "※恐れ入りますが、振り込み手数料は貴社負担でお願いいたします。",
  "【納品について】納品形式は MP4（H.264・1920×1080）です。撮影素材一式はGoogleドライブで共有し、編集データはAdobe Premiere Proのプロジェクトファイルでお渡しします。",
  "※撮影に行って確認した上で、お持ちの素材を使ってYouTube・Instagram・TikTok向けの縦型ショートを3本書き出します。",
  "※LINE公式アカウントの告知用バナーとWeb制作は別契約です。After Effectsでのモーション修正は2回まで、3回目以降は1回あたり30,000円（税別）となります。",
  "※当日は Sony FX6 と DJI Ronin 4D を持って伺い、Zoom で立ち会っていただきながら撮影します。ロケ地は Google マップで共有します。",
  "※ナレーション収録（Zoom 立ち会い）のあと、BGMは Artlist のライセンス曲を使います。字幕は日本語と English の2種類で、SRT ファイルもお渡しします。",
];
const MIXED_ITEMS = [
  { name: "【音声】ナレーション収録（Zoom 立ち会い）BGM Artlist ライセンス", detail: "YouTube配信用 16:9 と Instagram リール用 9:16 の2種" },
  { name: "Adobe Premiere Pro編集・After Effects合成（本編3分・4K対応）", detail: null },
  { name: "撮影ディレクション一式（ロケハンに行って確認・Sony FX6 / DJI Ronin 4D持ち込み）", detail: null },
];
const MIXED_RECIPIENT = "株式会社Blue Ocean Media Japan マーケティング本部";
const MIXED_SUBJECT = "YouTube・TikTok向け採用ブランディング動画制作（LINE公式アカウント告知用ショートを含む）";
const MIXED_QUOTE = {
  quoteNumber: "L-20260930-0001", clientName: MIXED_RECIPIENT, clientHonorific: "御中", subject: MIXED_SUBJECT,
  issueDate: "2026-09-30T00:00:00+09:00",
  issuer: { legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F" },
  note: MIXED_NOTES.join("\n"),
  lines: MIXED_ITEMS.map((item, i) => ({ ...item, qty: i + 1, unitPrice: 150_000, unit: "式", taxCategory: "taxable", taxRate: 10 })),
};
const stripSpace = (text) => text.replace(/\s+/gu, "");

/** 関数コンポーネントを展開した react-pdf の要素（text.tsx の Text は展開せずに残す）。 */
function pdfElements(node, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) pdfElements(child, found);
    return found;
  }
  if (typeof node.type === "function" && node.type !== Text) return pdfElements(node.type(node.props), found);
  found.push(node);
  return pdfElements(node.props?.children, found);
}

test("T14 line break: the quote and contract PDFs draw every text with the Text of text.tsx, which never breaks at a hyphen point", () => {
  const drawn = Text({ style: { fontSize: 9 }, children: "編集データはAdobe Premiere Pro" });
  assert.equal(drawn.type, "TEXT", "it renders @react-pdf/renderer's Text");
  assert.equal(drawn.props.hyphenationPenalty, 10000, "10000 is textkit's infinity: Knuth–Plass never breaks there");
  assert.equal(NO_HYPHENATION_PENALTY, 10000);
  assert.deepEqual(drawn.props.style, { fontSize: 9 });
  assert.equal(drawn.props.children, "編集データはAdobe Premiere Pro");

  const documents = {
    QuotePdfV2: QuotePdfV2({ data: MIXED_QUOTE }),
    QuotePdf: QuotePdf({ data: { clientName: MIXED_RECIPIENT, clientHonorific: "御中", subject: MIXED_SUBJECT, issueDate: "2026-09-30", taxRate: 10, note: MIXED_NOTES.join("\n"), lines: [{ name: MIXED_ITEMS[0].name, qty: 1, unitPrice: 1000 }] } }),
    VideoContractPdf: VideoContractPdf({ data: { clientName: MIXED_RECIPIENT, deliverable: "PR映像（YouTube・Instagram リール用）", completionDate: "2026年10月31日", contractAmount: 550_000, signDate: "2026年9月30日" } }),
    SnsContractPdf: SnsContractPdf({ data: { clientName: MIXED_RECIPIENT, periodStart: "2026年10月1日", periodEnd: "2027年3月31日", totalFee: 1_300_000, initialFee: 100_000, monthlyFee: 200_000, months: 6, signDate: "2026年9月30日" } }),
  };
  for (const [name, document] of Object.entries(documents)) {
    const elements = pdfElements(document);
    assert.ok(elements.filter((element) => element.type === Text).length > 10, `${name} draws its texts with text.tsx`);
    assert.equal(elements.filter((element) => element.type === "TEXT").length, 0, `${name} uses @react-pdf/renderer's Text directly`);
  }
});

test("T14 QuotePdfV2 gives each Text a single string, including the texts with inserted values", () => {
  // textkit は文字列どうしの境目も「-」付きの改行位置にする。hyphenationPenalty と二重に防ぐため、差し込み値のある
  // Text も `{a}：{b}` のように分けず、1つの文字列で渡す。
  const texts = pdfElements(QuotePdfV2({ data: MIXED_QUOTE })).filter((element) => element.type === Text);
  const split = texts.filter((element) => element.props.render === undefined && typeof element.props.children !== "string");
  assert.deepEqual(split.map((element) => element.props.children), [], "a Text with several children");
  const strings = texts.map((element) => element.props.children);
  for (const expected of [
    `${MIXED_RECIPIENT}　御中`, `件名：${MIXED_SUBJECT}`, "〒170-0013", "見積番号：L-20260930-0001", "発行日：2026/09/30",
    "御見積金額　¥990,000（税込）", "10%対象 / 消費税", "¥900,000 / ¥90,000", MIXED_QUOTE.note, ...MIXED_ITEMS.map((item) => item.name),
  ]) assert.ok(strings.includes(expected), expected);

  // 旧テンプレート（QuotePdf）の宛名と消費税の行も1つの文字列
  const legacy = pdfElements(QuotePdf({ data: { clientName: MIXED_RECIPIENT, clientHonorific: "様", issueDate: "2026-09-30", taxRate: 10, lines: [] } }))
    .filter((element) => element.type === Text).map((element) => element.props.children);
  assert.ok(legacy.includes(`${MIXED_RECIPIENT}　様`));
  assert.ok(legacy.includes("消費税（10%）"));
});

/** pdftotext -bbox-layout の単語をページごとに返す。 */
function pageWords(pdf) {
  const html = spawnSync("pdftotext", ["-bbox-layout", "-", "-"], { input: pdf }).stdout.toString();
  return html.split("<page ").slice(1).map((page) => parseWords(page));
}
/** 行（y）→ 左から（x）の順に並べる。 */
const readingOrder = (list) => [...list].sort((a, b) => (Math.abs(a.yMin - b.yMin) < 2 ? a.xMin - b.xMin : a.yMin - b.yMin));

test("T14 mixed Japanese/English notes wrap without an inserted hyphen and stay inside the box at every width", {
  skip: hasPdftotext ? false : "pdftotext (poppler) is not installed",
}, async () => {
  // 列幅が変わると改行位置が変わる。120〜477pt を 3pt 刻みで描き、どの幅でも「-」が足されない
  // （描画された文字をつなぐと元の文と一致する）こと、枠からはみ出さないことを確かめる。
  const note = MIXED_NOTES.slice(1).join("\n");
  const left = 24;
  const widths = Array.from({ length: 120 }, (_, i) => 120 + i * 3);
  const pdf = await renderPdfBuffer(React.createElement(Document, null, widths.map((width) => React.createElement(
    Page, { key: width, size: "A4", style: { fontFamily: PDF_FONT_FAMILY, fontSize: 9, padding: left } },
    React.createElement(View, { style: { width } }, React.createElement(Text, null, note)),
  ))));
  const pages = pageWords(pdf);
  assert.equal(pages.length, widths.length);
  const hyphenated = [];
  const overflowing = [];
  const expected = stripSpace(note);
  pages.forEach((list, i) => {
    const drawn = stripSpace(readingOrder(list).map((w) => w.text).join(""));
    const at = Array.from(drawn).findIndex((ch, k) => ch !== Array.from(expected)[k]);
    if (drawn !== expected) hyphenated.push(`${widths[i]}pt: …${Array.from(drawn).slice(Math.max(0, at - 20), at + 10).join("")}…`);
    for (const w of list) if (w.xMax > left + widths[i] + 0.5) overflowing.push(`${widths[i]}pt: ${w.text}`);
  });
  assert.deepEqual(hyphenated, [], "the drawn text equals the note (no hyphen was inserted)");
  assert.deepEqual(overflowing, [], "every word stays inside the box");
});

test("T14 QuotePdfV2 with mixed Japanese/English notes, items, recipient and subject inserts no hyphen and keeps each text in its column", {
  skip: hasPdftotext ? false : "pdftotext (poppler) is not installed",
}, async () => {
  const pages = pageWords(await renderPdfBuffer(React.createElement(QuotePdfV2, { data: MIXED_QUOTE })));
  assert.equal(pages.length, 1, "the quote fits on one page");
  const all = pages[0];
  const left = 38, width = 595 - 38 * 2, eps = 0.5;
  const top = (text) => all.find((w) => w.text === text)?.yMin;
  const [titleBottom, totalTop, tableTop, summaryTop, notesTop] = [
    Math.max(...all.filter((w) => /^[見積書]$/.test(w.text)).map((w) => w.yMax)), top("御見積金額"), top("品目"), top("小計"), top("備考"),
  ];
  assert.ok([titleBottom, totalTop, tableTop, summaryTop, notesTop].every((y) => y > 0), "the layout landmarks are rendered");

  const region = (match) => readingOrder(all.filter(match));
  const recipient = region((w) => w.yMin > titleBottom && w.yMax < totalTop && w.xMin < left + width * 0.54);
  assert.equal(stripSpace(recipient.map((w) => w.text).join("")), stripSpace(`${MIXED_RECIPIENT}御中件名：${MIXED_SUBJECT}`));
  for (const w of recipient) assert.ok(w.xMax <= left + width * 0.54 + eps, `recipient and subject stay in their block: ${JSON.stringify(w)}`);

  const items = region((w) => w.yMin > tableTop + 5 && w.yMax < summaryTop && w.xMin < left + width * 0.42);
  assert.equal(stripSpace(items.map((w) => w.text).join("")), stripSpace(MIXED_ITEMS.map((item) => item.name + (item.detail ?? "")).join("")));
  for (const w of items) assert.ok(w.xMax <= left + width * 0.42 + eps, `items stay in the item column: ${JSON.stringify(w)}`);

  const notes = region((w) => w.yMin > notesTop && w.yMin < 800);
  assert.equal(stripSpace(notes.map((w) => w.text).join("")), stripSpace(MIXED_QUOTE.note), "the notes are drawn as written (no hyphen was inserted)");
  for (const w of notes) assert.ok(w.xMax <= left + width - 8 + eps, `notes stay inside the box: ${JSON.stringify(w)}`);
});
