import "server-only";
import { strFromU8, unzipSync } from "fflate";
import { fileExtension } from "@/lib/meetings/upload-formats";

const MAX_TEXT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = { lt: "<", gt: ">", quot: '\"', apos: "'", amp: "&" };
  return value.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (entity, code: string) => {
    if (!code.startsWith("#")) return named[code] ?? entity;
    const point = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : "�";
  });
}

function extractDocxText(buffer: Buffer): string {
  let archive: ReturnType<typeof unzipSync>;
  let oversized = false;
  try {
    archive = unzipSync(new Uint8Array(buffer), { filter: entry => {
      if (entry.name !== "word/document.xml") return false;
      oversized = entry.originalSize > MAX_TEXT_ATTACHMENT_BYTES;
      return !oversized;
    } });
  } catch {
    throw new Error("DOCXファイルを開けませんでした。破損していないWord文書を書き出し直してください。");
  }

  if (oversized) throw new Error("DOCX本文は展開後5MB以下にしてください。文書を分割して再度添付してください。");
  const documentXml = archive["word/document.xml"];
  if (!documentXml) {
    throw new Error("DOCX本文が見つかりませんでした。GoogleドキュメントまたはWordから.docxで書き出し直してください。");
  }

  const xml = strFromU8(documentXml);
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractAttachmentText(filename: string, buffer: Buffer): string {
  if (buffer.byteLength > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error("テキスト添付は5MB以下にしてください。長い場合は複数ファイルに分けてください。");
  }

  const extension = fileExtension(filename);
  let text: string;
  if (extension === "docx") {
    text = extractDocxText(buffer);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^\uFEFF/, "").trim();
    } catch {
      throw new Error("テキストをUTF-8として読めませんでした。UTF-8の.txtまたは.mdで保存し直してください。");
    }
  }

  if (!text) {
    throw new Error("添付ファイルに解析できる本文がありません。内容を確認してください。");
  }
  return text;
}
