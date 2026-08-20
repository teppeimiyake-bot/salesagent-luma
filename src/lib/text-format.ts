/**
 * AI生成テキスト・取込テキストの「読みやすい日本語」への整形。
 *
 * 社長判断 2026-08：
 *   議事録やAI出力が Markdown 記法（# 見出し / - 箇条書き / **強調**）のまま画面に出ていて
 *   視認性が悪い。日本語のビジネス文書として自然な体裁
 *   （見出し＝■◆○、箇条書き＝「・」、順序付き＝「①②③」）に整えて表示する。
 *
 * 方針：
 *   - 保存データは書き換えない（Notion取込・過去のAI出力・手入力をそのまま保持）。
 *     表示の直前にこの関数を通す＝非破壊。編集モードでは元テキストを出す。
 *   - これから生成されるテキストは、プロンプト側（@/lib/ai/text-style）でも
 *     同じ体裁を指示する。二重に整形しても結果は変わらない（冪等）。
 */

/** 順序付き箇条書きの丸数字（①〜⑳）。21以上は「(21)」形式にフォールバック。 */
const CIRCLED_NUMBERS = [
  "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
  "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
];

/** 見出しレベル → 行頭記号（H1が最も強い） */
const HEADING_MARKS = ["■", "◆", "○", "○", "○", "○"];

/** 箇条書きの階層 → 行頭記号（・→－→＊） */
const BULLET_MARKS = ["・", "－", "＊"];

const HORIZONTAL_RULE = "────────────────";

/** 数値 → ①②③…（範囲外は "(n)"） */
function circled(n: number): string {
  return n >= 1 && n <= CIRCLED_NUMBERS.length ? CIRCLED_NUMBERS[n - 1] : `(${n})`;
}

/**
 * 行内のMarkdown装飾を落とす（強調・コード・リンク）。
 * 見出しや箇条書きの行頭記号は扱わない（行単位の処理は toReadableText 側）。
 *
 * 短いAI出力（Next Action・BANT要約など、JSONの1文字列）にも単独で使える。
 */
export function stripInlineMarkdown(input: string): string {
  return input
    // **強調** / __強調__ → 中身のみ
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // *斜体* / _斜体_ → 中身のみ（記号の内側が空白でないものだけ＝掛け算やスネークケースを壊さない）
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1$2")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1$2")
    // `コード` → 中身のみ
    .replace(/`([^`]+?)`/g, "$1")
    // [表示テキスト](URL) → 表示テキスト（URL）
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）")
    // <https://...> → https://...
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
}

/** 見出し行かどうか（# 見出し） */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** 箇条書き行（- / * / + 。インデントで階層） */
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
/** 順序付き箇条書き行（1. / 1) ） */
const ORDERED_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
/** 水平線（--- / *** / ___） */
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
/** 引用（> ...） */
const QUOTE_RE = /^\s*>\s?(.*)$/;
/** チェックボックス（- [ ] / - [x] ） */
const CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
/** コードフェンス（``` / ~~~ ） */
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Markdown混じりのテキストを、日本語として読みやすいプレーンテキストに整形する。
 *
 *   # 見出し     → ■ 見出し（H2は◆、H3以下は○）
 *   - 項目       → ・項目（ネストは － → ＊）
 *   1. 項目      → ①項目
 *   - [ ] 項目   → □ 項目（済みは ☑）
 *   **強調**     → 強調（装飾記号だけ落とす）
 *   ---          → 罫線
 *   > 引用       → ｜ 引用
 *
 * コードブロック（```）の中は変換しない。整形済みテキストを再度通しても変わらない。
 */
export function toReadableText(input: string | null | undefined): string {
  if (!input) return "";
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    // コードブロックは中身も記号もそのまま（フェンス行だけ落とす）
    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }

    const line = rawLine.trimEnd();

    // 罫線
    if (HR_RE.test(line)) {
      out.push(HORIZONTAL_RULE);
      continue;
    }

    // 見出し：前に空行を1つ入れて塊を分ける
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = stripInlineMarkdown(heading[2]).trim();
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(`${HEADING_MARKS[level - 1] ?? "○"} ${text}`);
      continue;
    }

    // チェックボックス（箇条書きより先に判定）
    const checkbox = CHECKBOX_RE.exec(line);
    if (checkbox) {
      const indent = "  ".repeat(Math.floor(checkbox[1].replace(/\t/g, "  ").length / 2));
      const mark = checkbox[2].toLowerCase() === "x" ? "☑" : "□";
      out.push(`${indent}${mark} ${stripInlineMarkdown(checkbox[3]).trim()}`);
      continue;
    }

    // 箇条書き
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2);
      const mark = BULLET_MARKS[Math.min(depth, BULLET_MARKS.length - 1)];
      out.push(`${"  ".repeat(depth)}${mark}${stripInlineMarkdown(bullet[3]).trim()}`);
      continue;
    }

    // 順序付き箇条書き（最上位は丸数字、ネストは "1) " のまま読みやすく）
    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      const depth = Math.floor(ordered[1].replace(/\t/g, "  ").length / 2);
      const n = Number(ordered[2]);
      const head = depth === 0 ? circled(n) : `${n})`;
      const sep = depth === 0 ? "" : " ";
      out.push(`${"  ".repeat(depth)}${head}${sep}${stripInlineMarkdown(ordered[3]).trim()}`);
      continue;
    }

    // 引用
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      out.push(`｜ ${stripInlineMarkdown(quote[1]).trim()}`);
      continue;
    }

    out.push(stripInlineMarkdown(line));
  }

  return out
    .join("\n")
    // 空行3つ以上は2つに（見出し前の空行追加で間延びするのを防ぐ）
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
