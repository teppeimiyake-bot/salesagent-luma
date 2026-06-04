/**
 * React-PDF 要素を Buffer にレンダリングする共通ヘルパー（サーバ専用）。
 * フォント登録を必ず先に行う。
 */
import { renderToBuffer } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { registerFonts } from "./fonts";

export async function renderPdfBuffer(element: ReactElement): Promise<Buffer> {
  registerFonts();
  // @react-pdf の renderToBuffer は DocumentElement を要求する型だが、
  // <Document>… の ReactElement で実体は一致する。
  const buf = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
  return Buffer.from(buf);
}
