/**
 * MS送付状況（/ms-outreach）の初期ワーカーマスタ seed。
 * 社長のスプレッドシートに実在したワーカーを投入する（いずれも active / isAgency=false）。
 *
 * - safety check: DATABASE_URL が salesagent_luma を指していない場合は throw。
 * - 冪等: code をキーに upsert 相当（既存があればスキップ）。
 *
 * 実行: npx tsx prisma/seed-ms-outreach.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const INITIAL_WORKERS = [
  { code: "001", name: "フローラ三宮さん", sortOrder: 1 },
  { code: "002", name: "奥山さん", sortOrder: 2 },
  { code: "003", name: "crazy catsさん", sortOrder: 3 },
  { code: "004", name: "ちひろさん", sortOrder: 4 },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("salesagent_luma")) {
    throw new Error(
      `安全装置: DATABASE_URL が salesagent_luma を指していません（誤投入防止）。url=${dbUrl.replace(/:[^:@]*@/, ":***@")}`,
    );
  }

  for (const w of INITIAL_WORKERS) {
    // code で既存チェック（手動INSERT等で既にあれば飛ばす）
    const existing = await prisma.msWorker.findFirst({ where: { code: w.code } });
    if (existing) {
      console.log(`skip (exists): ${w.code} ${w.name}`);
      continue;
    }
    await prisma.msWorker.create({
      data: {
        code: w.code,
        name: w.name,
        isAgency: false,
        active: true,
        sortOrder: w.sortOrder,
      },
    });
    console.log(`created: ${w.code} ${w.name}`);
  }

  const total = await prisma.msWorker.count();
  console.log(`done. MsWorker total = ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
