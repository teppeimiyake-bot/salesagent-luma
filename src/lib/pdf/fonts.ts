/**
 * @react-pdf/renderer 用の日本語フォント登録。
 *
 * Noto Sans JP（日本語サブセットの静的TTF・glyf アウトライン）を src/lib/pdf/fonts に同梱。
 *   - Regular (fontWeight: normal)
 *   - Bold    (fontWeight: bold)
 * 合計 約4.7MB。Vercel のサーバレス関数バンドルに含めるため、import 経由ではなく
 * 絶対パス（process.cwd() ベース）で読み込む。`next.config` で serverExternalPackages 指定済みの
 * Prisma と同様、フォントファイルはトレース対象に含まれるよう PDFルートで明示参照する。
 *
 * registerFonts() は何度呼んでも一度だけ実際の登録を行う（idempotent）。
 */
import path from "node:path";
import { Font } from "@react-pdf/renderer";

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
  // CJK は単語区切りが無く、@react-pdf のデフォルト改行（スペース基準）だと行が溢れる。
  // 文字単位で折り返せるように、ハイフネーションを「分割しない」コールバックにしておくと
  // fontkit 側の禁則そのままで素直に文字単位改行される。
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}
