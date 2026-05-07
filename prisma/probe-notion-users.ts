// Notion API でユーザー情報を取得する調査スクリプト
// .env の NOTION_API_KEY を使う
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const NOTION_API_KEY = process.env.NOTION_API_KEY;
if (!NOTION_API_KEY) {
  console.error("NOTION_API_KEY missing");
  process.exit(1);
}

type NotionUser = {
  object: string;
  id: string;
  type?: string;
  name?: string;
  avatar_url?: string | null;
  person?: { email?: string };
  bot?: { workspace_name?: string; owner?: unknown };
};

async function fetchNotionUser(id: string): Promise<NotionUser | null> {
  const r = await fetch(`https://api.notion.com/v1/users/${id}`, {
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!r.ok) {
    console.error(`fetch ${id} failed: ${r.status} ${await r.text()}`);
    return null;
  }
  return (await r.json()) as NotionUser;
}

async function main() {
  if (!process.env.DATABASE_URL?.includes("salesagent_luma")) throw new Error("DB safety");
  const ids: Array<{ aid: string; cnt: bigint }> = await prisma.$queryRawUnsafe(
    `SELECT jsonb_array_elements_text(bant->'notionAssigneeIds') AS aid, COUNT(*)::bigint AS cnt
     FROM deals WHERE deleted_at IS NULL AND bant ? 'notionAssigneeIds' AND jsonb_typeof(bant->'notionAssigneeIds')='array'
     GROUP BY aid ORDER BY cnt DESC`
  );
  console.log(`unique notion ids: ${ids.length}`);
  for (const r of ids) {
    const u = await fetchNotionUser(r.aid);
    if (!u) {
      console.log(`${r.aid} | ${r.cnt} deals | (fetch failed)`);
      continue;
    }
    const email = u.person?.email ?? null;
    const type = u.type ?? "?";
    const name = u.name ?? "?";
    console.log(`${r.aid} | ${r.cnt} deals | type=${type} | name=${name} | email=${email ?? "(no email - maybe bot or guest)"}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
