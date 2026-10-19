// 資料の添付（POST /api/documents）のサイズ上限と、ミドルウェアの対象外にしたときの認証。
// 以前は src/middleware.ts が /api/meetings だけを対象外にしていたため、資料の本文がミドルウェアの複製の上限
// （10MB）で切られ、route の formData() が例外を出して中身なしの 500 になっていた。
// 外部通信・実際のストレージは使わない（架空のファイルのみ）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { offlineModule } from "./helpers/offline-module.mjs";

const MiB = 1024 * 1024;
const entry = "src/app/api/documents/route.ts";

async function loadRoute(overrides = {}) {
  const m = { session: { userId: "user-1" }, permission: "user", puts: [], created: [], listed: 0, ...overrides };
  m.prisma = {
    user: { findUnique: async () => ({ permission: m.permission }) },
    document: {
      create: async ({ data }) => { const row = { id: `doc-${m.created.length + 1}`, ...data }; m.created.push(row); return row; },
      findMany: async () => { m.listed++; return []; },
    },
  };
  const route = await offlineModule(entry, m, {
    "@/lib/db": "export const prisma=mocks.prisma;",
    "@/lib/auth": "export const getSession=async()=>mocks.session;export const getCurrentPermission=async()=>{const s=await getSession();if(!s)return null;const u=await globalThis.mocks.prisma?.user?.findUnique?.({where:{id:s.userId},select:{permission:true}});return u?.permission??null;};export const hasPermission=(p,r)=>r==='admin'?p==='admin':['user','admin'].includes(p);",
    "@/lib/storage": "export class StorageConfigError extends Error {};export const putFile=async(a)=>{mocks.puts.push(a.filename);return {url:'/uploads/documents/'+a.filename};};",
    "@/lib/tenant-context": "export const currentTenant=()=>mocks.ctx??undefined;export const getRequestTenant=async()=>null;",
  }, [entry, "src/lib/document-upload.ts"], ["zod", "next/server", "node:crypto"]);
  return { m, route };
}

function multipart(size, extraHeaders = {}) {
  const fd = new FormData();
  fd.append("name", "架空の提案書");
  fd.append("category", "proposal");
  fd.append("file", new Blob([new Uint8Array(size)], { type: "application/pdf" }), "架空の提案書.pdf");
  const req = new Request("http://offline.invalid/api/documents", { method: "POST", body: fd });
  const headers = new Headers(req.headers);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Request(req, { headers, duplex: "half" });
}

test("資料の添付: 上限内（5MiB）の資料は保存できる", async () => {
  const { m, route } = await loadRoute();
  const res = await route.POST(multipart(5 * MiB));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(m.puts.length, 1);
  assert.equal(m.created[0].fileSize, 5 * MiB);
});

test("資料の添付: 上限を超える資料は 413 と日本語の理由を返し、保存しない", async () => {
  const lib = await offlineModule("src/lib/document-upload.ts", {}, {});
  assert.ok(lib.DOCUMENT_UPLOAD_MAX_BYTES < 32 * MiB, "Cloud Run の1回の要求の上限（32MiB）より小さい");
  const { m, route } = await loadRoute();
  const res = await route.POST(multipart(lib.DOCUMENT_UPLOAD_MAX_BYTES + 1));
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "DOCUMENT_TOO_LARGE");
  assert.match(body.error, /ファイルが大きすぎます/);
  assert.match(body.error, /24MB/);
  assert.equal(m.puts.length, 0);
  assert.equal(m.created.length, 0);
});

test("資料の添付: Content-Length が上限を大きく超えるときは、本文を読まずに 413 を返す", async () => {
  const { m, route } = await loadRoute();
  let read = false;
  const req = {
    headers: new Headers({ "content-type": "multipart/form-data; boundary=x", "content-length": String(30 * MiB) }),
    formData: async () => { read = true; throw new TypeError("should not be read"); },
    json: async () => { read = true; return null; },
  };
  const res = await route.POST(req);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /ファイルが大きすぎます/);
  assert.equal(read, false);
  assert.equal(m.puts.length, 0);
});

test("資料の添付: multipart を解析できないときは、中身なしの 500 ではなく 400 と理由を返す", async () => {
  const { m, route } = await loadRoute();
  const req = new Request("http://offline.invalid/api/documents", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=----luma" },
    body: "------luma\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n\r\n途中で切れた本文",
  });
  const res = await route.POST(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_MULTIPART");
  assert.match(body.error, /読み取れませんでした/);
  assert.equal(m.puts.length, 0);
});

test("資料の添付: 未ログインは、サイズに関係なく 401（認証が先）", async () => {
  const { m, route } = await loadRoute({ session: null });
  assert.equal((await route.POST(multipart(1024))).status, 401);
  const res = await route.GET(new Request("http://offline.invalid/api/documents"));
  assert.equal(res.status, 401, "ミドルウェアの対象外にしても、一覧の取得は未ログインで読めない");
  assert.equal(m.listed, 0);
});

test("資料の添付: 閲覧のみの利用者は、サイズに関係なく 403", async () => {
  const { m, route } = await loadRoute({ permission: "viewer" });
  assert.equal((await route.POST(multipart(1024))).status, 403);
  assert.equal(m.puts.length, 0);
});

test("ミドルウェア: /api/documents（ちょうどこのパス）だけを対象外にし、/api/documents/[id] などは対象のまま（Next の matcher の組み立てで確かめる）", async () => {
  const source = await readFile(new URL("../src/middleware.ts", import.meta.url), "utf8");
  const literal = source.match(/matcher:\s*(\[[^\]]*\])/)?.[1];
  assert.ok(literal, "matcher");
  const matchers = JSON.parse(literal.replace(/'/g, '"'));
  // Next がビルド時に middleware の matcher から作る正規表現（next/dist/build/analysis/get-page-static-info）で判定する
  const { getMiddlewareMatchers } = createRequire(import.meta.url)("next/dist/build/analysis/get-page-static-info");
  const regexps = getMiddlewareMatchers(matchers, { basePath: "", i18n: undefined }).map((m) => new RegExp(m.regexp));
  const covered = (pathname) => regexps.some((re) => re.test(pathname));
  assert.equal(covered("/api/documents"), false);
  assert.equal(covered("/api/meetings"), false);
  for (const pathname of ["/api/documents/abc/download", "/api/documents/abc", "/api/documents/", "/api/deals", "/deals", "/api/meetings/upload-sessions", "/"]) {
    assert.equal(covered(pathname), true, pathname);
  }
});

test("資料の添付: 全社統合ビューでは 500 ではなく 403 と理由を返し、保存しない", async () => {
  const { m, route } = await loadRoute({ ctx: { tenantId: null, crossTenant: true, permission: "viewer" } });
  const res = await route.POST(multipart(1024));
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /全社統合ビュー/);
  assert.equal(m.puts.length, 0);
  assert.equal(m.created.length, 0);
  // 読み取り（一覧）は全社統合ビューでもこれまでどおり
  assert.equal((await route.GET(new Request("http://offline.invalid/api/documents"))).status, 200);
});
