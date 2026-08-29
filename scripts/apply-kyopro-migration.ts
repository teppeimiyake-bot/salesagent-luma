/**
 * 京プロ Phase 1 のスキーマ追加を流す
 * ============================================================
 * prisma/migrations-manual/2026-08-29_01_kyopro_up.sql を実行する。
 * psql が入っていない環境向けの実行係。SQL 自体がトランザクションなので、
 * 途中で落ちれば何も残らない。
 *
 * 使い方:
 *   確認のみ: npx tsx --env-file=.env.production.local scripts/apply-kyopro-migration.ts
 *   実行:     npx tsx --env-file=.env.production.local scripts/apply-kyopro-migration.ts --apply
 *   戻す:     npx tsx --env-file=.env.production.local scripts/apply-kyopro-migration.ts --down --apply
 *
 * ※ 本番に `prisma db push` を使ってはいけない（tenant_id の FK 34 本が消える）。
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DOWN = args.includes("--down");
/** どの台本を流すか（連番）。--file 02 で 2番目のマイグレーションを指す。既定は 01。 */
const SERIAL = (() => {
  const i = args.indexOf("--file");
  return i >= 0 ? args[i + 1] : "01";
})();

const dir = path.join(process.cwd(), "prisma/migrations-manual");
const suffix = DOWN ? "_down.sql" : "_up.sql";
const matches = fs
  .readdirSync(dir)
  .filter((f) => f.includes(`_${SERIAL}_`) && f.endsWith(suffix) && f.includes("kyopro"))
  .sort();
if (matches.length !== 1) {
  throw new Error(
    `台本が一意に決まりません（--file ${SERIAL}${DOWN ? " --down" : ""}）: ${matches.join(", ") || "該当なし"}`,
  );
}
const file = path.join(dir, matches[0]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL が設定されていません");
  const host = new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).host;
  const sql = fs.readFileSync(file, "utf8");

  console.log(`対象DB : ${host}`);
  console.log(`SQL    : ${path.basename(file)}（${sql.split("\n").length} 行）`);
  if (!APPLY) {
    console.log("\n--- 確認のみ。実行するには --apply を付けてください ---");
    return;
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
    const { rows } = await client.query(
      "select table_name from information_schema.tables where table_name like 'kyopro%' order by table_name",
    );
    console.log(`完了。kyopro テーブル: ${rows.map((r) => r.table_name).join(", ") || "（なし）"}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
