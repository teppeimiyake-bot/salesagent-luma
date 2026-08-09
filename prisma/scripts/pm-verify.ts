/** 反映結果の確認。npx tsx prisma/scripts/pm-verify.ts [--prod] */
import { Pool } from "pg";
import * as dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
dotenv.config({ path: PROD ? ".env.production.local" : ".env", override: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const dist = await pool.query(
    `SELECT status::text AS status, count(*)::int AS n FROM production_projects GROUP BY status ORDER BY 2 DESC`,
  );
  console.log(`=== ${PROD ? "本番" : "ローカル"} ステータス分布 ===`);
  console.table(dist.rows);

  const live = await pool.query(
    `SELECT project_name, status::text AS status, delivered,
            to_char(delivery_date,'YYYY-MM-DD') AS delivery,
            director_name, camera_name, editor_name
       FROM production_projects
      WHERE status <> 'DELIVERED' AND delivery_date IS NOT NULL
      ORDER BY delivery_date DESC LIMIT 20`,
  );
  console.log("=== 進行中案件（納品済み以外・日付あり） ===");
  console.table(live.rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
