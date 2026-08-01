/**
 * リージー移管データを消して、移管前の状態に戻す（やり直し用）
 * ============================================================
 * tenant_id='reagey' のレコードと、リージー起票で新規作成された企業を削除する。
 * Luma のデータには一切触れない。
 *
 * 移管リハーサルをやり直すためのもの。マッピングを直して再実行したいときに使う。
 *
 * 実行: node scripts/reset-reagey-migration.mjs .env.staging --confirm-delete
 */
import fs from "node:fs";
import pg from "pg";

// Contact は Luma・リージー共有のマスタなので tenant_id を持たない。
// 移管で追加された分は「リージー側に同じ id が存在するか」でしか特定できないため、
// リージーDBから id 一覧を引いて消す。
const srcUrl = fs.readFileSync("C:/dev/salesagent-reagey/.env.production", "utf8")
  .match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];

const envFile = process.argv[2];
const CONFIRMED = process.argv.includes("--confirm-delete");
const REAGEY = "22222222-2222-4222-8222-222222222222";
const LUMA = "11111111-1111-4111-8111-111111111111";

if (!envFile) {
  console.error("使い方: node scripts/reset-reagey-migration.mjs <envファイル> --confirm-delete");
  process.exit(1);
}
const url = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];
const host = new URL(url).host;

const c = new pg.Client({ connectionString: url });
await c.connect();

// 削除される件数を先に出す
const TABLES = ["deal_products", "meetings", "tasks", "documents", "ai_logs", "chat_messages",
  "roleplay_sessions", "goals", "deals", "product_plans", "products", "pipeline_stages", "lead_sources"];
console.log(`対象: ${host}\n削除される件数:`);
let total = 0;
for (const t of TABLES) {
  const n = (await c.query(`select count(*)::int n from ${t} where tenant_id=$1`, [REAGEY])).rows[0].n;
  if (n) console.log(`  ${t.padEnd(20)} ${n}`);
  total += n;
}
const comp = (await c.query(`select count(*)::int n from companies where created_by_tenant_id=$1`, [REAGEY])).rows[0].n;
const cont = (await c.query(
  `select count(*)::int n from contacts ct join companies co on co.id=ct.company_id where co.created_by_tenant_id=$1`,
  [REAGEY])).rows[0].n;
const ut = (await c.query(`select count(*)::int n from user_tenants where tenant_id=$1`, [REAGEY])).rows[0].n;
console.log(`  companies（リージー起票） ${comp}`);
console.log(`  contacts（その企業配下）  ${cont}`);
console.log(`  user_tenants（リージー所属） ${ut}`);

// Luma のデータが巻き込まれないことを確認
const lumaDeals = (await c.query(`select count(*)::int n from deals where tenant_id=$1`, [LUMA])).rows[0].n;
console.log(`\n（Luma の商談 ${lumaDeals} 件には触れない）`);

if (!CONFIRMED) {
  console.log("\n--confirm-delete が無いため実行しない");
  await c.end();
  process.exit(0);
}

await c.query("BEGIN");
try {
  // 子から順に削除
  for (const t of TABLES) {
    await c.query(`delete from ${t} where tenant_id=$1`, [REAGEY]);
  }
  // リージー起票の企業と、その配下の連絡先
  await c.query(
    `delete from contacts where company_id in (select id from companies where created_by_tenant_id=$1)`, [REAGEY]);
  await c.query(`delete from companies where created_by_tenant_id=$1`, [REAGEY]);
  // 既存企業に寄せた分の連絡先は、リージー側の id と一致するものを消す
  const srcC = new pg.Client({ connectionString: srcUrl });
  await srcC.connect();
  const srcContactIds = (await srcC.query(`select id from contacts`)).rows.map((r) => r.id);
  await srcC.end();
  if (srcContactIds.length) {
    await c.query(`delete from contacts where id = any($1)`, [srcContactIds]);
  }
  await c.query(`delete from user_tenants where tenant_id=$1`, [REAGEY]);
  await c.query("COMMIT");
  console.log("\n削除しました（合計 " + (total + comp + cont + ut) + " 行）");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("失敗（巻き戻しました）:", e.message);
  process.exitCode = 1;
}
await c.end();
