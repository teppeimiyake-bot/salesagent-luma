import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) {
    throw new Error(`SAFETY: DATABASE_URL must contain 'salesagent_luma'. Got: ${process.env.DATABASE_URL}`);
  }
  const stages = await prisma.pipelineStage.findMany({ orderBy: [{ group: "asc" }, { sortOrder: "asc" }] });
  console.log("=== pipeline_stages ===");
  for (const s of stages) console.log(`[${s.group}] ${s.value} | ${s.label} | active=${s.active}`);

  const dealStatuses = await prisma.deal.groupBy({ by: ["status"], _count: { _all: true } });
  console.log("\n=== deal status counts ===");
  for (const d of dealStatuses) console.log(`${d.status}: ${d._count._all}`);

  const stageRows: Array<{ pipeline_stage: string | null; cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT pipeline_stage, COUNT(*)::bigint AS cnt FROM deals WHERE deleted_at IS NULL GROUP BY pipeline_stage ORDER BY cnt DESC`
  );
  console.log("\n=== deal pipeline_stage counts ===");
  for (const r of stageRows) console.log(`${r.pipeline_stage ?? "(null)"}: ${r.cnt}`);

  const ngCount: Array<{ cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS cnt FROM deals WHERE deleted_at IS NULL AND (bant->>'isNG')='true'`
  );
  console.log(`\nbant.isNG=true count: ${ngCount[0].cnt}`);

  const taskCount = await prisma.task.count();
  console.log(`tasks total: ${taskCount}`);
  const tasksOnNG: Array<{ cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS cnt FROM tasks t JOIN deals d ON d.id = t.deal_id WHERE (d.bant->>'isNG')='true'`
  );
  console.log(`tasks attached to bant.isNG deals: ${tasksOnNG[0].cnt}`);

  const ids: Array<{ aid: string; cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT jsonb_array_elements_text(bant->'notionAssigneeIds') AS aid, COUNT(*)::bigint AS cnt
     FROM deals WHERE deleted_at IS NULL AND bant ? 'notionAssigneeIds' AND jsonb_typeof(bant->'notionAssigneeIds')='array'
     GROUP BY aid ORDER BY cnt DESC`
  );
  console.log("\n=== unique notion assignee ids in deals.bant.notionAssigneeIds ===");
  for (const r of ids) console.log(`${r.aid}: ${r.cnt} deals`);

  const dealsWithoutAssignee: Array<{ cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::bigint AS cnt FROM deals WHERE deleted_at IS NULL AND (
       NOT (bant ? 'notionAssigneeIds') OR jsonb_array_length(bant->'notionAssigneeIds')=0
     )`
  );
  console.log(`\ndeals without notionAssigneeIds (will stay as teppei): ${dealsWithoutAssignee[0].cnt}`);

  const ownerRows: Array<{ owner_user_id: string | null; email: string | null; name: string | null; cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT d.owner_user_id, u.email, u.name, COUNT(*)::bigint AS cnt
     FROM deals d LEFT JOIN users u ON u.id = d.owner_user_id
     WHERE d.deleted_at IS NULL GROUP BY d.owner_user_id, u.email, u.name ORDER BY cnt DESC`
  );
  console.log("\n=== current owner distribution ===");
  for (const r of ownerRows) console.log(`${r.email ?? r.owner_user_id ?? "(null)"} (${r.name ?? "?"}): ${r.cnt}`);

  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, permission: true } });
  console.log("\n=== existing users ===");
  for (const u of users) console.log(`${u.email} | ${u.name} | role=${u.role} perm=${u.permission} | ${u.id}`);

  // contacts email stats
  const ctEmail: Array<{ has_email: boolean; cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT (email IS NOT NULL AND email <> '') AS has_email, COUNT(*)::bigint AS cnt FROM contacts GROUP BY has_email`
  );
  console.log("\n=== contacts email coverage ===");
  for (const r of ctEmail) console.log(`has_email=${r.has_email}: ${r.cnt}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
