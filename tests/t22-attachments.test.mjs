import assert from "node:assert/strict";
import test from "node:test";
import {zipSync,strToU8} from "fflate";
import {offlineModule} from "./helpers/offline-module.mjs";
const entry="src/lib/meetings/attachment-text.ts";
// Real ZIP parsing and UTF-8 decoding, no network/AI.
const {unzipSync,strFromU8}=await import("fflate");
const lib=await offlineModule(entry,{unzipSync,strFromU8}, {"server-only":"","fflate":"export const unzipSync=mocks.unzipSync;export const strFromU8=mocks.strFromU8;"},[entry,"src/lib/meetings/upload-formats.ts"]);
test("UTF-8 text and Markdown including BOM",()=>{
 assert.equal(lib.extractAttachmentText("demo.txt",Buffer.from("\ufeff顧客: 予算250万円\n")),"顧客: 予算250万円");
 assert.equal(lib.extractAttachmentText("demo.md",Buffer.from("# 議事録\n本文")),"# 議事録\n本文");
 assert.throws(()=>lib.extractAttachmentText("demo.txt",Buffer.from([0xff,0xfe])),/UTF-8/);
 assert.throws(()=>lib.extractAttachmentText("demo.txt",Buffer.from("  ")),/本文/);
});
test("DOCX paragraphs/entities/tab break and literal encoded entity are retained",()=>{
 const buf=Buffer.from(zipSync({"word/document.xml":strToU8('<w:document><w:p><w:r><w:t>顧客: 予算250万円 &amp;#65; &#x1f600;</w:t><w:tab/><w:t>案</w:t></w:r></w:p><w:p><w:t>次回9月30日</w:t></w:p></w:document>'),"word/media/large.jpg":new Uint8Array(6*1024*1024)}));
 assert.equal(lib.extractAttachmentText("demo.docx",buf),"顧客: 予算250万円 &#65; 😀\t案\n次回9月30日");
});
test("corrupt/missing/expanded oversized DOCX and empty files are rejected",()=>{
 for(const buf of [Buffer.from("broken"),Buffer.from(zipSync({"other.xml":strToU8('x')})),Buffer.from(zipSync({"word/document.xml":new Uint8Array(5*1024*1024+1)}))]) assert.throws(()=>lib.extractAttachmentText("demo.docx",buf),/DOCX/);
 assert.throws(()=>lib.extractAttachmentText("demo.txt",Buffer.alloc(5*1024*1024+1)),/5MB/);
});
