/**
 * リージーの書類ファイルを Luma の Blob ストアへ移す（Phase 5 の続き）
 * ============================================================
 * データ移管（migrate-reagey.mjs）では書類のメタ情報しか移せない。
 * ファイルの実体は Vercel Blob にあり、リージーと Luma でストアが別のため、
 * リージーからダウンロードして Luma へアップロードし直す必要がある。
 *
 * documents.file_url には Blob の pathname（"documents/xxx.pdf"）が入っている。
 * 同じ pathname で Luma 側に置くので、DB は書き換えなくてよい。
 * （Canva などの外部URLが入っている行は対象外）
 *
 * 事前準備 — 両方のトークンを取得しておく:
 *   npx vercel env pull .env.luma-prod --environment=production
 *   cd C:/dev/salesagent-reagey && npx vercel env pull .env.reagey-prod --environment=production
 *
 * 実行:
 *   node scripts/migrate-reagey-blobs.mjs --dry-run
 *   node scripts/migrate-reagey-blobs.mjs
 *
 * 実行後は .env.luma-prod / .env.reagey-prod を削除すること。
 */
import fs from "node:fs";
import pg from "pg";
import { list, put, head, get } from "@vercel/blob";

const DRY = process.argv.includes("--dry-run");
const REAGEY = "22222222-2222-4222-8222-222222222222";

const readToken = (p) => {
  const t = fs.readFileSync(p, "utf8").match(/^BLOB_READ_WRITE_TOKEN\s*=\s*"?([^"\r\n]+)/m)?.[1];
  if (!t) throw new Error(`${p} に BLOB_READ_WRITE_TOKEN が無い`);
  return t.trim();
};
const srcToken = readToken("C:/dev/salesagent-reagey/.env.reagey-prod");
const dstToken = readToken(".env.luma-prod");
const dbUrl = fs.readFileSync(".env.production.local", "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const docs = (await db.query(
  `select id, name, file_url, mime_type, file_size from documents where tenant_id=$1 order by created_at`,
  [REAGEY])).rows;
await db.end();

// 外部URL（Canva等）はファイル実体が Blob に無いので対象外
const targets = docs.filter((d) => d.file_url && !/^https?:\/\//i.test(d.file_url));
console.log(`リージーの書類 ${docs.length} 件のうち、Blob 実体を持つのは ${targets.length} 件${DRY ? "（dry-run）" : ""}\n`);

// リージー側の Blob 一覧（pathname → 実URL）
const srcIndex = new Map();
let cursor;
do {
  const page = await list({ token: srcToken, cursor, limit: 1000 });
  for (const b of page.blobs) srcIndex.set(b.pathname, b);
  cursor = page.cursor;
} while (cursor);
console.log(`リージーの Blob: ${srcIndex.size} 個\n`);

let moved = 0, already = 0, missing = 0, failed = 0;

for (const d of targets) {
  const key = d.file_url;
  const src = srcIndex.get(key);
  if (!src) {
    console.log(`  ✗ ${d.name} … リージーの Blob に実体が無い（${key}）`);
    missing++;
    continue;
  }
  // 既に Luma 側にあるならスキップ（再実行できるように）
  try {
    await head(key, { token: dstToken });
    console.log(`  - ${d.name} … 既に移行済み`);
    already++;
    continue;
  } catch {
    /* 無い＝これから入れる */
  }
  if (DRY) {
    console.log(`  → ${d.name} … 移行する（${Math.round((src.size ?? 0) / 1024)}KB）`);
    moved++;
    continue;
  }
  try {
    // 両社ともプライベートストアなので URL 直アクセスは 403。get() で認証付きに取る
    const result = await get(key, { access: "private", token: srcToken, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new Error(`ダウンロード失敗（statusCode=${result?.statusCode ?? "不明"}）`);
    }
    const chunks = [];
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    await put(key, buf, {
      access: "private", // Luma 側も private ストア（src/lib/storage.ts と揃える）
      token: dstToken,
      addRandomSuffix: false, // 同じ pathname で置く（DB を書き換えずに済む）
      contentType: d.mime_type || "application/octet-stream",
    });
    console.log(`  ✓ ${d.name} … 移行（${Math.round(buf.length / 1024)}KB）`);
    moved++;
  } catch (e) {
    console.log(`  ✗ ${d.name} … ${e.message}`);
    failed++;
  }
}

console.log(`\n移行 ${moved} / 既存 ${already} / 実体なし ${missing} / 失敗 ${failed}`);
if (DRY) console.log("--dry-run のため何も書き込んでいない");
process.exit(failed ? 1 : 0);
