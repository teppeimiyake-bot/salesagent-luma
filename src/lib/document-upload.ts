/**
 * 資料の添付（POST /api/documents）のサイズ上限。サーバーと画面の両方で使う。
 *
 * Cloud Run の1回の要求は32MiBまで（超えると Cloud Run の手前で HTML の 413 になり、理由が画面に出せない）。
 * 録音の1回送信（src/lib/meetings/upload-formats.ts の DIRECT_UPLOAD_MAX_BYTES）と同じく、
 * multipart の区切りや名前などの欄の余白を残して1ファイル24MiBまでにする。
 * これを超える資料は、圧縮・分割するか、共有リンク（URL）で登録してもらう。
 */
export const DOCUMENT_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

/** 画面の案内に出す上限（DOCUMENT_UPLOAD_MAX_BYTES と合わせる）。 */
export const DOCUMENT_UPLOAD_MAX_LABEL = "24MB";

/** 名前・カテゴリなどの欄と multipart の区切りの分の余白。本文全体は「上限＋余白」まで受け付ける。 */
export const DOCUMENT_UPLOAD_BODY_MARGIN_BYTES = 1024 * 1024;

export function documentTooLargeMessage(size?: number): string {
  const actual = typeof size === "number" && size > 0 ? `（${(size / (1024 * 1024)).toFixed(1)}MB）` : "";
  return `ファイルが大きすぎます${actual}。資料は1ファイル${DOCUMENT_UPLOAD_MAX_LABEL}まで添付できます。PDFを圧縮するか、ファイルを分けて添付してください。`;
}

/** 送る前の確認。上限を超えていれば案内の文言、問題なければ null。 */
export function documentUploadSizeError(file: { size: number } | null | undefined): string | null {
  return file && file.size > DOCUMENT_UPLOAD_MAX_BYTES ? documentTooLargeMessage(file.size) : null;
}
