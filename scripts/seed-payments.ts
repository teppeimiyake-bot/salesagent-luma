/**
 * 入金管理（機能5）の実データ投入シード。冪等。
 *   元データ: docs/payment-mgmt/入金管理_spot.csv（スポット）
 *            docs/payment-mgmt/入金管理_recurring.csv（定期）
 *
 * 実行: export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"; npx tsx scripts/seed-payments.ts
 *
 * 冪等性: sourceKey（顧客名＋金額＋日付などから生成した安定キー）で upsert。
 * 重複企業注意: companyId 紐付けは正規化名で「一意に1社へ絞れる時だけ」設定。
 *   複数候補・受注dealなしの曖昧マッチは紐付けず customerName のみ保持（後で手動FK）。
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断（他DB誤爆防止）。
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import {
  parsePaymentTiming,
  parseContractStatus,
  parseInvoiceSent,
  parsePaymentRecv,
  grossFromNet,
  ym,
} from "../src/lib/payments";
import { normalizeName } from "../src/lib/company-dedup";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ---------- minimal CSV parser（クオート対応） ----------
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (c === "\r") {
        /* skip */
      } else cur += c;
    }
  }
  if (cur !== "" || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// "¥654,040" / "641,500" / "" -> number | null
function parseYen(s: string | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[¥,\s]/g, "").trim();
  if (cleaned === "" || cleaned === "0") return cleaned === "0" ? 0 : null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// "2025/09/15" / "9/30" / "12/1" / "" -> Date | null（年省略は基準年で補完）
function parseDate(s: string | undefined, fallbackYear = 2025): Date | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "") return null;
  const parts = t.split(/[\/\-]/).map((x) => x.trim());
  let y: number, mo: number, d: number;
  if (parts.length === 3) {
    [y, mo, d] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  } else if (parts.length === 2) {
    // M/D（年省略）→ fallbackYear
    [mo, d] = [Number(parts[0]), Number(parts[1])];
    y = fallbackYear;
  } else return null;
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// 顧客名 -> companyId（正規化名が「ちょうど1社」に一致する時だけ紐付け）
async function resolveCompanyId(
  customerName: string,
  index: Map<string, string[]>,
): Promise<string | null> {
  const norm = normalizeName(customerName);
  if (!norm) return null;
  const ids = index.get(norm);
  if (ids && ids.length === 1) return ids[0];
  return null; // 0件 or 複数（曖昧）は紐付けない
}

async function buildCompanyIndex(): Promise<Map<string, string[]>> {
  const companies = await prisma.company.findMany({
    where: { deletedAt: null, mergedIntoId: null },
    select: { id: true, name: true },
  });
  const idx = new Map<string, string[]>();
  for (const c of companies) {
    const k = normalizeName(c.name);
    if (!k) continue;
    const arr = idx.get(k) ?? [];
    arr.push(c.id);
    idx.set(k, arr);
  }
  return idx;
}

async function seedSpot(companyIndex: Map<string, string[]>) {
  const file = path.join(process.cwd(), "docs/payment-mgmt/入金管理_spot.csv");
  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  const body = rows.slice(1); // header 1行
  let created = 0;
  // 同一顧客で複数行ある（JMAC 2件等）→ 行内連番で sourceKey を一意化
  const seenName = new Map<string, number>();

  for (const r of body) {
    const customerName = (r[0] ?? "").trim();
    if (!customerName) continue;
    const seq = (seenName.get(customerName) ?? 0) + 1;
    seenName.set(customerName, seq);

    const amountNet = parseYen(r[7]);
    const amountGrossRaw = parseYen(r[8]);
    // CSV原値を優先（端数の温存）。無ければ net×1.1。
    const amountGross = amountGrossRaw ?? grossFromNet(amountNet);

    const companyId = await resolveCompanyId(customerName, companyIndex);
    const sourceKey = `spot::${normalizeName(customerName)}::${seq}`;

    const data = {
      customerName,
      companyId,
      paymentTiming: parsePaymentTiming(r[1] ?? ""),
      contractStatus: parseContractStatus(r[2] ?? ""),
      invoiceStatus: parseInvoiceSent(r[3] ?? ""),
      paymentStatus: parsePaymentRecv(r[4] ?? ""),
      deliveryDate: parseDate(r[5]),
      expectedPaymentDate: parseDate(r[6]),
      amountNet,
      amountGross,
    };

    await prisma.invoiceRecord.upsert({
      where: { sourceKey },
      create: { ...data, sourceKey },
      update: data,
    });
    created++;
  }
  return created;
}

async function seedRecurring(companyIndex: Map<string, string[]>) {
  const file = path.join(process.cwd(), "docs/payment-mgmt/入金管理_recurring.csv");
  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  const body = rows.slice(1); // header 1行（空ヘッダ）
  let billings = 0;
  let periods = 0;

  for (const r of body) {
    const customerName = (r[0] ?? "").trim();
    if (!customerName) continue;

    const initialFee = parseYen(r[1]);
    const monthlyFee = parseYen(r[2]);
    const startDate = parseDate(r[3], 2025);
    const endDate = parseDate(r[4], 2026);
    const companyId = await resolveCompanyId(customerName, companyIndex);
    const sourceKey = `recurring::${normalizeName(customerName)}`;

    const billing = await prisma.recurringBilling.upsert({
      where: { sourceKey },
      create: { customerName, companyId, initialFee, monthlyFee, startDate, endDate, sourceKey },
      update: { customerName, companyId, initialFee, monthlyFee, startDate, endDate },
    });
    billings++;

    // 月次フラグ：5列目以降を (sent, paid) ペアで読む。
    // 各ペアを契約開始月から連番で対応付け（startDate無しは 2025/06 を origin に）。
    const flags = r.slice(5).map((x) => x.trim());
    const originDate = startDate ?? new Date(Date.UTC(2025, 5, 1)); // 2025/06
    let y = originDate.getUTCFullYear();
    let mo = originDate.getUTCMonth() + 1;

    // 先頭の空ペア（リード）はスキップして開始月に合わせる
    let started = false;
    for (let i = 0; i + 1 <= flags.length - 1; i += 2) {
      const a = flags[i];
      const b = flags[i + 1];
      const empty = a === "" && b === "";
      if (!started && empty) continue; // 開始前の空白セルは飛ばす
      started = true;
      if (empty) {
        // 契約期間中の空白＝未請求扱い。月だけ進める。
        mo++;
        if (mo > 12) {
          mo = 1;
          y++;
        }
        continue;
      }
      const sent = a === "TRUE";
      const paid = b === "TRUE";
      const yyyymm = ym(y, mo);
      await prisma.recurringBillingPeriod.upsert({
        where: { billingId_yearMonth: { billingId: billing.id, yearMonth: yyyymm } },
        create: { billingId: billing.id, yearMonth: yyyymm, sent, paid },
        update: { sent, paid },
      });
      periods++;
      mo++;
      if (mo > 12) {
        mo = 1;
        y++;
      }
    }
  }
  return { billings, periods };
}

async function main() {
  console.log("[seed-payments] companyIndex 構築中...");
  const companyIndex = await buildCompanyIndex();
  console.log(`[seed-payments] 企業 ${companyIndex.size} 正規化名`);

  const spot = await seedSpot(companyIndex);
  console.log(`[seed-payments] スポット: ${spot} 件 upsert`);

  const rec = await seedRecurring(companyIndex);
  console.log(`[seed-payments] 定期: ${rec.billings} 契約 / ${rec.periods} 月次セル upsert`);

  // 紐付け状況サマリ
  const linkedSpot = await prisma.invoiceRecord.count({ where: { companyId: { not: null } } });
  const totalSpot = await prisma.invoiceRecord.count();
  const linkedRec = await prisma.recurringBilling.count({ where: { companyId: { not: null } } });
  const totalRec = await prisma.recurringBilling.count();
  console.log(
    `[seed-payments] companyId 紐付け: スポット ${linkedSpot}/${totalSpot} / 定期 ${linkedRec}/${totalRec}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
