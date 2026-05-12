/**
 * 修復対象 3 件の meeting.strategy 値を JSON ファイルにバックアップする。
 * 実行後に scripts/.backup/meetings-strategy-backup-<timestamp>.json が生成される。
 * このファイルは git ignore（scripts/.backup/）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const TARGETS = [
  "f05d4a43-7ff7-45df-86e2-cd3716f2f84f",
  "f1cf1c45-71aa-45a1-8bd5-b63060429d50",
  "4d2c4109-8d37-4a04-9d6a-9c3eb26036b4",
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const rows = await prisma.meeting.findMany({
      where: { id: { in: TARGETS } },
      select: { id: true, dealId: true, strategy: true, topSales: true, nextActions: true },
    });
    const dir = join(process.cwd(), "scripts", ".backup");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `meetings-strategy-backup-${ts}.json`);
    writeFileSync(path, JSON.stringify(rows, null, 2), "utf-8");
    console.log(`Backed up ${rows.length} meetings to ${path}`);
    if (rows.length !== TARGETS.length) {
      console.warn(`WARN: expected ${TARGETS.length} but got ${rows.length}`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
