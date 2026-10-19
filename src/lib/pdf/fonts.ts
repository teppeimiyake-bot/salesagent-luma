/**
 * @react-pdf/renderer 用の日本語フォント登録。
 *
 * Noto Sans JP（SIL OFL 1.1。静的TTF・glyf アウトライン）を src/lib/pdf/fonts に同梱。
 *   - Regular (fontWeight: normal) … 可変フォント NotoSansJP[wght] を wght=400 に固定したもの
 *   - Bold    (fontWeight: bold)   … 同じく wght=700
 * JIS X 0208 全字（≒ は上流に無いため同じフォントの字形から合成）、JIS X 0213 の漢字、
 * NEC/IBM 拡張（髙・﨑・①・㈱ など）、全角英数を収録する。各 約5.8MB。
 * 入手元・作成コマンド・ライセンスは docs/development-t14-pdf-fonts.md と fonts/OFL.txt を参照。
 *
 * サーバーのバンドルに含めるため、import 経由ではなく絶対パス（process.cwd() ベース）で読み込む。
 * Cloud Run 用のビルドは scripts/cloud-development-next-config.mjs の outputFileTracingIncludes と
 * Dockerfile でこのディレクトリをコピーしている。
 *
 * registerFonts() は何度呼んでも一度だけ実際の登録を行う（idempotent）。
 */
import path from "node:path";
import { Font } from "@react-pdf/renderer";
import { splitForLineBreak } from "./line-break";

export const PDF_FONT_FAMILY = "NotoSansJP";

let registered = false;

function fontPath(file: string): string {
  // Next.js のサーバ実行時、CWD はプロジェクトルート。フォントは src 配下に置く。
  return path.join(process.cwd(), "src", "lib", "pdf", "fonts", file);
}

export function registerFonts(): void {
  if (registered) return;
  Font.register({
    family: PDF_FONT_FAMILY,
    fonts: [
      { src: fontPath("NotoSansJP-Regular.ttf"), fontWeight: "normal" },
      { src: fontPath("NotoSansJP-Bold.ttf"), fontWeight: "bold" },
    ],
  });
  // 日本語は1文字ずつ（禁則を守って）ハイフン無しで折り返し、英単語は途中で切らない。
  // 詳細は line-break.ts。以前の (w) => [w] は日本語の途中に「-」を挟んだり列からはみ出したりした。
  Font.registerHyphenationCallback(splitForLineBreak);
  registered = true;
}
