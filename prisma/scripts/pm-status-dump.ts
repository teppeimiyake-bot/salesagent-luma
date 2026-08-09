/**
 * PM案件（ProductionProject）の現状ダンプ。Notion「マスタ」との突き合わせ用。
 * 実行: npx tsx prisma/scripts/pm-status-dump.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const rows = await prisma.productionProject.findMany({
    select: {
      id: true,
      projectName: true,
      status: true,
      category: true,
      delivered: true,
      deliveryDate: true,
      shootDate: true,
      pmName: true,
      directorName: true,
      cameraName: true,
      editorName: true,
      company: { select: { name: true } },
    },
    orderBy: [{ deliveryDate: "desc" }],
  });

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  console.log("=== 件数:", rows.length);
  console.log("=== ステータス分布:", JSON.stringify(Object.fromEntries(byStatus), null, 2));
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        company: r.company?.name ?? null,
        project: r.projectName,
        category: r.category,
        status: r.status,
        delivered: r.delivered,
        delivery: r.deliveryDate?.toISOString().slice(0, 10) ?? null,
        shoot: r.shootDate?.toISOString().slice(0, 10) ?? null,
        pm: r.pmName,
        dir: r.directorName,
        cam: r.cameraName,
        edit: r.editorName,
      })),
      null,
      1,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
