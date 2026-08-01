/**
 * 手書きマイグレーション台本を実行する
 * ============================================================
 * このプロジェクトは prisma migrate を使っていないため、
 * prisma/migrations-manual/*.sql をこのスクリプトで流す。
 *
 * 使い方:
 *   node scripts/run-sql.cjs <envファイル> <SQLファイル>
 *
 * 例（Neon のテスト用ブランチに流す）:
 *   node scripts/run-sql.cjs .env.staging prisma/migrations-manual/2026-08-01_01_multi_tenant_up.sql
 *
 * 安全策:
 *   - 接続先のホスト名とDB名を表示し、5秒待ってから実行する（Ctrl+C で中断可能）
 *   - SQL 全体を1つのトランザクションで囲まず、台本内の BEGIN/COMMIT をそのまま使う
 *     （途中で失敗したら台本の COMMIT に到達せず巻き戻る）
 *   - 待機を飛ばしたいときは環境変数 SKIP_CONFIRM=1
 */
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const [envFile, sqlFile] = process.argv.slice(2);
if (!envFile || !sqlFile) {
  console.error("使い方: node scripts/run-sql.cjs <envファイル> <SQLファイル>");
  process.exit(1);
}
for (const f of [envFile, sqlFile]) {
  if (!fs.existsSync(f)) {
    console.error(`ファイルが見つかりません: ${f}`);
    process.exit(1);
  }
}

const envText = fs.readFileSync(envFile, "utf8");
const m = envText.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
if (!m) {
  console.error(`${envFile} に DATABASE_URL がありません`);
  process.exit(1);
}
const url = m[1];
const sql = fs.readFileSync(sqlFile, "utf8");

let host = "(不明)";
let dbName = "(不明)";
try {
  const u = new URL(url);
  host = u.host;
  dbName = u.pathname.replace(/^\//, "");
} catch {
  /* 解析できなくても実行は続ける */
}

(async () => {
  console.log("============================================");
  console.log("  接続先ホスト : " + host);
  console.log("  データベース : " + dbName);
  console.log("  SQLファイル  : " + path.basename(sqlFile));
  console.log("============================================");

  if (process.env.SKIP_CONFIRM !== "1") {
    console.log("5秒後に実行します。中断する場合は Ctrl+C。");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  const started = Date.now();
  try {
    await client.query(sql);
    console.log(`\n完了（${Math.round((Date.now() - started) / 1000)}秒）`);
  } catch (e) {
    console.error("\n失敗しました。台本内の BEGIN/COMMIT により変更は巻き戻っています。");
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
