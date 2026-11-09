/**
 * 企画書があり SNS にヨミが入っている Luma 案件に、縦型ショート動画の企画提案を補完する。
 *
 * 確認: npx tsx --env-file=.env.production.local scripts/backfill-sns-short-plan-proposals.ts
 * 実行: npx tsx --env-file=.env.production.local scripts/backfill-sns-short-plan-proposals.ts --apply
 */
import pg from "pg";
import { LUMA_TENANT_ID } from "../prisma/tenant-ids";

const proposalName = "【SNS】縦型ショート動画";
const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString });

// 案件内の別プロダクトに既に登録済みなら補完しない。映像があれば映像、なければ SNS に付ける。
const candidatesSql = `
WITH eligible AS (
  SELECT DISTINCT sns.deal_id
  FROM deal_products sns
  JOIN deals d ON d.id = sns.deal_id AND d.tenant_id = sns.tenant_id
  WHERE sns.tenant_id = $1
    AND d.deleted_at IS NULL
    AND sns.product_name = 'SNS'
    AND NULLIF(BTRIM(sns.yomi_status), '') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM documents doc
      WHERE doc.tenant_id = sns.tenant_id AND doc.deal_id = sns.deal_id
        AND doc.scope = 'deal' AND doc.category = 'proposal'
    )
    AND NOT EXISTS (
      SELECT 1 FROM deal_products existing
      WHERE existing.tenant_id = sns.tenant_id AND existing.deal_id = sns.deal_id
        AND $2 = ANY(existing.plan_proposals)
    )
), targets AS (
  SELECT DISTINCT ON (p.deal_id) p.id, p.deal_id, p.product_name
  FROM deal_products p
  JOIN eligible e ON e.deal_id = p.deal_id
  WHERE p.tenant_id = $1 AND p.product_name IN ('映像', 'SNS')
  ORDER BY p.deal_id,
    CASE WHEN p.product_name = '映像' THEN 0 ELSE 1 END,
    p.created_at, p.id
)
`;

async function main() {
  const client = await pool.connect();
  try {
    const master = await client.query(
      "SELECT active FROM plan_proposals WHERE tenant_id = $1 AND name = $2",
      [LUMA_TENANT_ID, proposalName],
    );
    if (master.rows.length !== 1 || !master.rows[0].active) {
      throw new Error(`Active proposal master is missing: ${proposalName}`);
    }

    const candidates = await client.query(
      `${candidatesSql} SELECT t.id, t.deal_id, t.product_name, c.name AS company
       FROM targets t JOIN deals d ON d.id = t.deal_id
       JOIN companies c ON c.id = d.company_id
       ORDER BY c.name, t.id`,
      [LUMA_TENANT_ID, proposalName],
    );
    console.log(`追加対象: ${candidates.rowCount} 件（${apply ? "実行" : "確認のみ"}）`);
    for (const row of candidates.rows) console.log(`${row.company} / ${row.product_name} / ${row.id}`);
    if (!apply) return;

    await client.query("BEGIN");
    try {
      const updated = await client.query(
        `${candidatesSql}
         UPDATE deal_products p
         SET plan_proposals = ARRAY_APPEND(p.plan_proposals, $2), updated_at = NOW()
         FROM targets t
         WHERE p.id = t.id AND p.tenant_id = $1
           AND NOT ($2 = ANY(p.plan_proposals))
         RETURNING p.id`,
        [LUMA_TENANT_ID, proposalName],
      );
      if (updated.rowCount !== candidates.rowCount) {
        throw new Error(`対象件数が変わりました: expected ${candidates.rowCount}, updated ${updated.rowCount}`);
      }
      await client.query("COMMIT");
      console.log(`登録完了: ${updated.rowCount} 件`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
