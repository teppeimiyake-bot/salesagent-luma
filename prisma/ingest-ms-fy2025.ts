/**
 * MS送付状況（/ms-outreach）への FY2025 全ワーカー＋週次実績 一括投入。
 *
 * データソース: 社長スプレッドシート「ms表」をオーケストレーターがパース済みの
 *   C:\tmp_ms_parse\ms_data.json （全23名 / 週次393件）。
 *
 * 仕様:
 * - safety check: DATABASE_URL が salesagent_luma & localhost を指していない場合 throw（本番Neon誤爆防止）。
 * - 冪等: ワーカーは code（あれば）/ name（code=null）で upsert、週次は
 *   unique [workerId, year, month, weekOfMonth] で upsert。何度流しても件数は増えない。
 * - 会計年度: MsWeeklyEntry に fiscalYear 列は無い。FY は year/month から
 *   lib/config の getFiscalYear() で集計時に算出される（6〜12月=2025 / 1〜5月=2026 → 全て FY2025）。
 *   この script では年月をそのまま保存するだけで、FY2025 に正しく束ねられる。
 *
 * JSON フィールド → DB カラムのマッピング:
 *   sendCount         -> sent
 *   apptCount         -> appointments
 *   listOrderCount    -> listOrders
 *   inquiryOrderCount -> inquiryOrders
 *   weekInMonth       -> weekOfMonth
 *
 * 実行: npx tsx prisma/ingest-ms-fy2025.ts
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { getFiscalYear } from "../src/lib/config";

const DATA_PATH = "C:\\tmp_ms_parse\\ms_data.json";

type Entry = {
  year: number;
  month: number;
  weekInMonth: number;
  sendCount: number;
  apptCount: number;
  listOrderCount: number;
  inquiryOrderCount: number;
};
type Worker = {
  code: string | null;
  name: string;
  sortOrder: number;
  labelCheck?: string;
  entryCount?: number;
  entries: Entry[];
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const masked = dbUrl.replace(/:[^:@]*@/, ":***@");
  const allowProd = process.env.SEED_ALLOW_PROD === "1";

  if (!dbUrl) {
    throw new Error("安全装置: DATABASE_URL が未設定です。");
  }

  if (allowProd) {
    // 本番(Neon)投入を明示許可。localhost / salesagent_luma ガードは外すが、
    // 「明らかにNeon(=本番)」であることだけは確認してから流す（事故った時に気付けるように）。
    const looksLikeNeon = dbUrl.includes("neon.tech") || dbUrl.includes("neondb");
    console.log("⚠️  SEED_ALLOW_PROD=1: 本番DBへの投入モードです。");
    console.log(`   DB target: ${masked}`);
    console.log(`   neon判定: ${looksLikeNeon ? "Neon(本番)とみなす" : "非Neon"}（冪等upsertのみ・additive）`);
  } else {
    // 既定はローカル開発DB限定（誤って本番に流さないための二重ガード）。
    if (!dbUrl.includes("salesagent_luma")) {
      throw new Error(`安全装置: DATABASE_URL が salesagent_luma を指していません（誤投入防止）。本番投入なら SEED_ALLOW_PROD=1。url=${masked}`);
    }
    if (!dbUrl.includes("localhost") && !dbUrl.includes("127.0.0.1")) {
      throw new Error(`安全装置: DATABASE_URL が localhost ではありません（本番Neon誤爆防止）。本番投入なら SEED_ALLOW_PROD=1。url=${masked}`);
    }
    console.log(`DB target OK (local): ${masked}`);
  }

  const workers: Worker[] = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  console.log(`source: ${DATA_PATH} -> workers=${workers.length}, entries=${workers.reduce((a, w) => a + w.entries.length, 0)}`);

  let workerCreated = 0;
  let workerUpdated = 0;
  let entryUpserted = 0;
  const fySet = new Set<number>();

  for (const w of workers) {
    // ---- ワーカー upsert ----
    // code があれば code で照合、null なら name で照合。
    let workerId: string;
    const existing = w.code
      ? await prisma.msWorker.findFirst({ where: { code: w.code } })
      : await prisma.msWorker.findFirst({ where: { code: null, name: w.name } });

    if (existing) {
      const updated = await prisma.msWorker.update({
        where: { id: existing.id },
        data: { name: w.name, code: w.code, sortOrder: w.sortOrder, active: true, isAgency: false },
      });
      workerId = updated.id;
      workerUpdated++;
      console.log(`worker updated: [${w.code ?? "----"}] ${w.name} (sort=${w.sortOrder})`);
    } else {
      const created = await prisma.msWorker.create({
        data: { name: w.name, code: w.code, sortOrder: w.sortOrder, active: true, isAgency: false },
      });
      workerId = created.id;
      workerCreated++;
      console.log(`worker created: [${w.code ?? "----"}] ${w.name} (sort=${w.sortOrder})`);
    }

    // ---- 週次実績 upsert ----
    for (const e of w.entries) {
      fySet.add(getFiscalYear(new Date(Date.UTC(e.year, e.month - 1, 1))));
      await prisma.msWeeklyEntry.upsert({
        where: {
          workerId_year_month_weekOfMonth: {
            workerId,
            year: e.year,
            month: e.month,
            weekOfMonth: e.weekInMonth,
          },
        },
        create: {
          workerId,
          year: e.year,
          month: e.month,
          weekOfMonth: e.weekInMonth,
          sent: e.sendCount,
          appointments: e.apptCount,
          listOrders: e.listOrderCount,
          inquiryOrders: e.inquiryOrderCount,
        },
        update: {
          sent: e.sendCount,
          appointments: e.apptCount,
          listOrders: e.listOrderCount,
          inquiryOrders: e.inquiryOrderCount,
        },
      });
      entryUpserted++;
    }
  }

  console.log("\n==== summary ====");
  console.log(`worker created=${workerCreated}, updated=${workerUpdated}`);
  console.log(`weekly entries upserted=${entryUpserted}`);
  console.log(`fiscal years touched (computed via getFiscalYear): ${[...fySet].sort().join(", ")}`);

  const totalWorkers = await prisma.msWorker.count();
  const totalEntries = await prisma.msWeeklyEntry.count();
  console.log(`\nDB totals now: MsWorker=${totalWorkers}, MsWeeklyEntry=${totalEntries}`);

  // year/month 分布の検算（全件 FY2025 に束ねられるか）
  const grouped = await prisma.msWeeklyEntry.groupBy({
    by: ["year"],
    _count: { _all: true },
  });
  console.log("entries by calendar year:", JSON.stringify(grouped.map((g) => ({ year: g.year, count: g._count._all }))));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
