/** 岩泉町役場が PM 一覧に出ない理由の調査。npx tsx prisma/scripts/probe-iwaizumi.ts --prod */
import { Pool } from "pg";
import * as dotenv from "dotenv";

const PROD = process.argv.includes("--prod");
dotenv.config({ path: PROD ? ".env.production.local" : ".env", override: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.query(
    `SELECT id, name FROM companies WHERE name LIKE '%岩泉%' OR name LIKE '%いわいずみ%'`,
  );
  console.log("companies:", c.rows);

  if (c.rowCount) {
    const ids = c.rows.map((r) => r.id);
    const d = await pool.query(
      `SELECT * FROM deals WHERE company_id = ANY($1::text[])`,
      [ids],
    );
    console.log("deals:", d.rows);
    if (d.rowCount) {
      const dp = await pool.query(
        `SELECT id, deal_id, product_name, yomi_status FROM deal_products WHERE deal_id = ANY($1::text[])`,
        [d.rows.map((r) => r.id)],
      );
      console.log("deal_products:", dp.rows);
    }
    const pp = await pool.query(
      `SELECT id, project_name, category, status::text FROM production_projects WHERE company_id = ANY($1::text[])`,
      [ids],
    );
    console.log("production_projects:", pp.rows);
  }

  // PM一覧に載る条件を確かめるため、ProductionProject がどう作られているか近い例も見る
  const s = await pool.query(`SELECT id, name, sort_order, is_won FROM pipeline_stages ORDER BY sort_order`);
  console.log("pipeline_stages:", s.rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
