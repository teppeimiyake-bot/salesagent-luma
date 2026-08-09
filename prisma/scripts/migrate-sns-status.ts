/**
 * SNSステータスを「契約中 / 解約」の2択へ移行する。
 *
 *   dry-run: npx tsx prisma/scripts/migrate-sns-status.ts [--prod|--staging]
 *   反映   : 上記に --apply を付ける
 *
 * やること：
 *  1. enum ProductionStatus に CONTRACTED / CANCELLED を追加（既にあればスキップ）
 *  2. category='SNS' の案件を CONTRACTED（契約中）へ寄せる。
 *     SNS案件は制作進行の段階（撮影前/編集中…）を持たず、既存値は初期値の
 *     BEFORE_SHOOT のままなので、稼働中を意味する「契約中」を既定とする。
 *     解約済みのものは画面から個別に切り替える運用。
 *
 * ALTER TYPE ... ADD VALUE はトランザクション内で実行できないため、pg で直接流す。
 */
import { Pool } from "pg";
import * as dotenv from "dotenv";

const APPLY = process.argv.includes("--apply");
const PROD = process.argv.includes("--prod");
const STAGING = process.argv.includes("--staging");

dotenv.config({
  path: PROD ? ".env.production.local" : STAGING ? ".env.staging" : ".env",
  override: true,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const NEW_VALUES = ["CONTRACTED", "CANCELLED"];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const expected = PROD ? "ep-round-band-aoj5sgyq" : STAGING ? "ep-wispy-sun-ao9ahi1c" : "salesagent_luma";
  if (!url.includes(expected)) {
    throw new Error(`想定外のDBに接続しています（期待: ${expected}）`);
  }
  console.log(`接続先: ${PROD ? "本番 Neon" : STAGING ? "ステージング" : "ローカル"}`);

  const existing = await pool.query<{ enumlabel: string }>(
    `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ProductionStatus' ORDER BY e.enumsortorder`,
  );
  const labels = existing.rows.map((r) => r.enumlabel);
  console.log(`現在の enum: ${labels.join(", ")}`);
  const missing = NEW_VALUES.filter((v) => !labels.includes(v));
  console.log(`追加が必要な値: ${missing.length ? missing.join(", ") : "なし"}`);

  const sns = await pool.query<{ status: string; n: string }>(
    `SELECT status::text AS status, count(*)::text AS n
       FROM production_projects WHERE category = 'SNS' GROUP BY status ORDER BY 2 DESC`,
  );
  console.log("SNS案件の現在のステータス分布:");
  for (const r of sns.rows) console.log(`  ${r.status}: ${r.n}`);

  const toMigrate = sns.rows
    .filter((r) => !NEW_VALUES.includes(r.status))
    .reduce((a, r) => a + Number(r.n), 0);
  console.log(`CONTRACTED へ寄せる件数: ${toMigrate}`);

  if (!APPLY) {
    console.log("\n*** dry-run です。反映するには --apply を付けてください。 ***");
    return;
  }

  for (const v of missing) {
    await pool.query(`ALTER TYPE "ProductionStatus" ADD VALUE IF NOT EXISTS '${v}'`);
    console.log(`enum に ${v} を追加しました`);
  }

  if (toMigrate > 0) {
    const r = await pool.query(
      `UPDATE production_projects SET status = 'CONTRACTED', updated_at = now()
        WHERE category = 'SNS' AND status::text NOT IN ('CONTRACTED','CANCELLED')`,
    );
    console.log(`SNS案件 ${r.rowCount} 件を CONTRACTED に更新しました`);
  }

  const after = await pool.query<{ category: string; status: string; n: string }>(
    `SELECT coalesce(category,'(未分類)') AS category, status::text AS status, count(*)::text AS n
       FROM production_projects GROUP BY 1,2 ORDER BY 1,3 DESC`,
  );
  console.log("=== 反映後 ===");
  for (const r of after.rows) console.log(`  ${r.category} / ${r.status}: ${r.n}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
