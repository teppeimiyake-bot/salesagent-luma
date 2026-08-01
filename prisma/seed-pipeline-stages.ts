/**
 * PipelineStage 初期データ投入スクリプト。
 * src/lib/pipeline-stage.ts のハードコード PIPELINE_STAGES と同じ14件を upsert する。
 *
 * 実行：
 *   PATH="/c/dev/node-v22.12.0-win-x64:$PATH" npx tsx prisma/seed-pipeline-stages.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { LUMA_TENANT_ID } from "./tenant-ids";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const STAGES = [
  // 商談前
  { value: "【商談前】商談予定", group: "before", badgeBg: "bg-sky-100", badgeText: "text-sky-800", sortOrder: 10 },
  { value: "【商談前】日程調整不可", group: "before", badgeBg: "bg-zinc-200", badgeText: "text-zinc-700", sortOrder: 20 },
  { value: "【商談前】催促2回送信済", group: "before", badgeBg: "bg-amber-100", badgeText: "text-amber-800", sortOrder: 30 },
  // 商談後
  { value: "【商談後】追いかけ1回目", group: "after", badgeBg: "bg-emerald-50", badgeText: "text-emerald-700", sortOrder: 110 },
  { value: "【商談後】追いかけ2回目", group: "after", badgeBg: "bg-emerald-50", badgeText: "text-emerald-700", sortOrder: 120 },
  { value: "【商談後】追いかけ3回目", group: "after", badgeBg: "bg-emerald-100", badgeText: "text-emerald-800", sortOrder: 130 },
  { value: "【商談後】追いかけ4回目", group: "after", badgeBg: "bg-emerald-100", badgeText: "text-emerald-800", sortOrder: 140 },
  { value: "【商談後】追いかけ5回目", group: "after", badgeBg: "bg-emerald-200", badgeText: "text-emerald-900", sortOrder: 150 },
  { value: "【商談後】追いかけ6回目以上", group: "after", badgeBg: "bg-emerald-200", badgeText: "text-emerald-900", sortOrder: 160 },
  { value: "【商談後】稟議中", group: "after", badgeBg: "bg-teal-100", badgeText: "text-teal-800", sortOrder: 170 },
  { value: "【商談後】企画中", group: "after", badgeBg: "bg-teal-100", badgeText: "text-teal-800", sortOrder: 180 },
  { value: "【商談後】トスなし", group: "after", badgeBg: "bg-zinc-100", badgeText: "text-zinc-600", sortOrder: 190 },
  // 契約系
  { value: "契約書チェック中", group: "contract", badgeBg: "bg-orange-100", badgeText: "text-orange-800", sortOrder: 210 },
  { value: "契約書送付中（返送待ち）", group: "contract", badgeBg: "bg-green-100", badgeText: "text-green-800", sortOrder: 220 },
];

async function main() {
  console.log(`[seed-pipeline-stages] upserting ${STAGES.length} stages...`);
  for (const s of STAGES) {
    await prisma.pipelineStage.upsert({
      where: { tenantId_value: { tenantId: LUMA_TENANT_ID, value: s.value } },
      update: {
        label: s.value,
        group: s.group,
        badgeBg: s.badgeBg,
        badgeText: s.badgeText,
        sortOrder: s.sortOrder,
        active: true,
      },
      create: {
        value: s.value,
        label: s.value,
        group: s.group,
        badgeBg: s.badgeBg,
        badgeText: s.badgeText,
        sortOrder: s.sortOrder,
        active: true,
      },
    });
    console.log(`  ✓ ${s.value}`);
  }
  console.log("[seed-pipeline-stages] done");
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
