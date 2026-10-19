import assert from "node:assert/strict";
import test from "node:test";
import { offlineModule } from "./helpers/offline-module.mjs";

const entry = "src/app/api/documents/[id]/download/route.ts";
const boundaries = {
  "@/lib/db": "export const prisma=mocks.prisma;",
  "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=p=>p==='admin';",
  "@/lib/storage": "export const fetchStored=(...args)=>mocks.fetchStored(...args);",
};

async function setup() {
  const state = {
    session: { userId: "development-user" },
    permission: "user",
    doc: {
      id: "development-document",
      name: "架空テスト株式会社 見積書（L-20260922-0001）",
      category: "quote",
      sourceType: "file",
      mimeType: "application/pdf",
      fileUrl: "/uploads/development-quote.pdf",
    },
    fetched: { buffer: Buffer.from("%PDF-1.4\nfixture"), contentType: "application/octet-stream" },
    storedCalls: [],
    docCalls: [],
  };
  state.prisma = {
    document: { findUnique: async (query) => { state.docCalls.push(query); return state.doc; } },
    user: { findUnique: async () => ({ permission: state.permission }) },
  };
  state.fetchStored = async (url) => { state.storedCalls.push(url); return state.fetched; };
  const route = await offlineModule(entry, state, boundaries);
  state.get = (query = "") => route.GET(new Request(`http://offline.invalid/api/documents/development-document/download${query}`), {
    params: Promise.resolve({ id: "development-document" }),
  });
  return state;
}

function names(response) {
  const disposition = response.headers.get("Content-Disposition");
  assert.ok(disposition);
  const fallback = disposition.match(/filename="([^"]*)"/)?.[1];
  const encoded = disposition.match(/filename\*=UTF-8''(.*)$/)?.[1];
  assert.ok(encoded);
  return { disposition, fallback, unicode: decodeURIComponent(encoded) };
}

test("T14 PDF title gets .pdf in Japanese and ASCII download filenames without changing content", async () => {
  const state = await setup();
  const response = await state.get();
  assert.equal(response.status, 200);
  const filename = `${state.doc.name}.pdf`;
  const header = names(response);
  assert.equal(header.unicode, filename);
  assert.equal(header.fallback, "_________ ____L-20260922-0001_.pdf");
  assert.match(header.disposition, /^attachment;/);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.equal(response.headers.get("Content-Length"), String(state.fetched.buffer.length));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), state.fetched.buffer);
});

test("T14 existing .pdf and .PDF suffixes are preserved without duplication", async () => {
  const state = await setup();
  for (const name of ["見積書.pdf", "見積書.PDF", "quote.PdF"]) {
    state.doc.name = name;
    assert.equal(names(await state.get()).unicode, name);
  }
});

test("T14 MIME fallback from storage also supplies the PDF extension, including inline responses", async () => {
  const state = await setup();
  state.doc.mimeType = null;
  state.fetched.contentType = "Application/PDF; charset=binary";
  const inline = await state.get("?inline=1");
  const header = names(inline);
  assert.match(header.disposition, /^inline;/);
  assert.equal(header.unicode, `${state.doc.name}.pdf`);
  assert.equal(header.fallback, names(await state.get()).fallback);
  assert.equal(inline.headers.get("Content-Type"), state.fetched.contentType);
});

test("T14 non-PDF filenames are unchanged and missing names still get a usable filename", async () => {
  const state = await setup();
  state.doc.mimeType = "text/plain";
  state.doc.name = "議事録";
  state.fetched.contentType = "application/pdf";
  assert.equal(names(await state.get()).unicode, "議事録");
  state.doc.mimeType = null;
  state.fetched.contentType = null;
  const unknown = await state.get();
  assert.equal(names(unknown).unicode, "議事録");
  assert.equal(unknown.headers.get("Content-Type"), "application/octet-stream");
  state.doc.name = "";
  assert.equal(names(await state.get()).unicode, "file");
  state.doc.mimeType = "application/pdf";
  const unnamedPdf = names(await state.get());
  assert.equal(unnamedPdf.unicode, "file.pdf");
  assert.equal(unnamedPdf.fallback, "file.pdf");
});

test("T14 filename sanitization remains applied before adding the PDF suffix", async () => {
  const state = await setup();
  state.doc.name = '見積書\r\n"\\';
  const header = names(await state.get());
  assert.equal(header.unicode, "見積書____.pdf");
  assert.equal(header.fallback, "_______.pdf");
});

test("T14 unauthenticated users and non-admin contract access still cannot fetch stored documents", async () => {
  const state = await setup();
  state.session = null;
  assert.equal((await state.get()).status, 401);
  assert.equal(state.docCalls.length, 0);
  state.session = { userId: "development-user" };
  state.doc.category = "contract";
  assert.equal((await state.get()).status, 403);
  assert.equal(state.storedCalls.length, 0);
  state.permission = "admin";
  assert.equal((await state.get()).status, 200);
});

test("T14 missing records, missing URLs and absent file contents retain 404 responses", async () => {
  const state = await setup();
  const document = state.doc;
  state.doc = null;
  assert.equal((await state.get()).status, 404);
  state.doc = document;
  for (const fileUrl of [null, "(リンク未登録) "]) {
    state.doc.fileUrl = fileUrl;
    assert.equal((await state.get()).status, 404);
  }
  assert.equal(state.storedCalls.length, 0);
  state.doc.fileUrl = "/uploads/missing.pdf";
  state.fetched = null;
  assert.equal((await state.get()).status, 404);
});

test("T14 external-link documents still redirect without fetching storage or changing their URL", async () => {
  const state = await setup();
  state.doc.sourceType = "url";
  state.doc.fileUrl = "https://example.invalid/quotation";
  const response = await state.get();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), state.doc.fileUrl);
  assert.equal(response.headers.get("Content-Disposition"), null);
  assert.equal(state.storedCalls.length, 0);
});
