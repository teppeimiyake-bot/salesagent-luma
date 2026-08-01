/**
 * Luma版seed：箱だけ初期投入（LeadSource 6件＋PipelineStage 14件のみ）
 *
 * 実顧客データ・社員データ・商材マスタは投入しない。
 * 社長から Notion 経由で実データが届いたタイミングで、
 * このスクリプトを拡張するか、新しいスクリプトを切る。
 *
 * 実行：
 *   PATH="/c/dev/node-v22.12.0-win-x64:$PATH" \
 *     npx tsx prisma/seed-luma.ts
 *
 * 既存データは upsert で保護（同名があればフィールドを更新するだけ）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { DEFAULT_LEAD_SOURCES } from "../src/lib/lead-source";
import { LUMA_TENANT_ID } from "./tenant-ids";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_luma")) {
  throw new Error(
    `[safety] DATABASE_URL does not point to salesagent_luma. Got: ${connectionString}`,
  );
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ============================================================
// PipelineStage（リージー版と同じ汎用セット 14件）
// ============================================================
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
  console.log("[seed-luma] start");
  console.log(`[seed-luma] DB: ${connectionString}`);

  // ============================================================
  // LeadSource マスタ（6件）
  // ============================================================
  for (const ls of DEFAULT_LEAD_SOURCES) {
    await prisma.leadSource.upsert({
      where: { tenantId_name: { tenantId: LUMA_TENANT_ID, name: ls.name } },
      update: { sortOrder: ls.sortOrder, active: true },
      create: { name: ls.name, sortOrder: ls.sortOrder, active: true },
    });
    console.log(`  [leadSource] ${ls.name} (sortOrder=${ls.sortOrder})`);
  }

  // ============================================================
  // PipelineStage マスタ（14件）
  // ============================================================
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
    console.log(`  [pipelineStage] ${s.value}`);
  }

  console.log("");
  console.log("[seed-luma] done");
  console.log(`  LeadSources:    ${DEFAULT_LEAD_SOURCES.length}`);
  console.log(`  PipelineStages: ${STAGES.length}`);
  console.log("");
  console.log("  ※実顧客データ・社員データ・商材マスタは未投入。");
  console.log("    社長から Notion でデータ受領後に追加投入する。");
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
