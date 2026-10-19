import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import React from "react";

// T14: 見積書 PDF が複数ページになっても明細表の罫線が崩れない。
// 以前は罫線（上・左）を表の外枠の View に持たせていたため、外枠がページで分割されると
// 1ページ目は左罫線だけが下余白まで伸び、2ページ目の繰り返し見出し行には上罫線が無かった。
// 30行の見積を実際に描画し、72dpi（1px = 1pt）の画像で表の左端の罫線を調べる。
const require = createRequire(import.meta.url);
const { QuotePdfV2 } = require("../src/lib/pdf/quote-pdf.tsx");
const { renderPdfBuffer } = require("../src/lib/pdf/render.ts");

const LEFT = 38; // v2.page の左右余白（pt）
const lines = Array.from({ length: 30 }, (_, i) => ({
  name: `カット編集（第${i + 1}話・架空）`, detail: i % 3 === 0 ? "撮影2日・編集込み（架空の補足）" : null,
  qty: (i % 4) + 1, unitPrice: 12_345 * (i + 1), unit: i % 5 === 0 ? "時間" : "式",
  taxCategory: "taxable", taxRate: 10,
}));

function readPgm(file) {
  const buf = readFileSync(file);
  const header = buf.subarray(0, 64).toString("latin1").split(/\s+/);
  assert.equal(header[0], "P5");
  const width = Number(header[1]);
  const height = Number(header[2]);
  const offset = buf.length - width * height;
  return { width, height, dark: (x, y) => buf[offset + y * width + x] < 230 } // 罫線の端は薄く描かれるので閾値は甘めにする;
}

test("T14 a multi-page quote PDF keeps the table rules closed at each page break", async () => {
  const pdf = await renderPdfBuffer(React.createElement(QuotePdfV2, { data: {
    quoteNumber: "L-20260930-0030", clientName: "架空検証株式会社", clientHonorific: "御中", subject: "罫線確認（架空）",
    issueDate: "2026-09-30T00:00:00+09:00", note: "備考（架空）",
    issuer: { legalName: "株式会社Luma", postalCode: "170-0013", addressLine1: "東京都豊島区東池袋", addressLine2: "2-7-3 柄澤ビル3F" },
    lines,
  } }));
  const dir = mkdtempSync(path.join(tmpdir(), "t14-quote-break-"));
  try {
    writeFileSync(path.join(dir, "quote.pdf"), pdf);
    execFileSync("pdftoppm", ["-r", "72", "-gray", path.join(dir, "quote.pdf"), path.join(dir, "page")]);
    const pages = readdirSync(dir).filter((f) => f.endsWith(".pgm")).sort().map((f) => readPgm(path.join(dir, f)));
    assert.ok(pages.length >= 2, `30 lines should span pages (got ${pages.length})`);

    // 左罫線（x≈38pt）が濃い y の範囲と、品目列の右寄り（文字の無い x=208pt・238pt）で横罫線が引かれている y を調べる
    // 左端の文字（宛名など）に引っかからないよう、x≈38pt で最も長く続く縦の線を表の左罫線とみなす
    const leftRule = (page) => {
      let best = [];
      let run = [];
      for (let y = 0; y < page.height; y++) {
        if ([LEFT - 1, LEFT, LEFT + 1].some((x) => page.dark(x, y))) run.push(y);
        else run = [];
        if (run.length > best.length) best = [...run];
      }
      return best.length >= 40 ? best : [];
    };
    const horizontalAt = (page, y) => [y - 1, y, y + 1].some((yy) => yy >= 0 && yy < page.height && page.dark(LEFT + 170, yy) && page.dark(LEFT + 200, yy));

    for (const [index, page] of pages.slice(0, -1).entries()) {
      const ys = leftRule(page);
      assert.ok(ys.length > 0, `page ${index + 1} has a table`);
      const top = ys[0];
      const bottom = ys[ys.length - 1];
      assert.ok(horizontalAt(page, top), `page ${index + 1}: the table starts with a top rule at y=${top}`);
      assert.ok(horizontalAt(page, bottom), `page ${index + 1}: the left rule ends on the last row's bottom rule (y=${bottom}), not in the margin`);
      assert.ok(bottom < page.height - 42, `page ${index + 1}: the left rule stays above the bottom margin (y=${bottom})`);
    }
    for (const [index, page] of pages.slice(1).entries()) {
      const ys = leftRule(page);
      if (!ys.length) continue; // 表の後の合計・備考だけのページ
      assert.ok(horizontalAt(page, ys[0]), `page ${index + 2}: the repeated header row has a top rule (y=${ys[0]})`);
      assert.ok(horizontalAt(page, ys[ys.length - 1]), `page ${index + 2}: the table ends with a bottom rule`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
