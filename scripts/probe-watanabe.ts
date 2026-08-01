/** 渡邊さんのユーザーレコード探索（読み取り専用・使い捨て） */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("[ERR] DATABASE_URL not set"); process.exit(1); }
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: ["error"] });
  try {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: "渡邊" } },
          { name: { contains: "渡辺" } },
          { email: { contains: "watanabe", mode: "insensitive" } },
          { email: { contains: "watanmabe", mode: "insensitive" } },
        ],
      },
      select: { id: true, email: true, name: true, role: true, permission: true },
    });
    console.log(`matched ${users.length} user(s):`);
    for (const u of users) {
      console.log(`  - id=${u.id} | email=${u.email} | name=${u.name} | role=${u.role} | perm=${u.permission}`);
    }
    if (users.length === 0) {
      console.log("--- no match; listing all users (id/email/name) ---");
      const all = await prisma.user.findMany({ select: { email: true, name: true }, orderBy: { name: "asc" } });
      for (const u of all) console.log(`  * ${u.name} <${u.email}>`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}
main().catch((e) => { console.error("[FATAL]", e); process.exit(99); });
