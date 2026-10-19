/**
 * 見積書の備考プリセット（T14 AC-07 / D-05）。
 *
 *   - 標準備考 … 新規見積では既定で入れる（既定ON）。まとめてON/OFFする。
 *   - 交通費備考 … 選択肢から1つ選ぶか入れない（既定なし）。
 * 文面は QuoteIssuerProfile.defaultNotes / travelExpenseNote（1行＝1項目。管理画面
 * /admin/quote-settings で変更できる）から読む。初期値はサンプル見積書どおりの文面で、
 * quote-issuer.ts の DEFAULT_QUOTE_NOTES / DEFAULT_TRAVEL_NOTE に置いてある。
 * クライアント部品からも使うので、実行時に Prisma を読み込むものは import しない。
 */

import { DEFAULT_QUOTE_NOTES, DEFAULT_TRAVEL_NOTE } from "@/lib/quote-issuer";

export interface QuoteNotePresets {
  /** 標準備考（まとめてON/OFF） */
  standard: string[];
  /** 交通費備考の選択肢 */
  travel: string[];
}

export interface QuoteNoteSelection {
  standard: boolean;
  /** presets.travel の添字。null は「入れない」 */
  travelIndex: number | null;
  /** プリセット以外の自由記述 */
  extra: string;
}

/** 設定値のテキストを1行＝1項目の配列にする（空行は捨てる）。 */
export function noteLines(text: string | null | undefined): string[] {
  return (text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** 発行者設定からプリセットを作る。設定がまだ無いテナントはサンプルの文面を使う。 */
export function quoteNotePresets(
  profile: { defaultNotes: string; travelExpenseNote: string | null } | null | undefined,
): QuoteNotePresets {
  const source = profile ?? { defaultNotes: DEFAULT_QUOTE_NOTES, travelExpenseNote: DEFAULT_TRAVEL_NOTE };
  return { standard: noteLines(source.defaultNotes), travel: noteLines(source.travelExpenseNote) };
}

/** 新規見積の初期状態：標準備考ON・交通費備考なし・自由記述なし。 */
export function initialNoteSelection(): QuoteNoteSelection {
  return { standard: true, travelIndex: null, extra: "" };
}

/** 選択状態から保存する備考テキストを組み立てる（標準→交通費→自由記述の順）。 */
export function composeQuoteNote(presets: QuoteNotePresets, selection: QuoteNoteSelection): string {
  const travel = selection.travelIndex === null ? undefined : presets.travel[selection.travelIndex];
  return [
    ...(selection.standard ? presets.standard : []),
    ...(travel ? [travel] : []),
    selection.extra.trim(),
  ].filter(Boolean).join("\n");
}

/**
 * 保存済みの備考を選択状態に戻す（編集・改訂用）。先頭が標準備考と一致すればON、続く1行が
 * 交通費備考のどれかと一致すればその選択、残りは自由記述。どれにも一致しない備考（旧文面・
 * 手入力）は全文を自由記述に入れるので、内容は失われない。
 */
export function splitQuoteNote(note: string | null | undefined, presets: QuoteNotePresets): QuoteNoteSelection {
  const lines = (note ?? "").split(/\r?\n/);
  let index = 0;
  const standard = presets.standard.length > 0
    && presets.standard.every((line, offset) => (lines[offset] ?? "").trim() === line);
  if (standard) index = presets.standard.length;
  const travelIndex = index < lines.length ? presets.travel.indexOf(lines[index].trim()) : -1;
  if (travelIndex >= 0) index += 1;
  return {
    standard,
    travelIndex: travelIndex >= 0 ? travelIndex : null,
    extra: lines.slice(index).join("\n").trim(),
  };
}
