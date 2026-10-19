/**
 * 日本語PDF用の <Text>。@react-pdf/renderer の Text に hyphenationPenalty={NO_HYPHENATION_PENALTY} を付けたもの。
 * 見積書・契約書のテンプレートは @react-pdf/renderer の Text ではなく、必ずこちらを使う。
 *
 * react-pdf（textkit）は、ハイフネーションコールバック（line-break.ts）を呼ぶ前に文字列を文字種ごとの
 * ラン（漢字｜かな｜英字 など）と JSX の文字列ごとに分ける。コールバックはランの境目を見られないため、
 * 「編集データは｜Adobe」「行｜って」「撮影4｜K」のような境目には、行末に「-」を足す改行位置
 * （penalty ノード）が残る。半角スペースを含む段落では Knuth–Plass がそこを選ぶことがあり、
 * 「編集データは-／Adobe Premiere Pro」「行-／って」のような折り返しになっていた。
 *
 * ペナルティを textkit の「無限大」（linebreak.infinity = 10000）にすると、Knuth–Plass はその位置を
 * 改行候補から外す。行が組めずに最良適合（best fit）へ落ちた場合も、同じ行にハイフン無しの改行位置
 * （glue）があればそちらが選ばれる。日本語の文字間・語間の改行位置（line-break.ts の空音節と半角スペース）
 * はペナルティと関係ないので、折り返し自体は今までどおり行われる。
 *
 * hyphenationPenalty は react-pdf の型定義（TextProps）に無いが、@react-pdf/layout が Text の props から
 * textkit のレイアウトオプションへそのまま渡している（@react-pdf/layout 4.x の getLayoutOptions）。
 */
import React from "react";
import { Text as ReactPdfText } from "@react-pdf/renderer";

/** textkit で「ここでは改行しない」を表すペナルティ（Knuth–Plass の無限大）。 */
export const NO_HYPHENATION_PENALTY = 10000;

export function Text(props: React.ComponentProps<typeof ReactPdfText>) {
  const layout = { hyphenationPenalty: NO_HYPHENATION_PENALTY };
  return <ReactPdfText {...props} {...layout} />;
}
