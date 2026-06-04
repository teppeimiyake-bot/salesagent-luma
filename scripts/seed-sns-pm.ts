/**
 * PM Phase3.5: SNS運用データ補完シード。冪等。
 *   元データ: docs/payment-mgmt/SNS運用管理.csv（12クライアント・うち1件はLuma社内）
 *
 * 会社名で既存の SNS ProductionProject（受注バックフィル済）にマッチし、
 *   - 総投稿本数 / 提供開始月 / 提供終了月 / 管理シートリンク を補完
 *   - SnsAccount（YouTube/Instagram/TikTok）を platform 単位で upsert
 * する。
 *
 * 実行:
 *   export PATH="/c/dev/node-v22.12.0-win-x64:$PATH"; npx tsx scripts/seed-sns-pm.ts
 *
 * 重複企業注意: companyId 経由で SNSプロジェクトが「ちょうど1件」に絞れる時だけ紐付け。
 *   0件/複数件（曖昧）は未マッチとしてログに出し、手動FK送り。
 *
 * SAFETY: DATABASE_URL に 'salesagent_luma' を含まない場合は中断。
 */
import { PrismaClient, type SnsPlatform } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import { normalizeName } from "../src/lib/company-dedup";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("salesagent_luma") && process.env.SEED_ALLOW_PROD !== "1") {
  throw new Error(
    `[SAFETY] DATABASE_URL が salesagent_luma を指していません: ${url.replace(/:[^:@]+@/, ":***@")}`,
  );
}

const pool = new Pool({ connectionString: url });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ---------- quote対応CSVパーサ（埋め込み改行に対応） ----------
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
  return rows;
}

// "2025/06/01" / "2026/1" -> Date | null（月初に丸める）
function parseMonth(s: string | undefined): Date | null {
  if (!s) return null;
  const t = s.trim();
  if (t === "") return null;
  const parts = t.split(/[\/\-]/).map((x) => Number(x.trim()));
  const [y, mo] = [parts[0], parts[1] ?? 1];
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
  const d = new Date(Date.UTC(y, mo - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanStr(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/\r?\n/g, " ").trim();
  if (t === "" || t === "#N/A") return null;
  return t;
}

const PLATFORM_MAP: Record<string, SnsPlatform> = {
  YouTube: "YOUTUBE",
  Instagram: "INSTAGRAM",
  TikTok: "TIKTOK",
};

type SnsClient = {
  companyName: string;
  planName: string | null;
  totalPosts: string | null;
  startMonth: Date | null;
  endMonth: Date | null;
  mgmtSheetUrl: string | null;
  accounts: {
    platform: SnsPlatform;
    accountId: string | null;
    password: string | null;
    profileUrl: string | null;
    miyakePcLogin: boolean;
  }[];
};

/** CSVを「会社ブロック」単位に集約。会社名(col0)が非空の行が新ブロックの開始。 */
function parseClients(rows: string[][]): SnsClient[] {
  const clients: SnsClient[] = [];
  let cur: SnsClient | null = null;

  for (const r of rows) {
    const company = (r[0] ?? "").trim();
    const platformRaw = (r[6] ?? "").trim();
    const platform = PLATFORM_MAP[platformRaw];

    // 会社名が新規に出たら新ブロック開始（テンプレ「マスタ：...」やヘッダは除外）
    if (company && !company.startsWith("マスタ") && company !== "会社名") {
      cur = {
        companyName: company,
        planName: cleanStr(r[1]),
        totalPosts: cleanStr(r[2]),
        startMonth: parseMonth(r[3]),
        endMonth: parseMonth(r[4]),
        mgmtSheetUrl: cleanStr(r[5]),
        accounts: [],
      };
      clients.push(cur);
    }

    if (cur && platform) {
      const accountId = cleanStr(r[7]);
      const password = cleanStr(r[8]);
      const profileUrl = cleanStr(r[9]);
      const miyakePcLogin = (r[10] ?? "").trim().toUpperCase() === "TRUE";
      // 全部空のアカウント行はスキップ（ただし三宅PCログインTRUEは保持）
      if (accountId || password || profileUrl || miyakePcLogin) {
        cur.accounts.push({ platform, accountId, password, profileUrl, miyakePcLogin });
      }
    }
  }
  return clients;
}

async function main() {
  const file = path.join(process.cwd(), "docs/payment-mgmt/SNS運用管理.csv");
  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  const clients = parseClients(rows);
  console.log(`[seed-sns-pm] CSVクライアント数=${clients.length}`);

  // companyId -> SNS ProductionProject の索引（category=SNS）
  const snsProjects = await prisma.productionProject.findMany({
    where: { category: "SNS" },
    select: { id: true, companyId: true, projectName: true },
  });
  const byCompany = new Map<string, { id: string; projectName: string }[]>();
  for (const p of snsProjects) {
    if (!p.companyId) continue;
    const arr = byCompany.get(p.companyId) ?? [];
    arr.push({ id: p.id, projectName: p.projectName });
    byCompany.set(p.companyId, arr);
  }

  // 会社名 -> companyId（正規化名・一意のみ）
  const companies = await prisma.company.findMany({
    where: { deletedAt: null, mergedIntoId: null },
    select: { id: true, name: true },
  });
  const normToIds = new Map<string, string[]>();
  for (const c of companies) {
    const k = normalizeName(c.name);
    if (!k) continue;
    const arr = normToIds.get(k) ?? [];
    arr.push(c.id);
    normToIds.set(k, arr);
  }

  const matched: string[] = [];
  const unmatched: { name: string; reason: string }[] = [];
  let updatedProjects = 0;
  let upsertedAccounts = 0;

  for (const cl of clients) {
    const norm = normalizeName(cl.companyName);
    const companyIds = normToIds.get(norm) ?? [];
    if (companyIds.length === 0) {
      unmatched.push({ name: cl.companyName, reason: "会社レコード無し" });
      continue;
    }
    if (companyIds.length > 1) {
      unmatched.push({ name: cl.companyName, reason: `会社が複数(${companyIds.length})・曖昧` });
      continue;
    }
    const companyId = companyIds[0];
    const projects = byCompany.get(companyId) ?? [];
    if (projects.length === 0) {
      unmatched.push({ name: cl.companyName, reason: "SNS ProductionProject 無し" });
      continue;
    }
    if (projects.length > 1) {
      unmatched.push({
        name: cl.companyName,
        reason: `SNSプロジェクトが複数(${projects.length})・曖昧`,
      });
      continue;
    }
    const projectId = projects[0].id;

    // プロジェクトに SNS 項目を補完（既存の手入力を消さないよう、値があるものだけ上書き）
    await prisma.productionProject.update({
      where: { id: projectId },
      data: {
        ...(cl.totalPosts ? { totalPosts: cl.totalPosts } : {}),
        ...(cl.startMonth ? { serviceStartMonth: cl.startMonth } : {}),
        ...(cl.endMonth ? { serviceEndMonth: cl.endMonth } : {}),
        ...(cl.mgmtSheetUrl ? { mgmtSheetUrl: cl.mgmtSheetUrl } : {}),
      },
    });
    updatedProjects++;

    for (const a of cl.accounts) {
      await prisma.snsAccount.upsert({
        where: {
          productionProjectId_platform: {
            productionProjectId: projectId,
            platform: a.platform,
          },
        },
        create: {
          productionProjectId: projectId,
          platform: a.platform,
          accountId: a.accountId,
          password: a.password,
          profileUrl: a.profileUrl,
          miyakePcLogin: a.miyakePcLogin,
        },
        update: {
          accountId: a.accountId,
          password: a.password,
          profileUrl: a.profileUrl,
          miyakePcLogin: a.miyakePcLogin,
        },
      });
      upsertedAccounts++;
    }
    matched.push(`${cl.companyName} -> ${projects[0].projectName} (${cl.accounts.length}媒体)`);
  }

  console.log(`\n[seed-sns-pm] === マッチ ${matched.length}社 ===`);
  for (const m of matched) console.log(`  ✓ ${m}`);
  console.log(`\n[seed-sns-pm] === 未マッチ ${unmatched.length}社 ===`);
  for (const u of unmatched) console.log(`  ✗ ${u.name}（${u.reason}）`);
  console.log(
    `\n[seed-sns-pm] プロジェクト補完=${updatedProjects} SnsAccount upsert=${upsertedAccounts}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
