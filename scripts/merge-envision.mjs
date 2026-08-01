/**
 * 「株式会社エンビジョン」の重複2件を統合する
 * ============================================================
 * 社名もHP（envision-inc.jp）も完全一致の重複。実績を持つ古いほうに寄せる。
 *
 * 本来は管理画面（/admin/company-merges）から実行するのが筋だが、
 * 本番の JWT_SECRET が Sensitive 設定で取得できず API を叩けないため、
 * src/app/api/admin/company-merges/route.ts と同じ処理をここで再現する。
 * 復元用スナップショットも同じ形で作るので、画面から取り消せる。
 *
 * 商談・連絡先の付け替えはテナント境界を通さない（企業マスタは2社共有のため。
 * 通常の prisma を使うと片方の会社の商談だけが付け替わる）。
 *
 * 実行:
 *   node scripts/merge-envision.mjs .env.staging --dry-run   # リハーサル
 *   node scripts/merge-envision.mjs .env.staging             # テストブランチで実行
 *   node scripts/merge-envision.mjs .env.production.local    # 本番
 */
import fs from "node:fs";
import pg from "pg";

const envFile = process.argv[2] ?? ".env.staging";
const DRY = process.argv.includes("--dry-run");
const TARGET_NAME = "株式会社エンビジョン";

const dbUrl = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)/m)[1];
const host = new URL(dbUrl).host;

// API の FILLABLE_FIELDS と同じ（surviving が空なら merged の値で補完する）
const FILLABLE = [
  ["industry", "industry"], ["website_url", "websiteUrl"], ["website_summary", "websiteSummary"],
  ["website_fetched_at", "websiteFetchedAt"], ["note", "note"], ["address", "address"],
  ["ceo_name", "ceoName"], ["established_year", "establishedYear"],
  ["employee_count", "employeeCount"], ["capital", "capital"],
  ["phone_number", "phoneNumber"], ["logo_color", "logoColor"], ["logo_url", "logoUrl"],
];
const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const c = new pg.Client({ connectionString: dbUrl });
await c.connect();
console.log(`接続先: ${host}${DRY ? "（dry-run）" : ""}\n`);

const rows = (await c.query(`
  select co.*,
    (select count(*)::int from deals d where d.company_id=co.id and d.deleted_at is null) deal_n,
    (select count(*)::int from contacts ct where ct.company_id=co.id) contact_n
  from companies co
  where co.name = $1 and co.deleted_at is null and co.merged_into_id is null
  order by co.created_at`, [TARGET_NAME])).rows;

if (rows.length !== 2) {
  console.log(`対象が ${rows.length} 件のため中止（重複2件を想定）`);
  await c.end();
  process.exit(rows.length < 2 ? 0 : 1);
}

const surviving = rows[0]; // 古い＝実績を持つほう
const merged = rows[1];
console.log(`残す  : ${surviving.name} (${surviving.id.slice(0, 8)}… 商談${surviving.deal_n} 連絡先${surviving.contact_n})`);
console.log(`統合元: ${merged.name} (${merged.id.slice(0, 8)}… 商談${merged.deal_n} 連絡先${merged.contact_n})`);

const boss = (await c.query(`select id from users where email='teppei.miyake@luma-create.com'`)).rows[0];

if (DRY) {
  const patch = FILLABLE.filter(([col]) => isEmpty(surviving[col]) && !isEmpty(merged[col])).map(([, f]) => f);
  console.log(`\n付け替える商談 ${merged.deal_n} 件 / 連絡先 ${merged.contact_n} 件`);
  console.log(`補完するフィールド: ${patch.length ? patch.join(", ") : "なし"}`);
  console.log("\n--dry-run のため実行しない");
  await c.end();
  process.exit(0);
}

try {
  await c.query("BEGIN");

  // 付け替える id を控える（復元用スナップショットに残す）
  const contactIds = (await c.query(`select id from contacts where company_id=$1`, [merged.id])).rows.map((r) => r.id);
  // テナントで絞らない：両社の商談をまとめて付け替える
  const dealIds = (await c.query(`select id from deals where company_id=$1`, [merged.id])).rows.map((r) => r.id);

  if (contactIds.length) await c.query(`update contacts set company_id=$1 where company_id=$2`, [surviving.id, merged.id]);
  if (dealIds.length) await c.query(`update deals set company_id=$1 where company_id=$2`, [surviving.id, merged.id]);

  // surviving の空フィールドを merged の値で補完
  const filled = {};
  const sets = [];
  const vals = [];
  for (const [col, field] of FILLABLE) {
    if (isEmpty(surviving[col]) && !isEmpty(merged[col])) {
      vals.push(merged[col]);
      sets.push(`${col} = $${vals.length}`);
      filled[field] = merged[col];
    }
  }
  if (sets.length) {
    vals.push(surviving.id);
    await c.query(`update companies set ${sets.join(", ")} where id = $${vals.length}`, vals);
  }

  // 復元用スナップショット（API と同じ形）
  const snapshotCompany = { ...merged };
  delete snapshotCompany.deal_n;
  delete snapshotCompany.contact_n;
  await c.query(
    `insert into company_merges (id, surviving_company_id, merged_company_id, snapshot, performed_by_user_id, performed_at)
     values (gen_random_uuid()::text, $1, $2, $3, $4, now())`,
    [surviving.id, merged.id, JSON.stringify({
      mergedCompany: snapshotCompany,
      movedContactIds: contactIds,
      movedDealIds: dealIds,
      survivingFieldsFilled: filled,
    }), boss?.id ?? null],
  );

  // 統合元をアーカイブ
  await c.query(`update companies set deleted_at = now(), merged_into_id = $1 where id = $2`, [surviving.id, merged.id]);

  await c.query("COMMIT");
  console.log("\n統合しました");
  console.log(`  付け替え: 商談 ${dealIds.length} 件 / 連絡先 ${contactIds.length} 件`);
  console.log(`  補完したフィールド: ${Object.keys(filled).length ? Object.keys(filled).join(", ") : "なし"}`);
} catch (e) {
  await c.query("ROLLBACK");
  console.error("失敗（巻き戻しました）:", e.message);
  await c.end();
  process.exit(1);
}

// 結果確認
const after = (await c.query(`
  select co.name, co.merged_into_id,
    (select count(*)::int from deals d where d.company_id=co.id and d.deleted_at is null) deal_n,
    (select count(*)::int from contacts ct where ct.company_id=co.id) contact_n
  from companies co where co.id = any($1)`, [[surviving.id, merged.id]])).rows;
console.log("\n統合後:");
after.forEach((r) => console.log(`  ${r.name} … 商談${r.deal_n} 連絡先${r.contact_n} ${r.merged_into_id ? "→ アーカイブ済み" : "← 残存"}`));
const snap = (await c.query(`select count(*)::int n from company_merges where merged_company_id=$1 and undone_at is null`, [merged.id])).rows[0].n;
console.log(`  復元用スナップショット: ${snap === 1 ? "あり ✓（管理画面から取り消せる）" : "なし ✗"}`);
await c.end();
