/** ローカルDBとschema.prismaの差分ざっくり確認。npx tsx prisma/scripts/db-drift-check.ts */
import { Pool } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const t = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`,
  );
  const names = t.rows.map((r) => r.table_name);
  console.log(`テーブル数: ${names.length}`);
  console.log(names.join(", "));
  for (const n of ["tenants", "user_tenants"]) {
    console.log(`${n}: ${names.includes(n) ? "あり" : "無し"}`);
  }
  const withTenant = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1`,
  );
  console.log(`tenant_id を持つテーブル: ${withTenant.rowCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
