export const TEXT_ATTACHMENT_EXTENSIONS = ["txt", "md", "markdown", "docx"] as const;

export const MEDIA_ATTACHMENT_EXTENSIONS = [
  "mp3",
  "m4a",
  "wav",
  "webm",
  "mp4",
  "mov",
  "mpeg",
  "mpg",
  "ogg",
  "oga",
  "aac",
  "flac",
  "aiff",
  "avi",
  "mkv",
] as const;

export const UPLOAD_RECORDING_ACCEPT = [
  ".txt",
  ".md",
  ".markdown",
  ".docx",
  "audio/*",
  "video/*",
].join(",");

/**
 * これを超える録音・録画は、通常の1回送信ではなく分割アップロード（8MiBずつ）で送る。
 * Cloud Run の1リクエスト上限32MiBに、multipart の余白を残した値。
 */
export const DIRECT_UPLOAD_MAX_BYTES = 24 * 1024 * 1024;

export function fileExtension(filename: string): string {
  const last = filename.toLowerCase().split(".").pop();
  return last && last !== filename.toLowerCase() ? last : "";
}

export function isTextAttachmentExtension(extension: string): boolean {
  return (TEXT_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension);
}

export function isMediaAttachmentExtension(extension: string): boolean {
  return (MEDIA_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension);
}

export function unsupportedAttachmentMessage(filename: string): string {
  const extension = fileExtension(filename);
  if (extension === "pdf") {
    return "PDFは文字の並びや画像化の状態によって抽出結果が変わるため、この取込では対応していません。.txt、.md、.docx、音声または動画を添付してください。";
  }
  return `「${filename}」は対応していない形式です。.txt、.md、.docx、音声または動画を添付してください。`;
}
