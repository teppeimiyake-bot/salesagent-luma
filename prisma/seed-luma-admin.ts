/**
 * Luma版 一時管理者投入スクリプト
 *
 * 社長（三宅哲平）が社内編集確認のため、最初の admin ユーザーを1件だけ投入する。
 * Lumaの本物の社員リスト（Notion経由）が届いたら、別スクリプトで再投入予定。
 *
 * 実行：
 *   PATH="/c/dev/node-v22.12.0-win-x64:$PATH" \
 *     npx tsx prisma/seed-luma-admin.ts
 *
 * 既存データは upsert で保護（同 email があれば permission=admin に更新するだけ）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_luma")) {
  throw new Error(
    `[safety] DATABASE_URL does not point to salesagent_luma. Got: ${connectionString}`,
  );
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log("[seed-luma-admin] start");
  console.log(`[seed-luma-admin] DB: ${connectionString}`);

  const email = "teppei@luma-create.com";
  const rawPassword = "Luma2026!";
  const passwordHash = await bcrypt.hash(rawPassword, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name: "三宅哲平",
      role: "manager",
      permission: "admin",
      passwordHash,
    },
    create: {
      email,
      name: "三宅哲平",
      role: "manager",
      permission: "admin",
      passwordHash,
      avatarColor: "#6366f1",
    },
  });

  console.log("");
  console.log("[seed-luma-admin] done");
  console.log(`  id:         ${user.id}`);
  console.log(`  email:      ${user.email}`);
  console.log(`  name:       ${user.name}`);
  console.log(`  role:       ${user.role}`);
  console.log(`  permission: ${user.permission}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
