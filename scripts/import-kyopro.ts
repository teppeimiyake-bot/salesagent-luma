/**
 * 京プロ 撮影会派遣リストの初期投入
 * ============================================================
 * 元データ:
 *   C:\Teppei_Agent\株式会社リージー\京都プロデュース2026派遣リスト(修正版) (Sheet1).csv
 *   会場=F列 / カメラ=L列 / セレクト=N列 / 司会=P列 / 案内=R列
 *   （G〜J列＝京プロからの依頼人数、D列＝設営フラグ、E列＝クライアント＝呉服店）
 *
 * 使い方:
 *   ドライラン: npx tsx --env-file=.env scripts/import-kyopro.ts
 *   本投入:     npx tsx --env-file=.env scripts/import-kyopro.ts --apply
 *   ファイル指定: --file "C:\path\to.csv"   基準年の指定: --year 2026
 *
 * 設計:
 * - 1つの撮影会が複数行にまたがる（1行＝1人分の枠）。
 *   「日付＋クライアント＋会場＋設営区分」でグルーピングして撮影会1件にする。
 * - 依頼人数は各グループの先頭行にだけ入っているので、グループ内で最初に見つけた値を採る。
 * - sourceKey を付けて冪等にする。再実行しても重複せず、金額の入れ直しだけが起きる。
 * - 氏名の括弧書き（鈴木(片本) など）は括弧外を担当者、括弧内は備考に残す。
 *   ただし「坂井（喜）」は案内で11件稼働する別人なので、そのままの表記で登録する。
 */
import { prisma } from "../src/lib/db";
import { runAsTenant } from "../src/lib/tenant-context";
import {
  KYOPRO_ROLES,
  DEFAULT_RATES,
  computeAssignmentAmounts,
  resolveRate,
  type RateLike,
} from "../src/lib/kyopro";
import type { KyoproRole } from "@prisma/client";
import fs from "node:fs";

const DEFAULT_FILE =
  "C:\\Teppei_Agent\\株式会社リージー\\京都プロデュース2026派遣リスト(修正版) (Sheet1).csv";
const TENANT_CODE = "reagey";

/** 同姓の別人。括弧を外さずそのまま人材名として扱う。 */
const PRESERVE_NAMES = new Set(["坂井（喜）", "坂井(喜)"]);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FILE = valueOf("--file") ?? DEFAULT_FILE;
const BASE_YEAR = Number(valueOf("--year") ?? 2026);

function valueOf(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ------------------------------------------------------------
// CSV
// ------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // 無視（CRLF）
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const col = (letter: string) => letter.charCodeAt(0) - 65;
const cell = (row: string[], letter: string) => (row[col(letter)] ?? "").trim();

const ROLE_COLUMN: Record<KyoproRole, string> = {
  CAMERA: "L",
  SELECT: "N",
  MC: "P",
  GUIDE: "R",
};
const REQUIRED_COLUMN: Record<KyoproRole, string> = {
  CAMERA: "G",
  SELECT: "H",
  MC: "I",
  GUIDE: "J",
};

/** 「8月8日(土)」→ Date（UTC）。8〜12月は基準年、1〜7月は翌年に倒す。 */
function parseJpDate(raw: string): Date | null {
  const m = /^(\d{1,2})月(\d{1,2})日/.exec(raw.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = month >= 8 ? BASE_YEAR : BASE_YEAR + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** 氏名セル → { name, rawNote } */
function parseStaffCell(raw: string): { name: string; note: string | null } | null {
  const value = raw.trim();
  if (!value) return null;
  if (PRESERVE_NAMES.has(value)) return { name: value, note: null };
  const inside = /[（(]([^）)]*)[）)]/.exec(value)?.[1]?.trim() ?? null;
  const outside = value.replace(/[（(][^）)]*[）)]/g, "").trim();
  const name = outside || inside;
  if (!name) return null;
  return { name, note: inside ? `派遣リスト原文: ${value}` : null };
}

type ParsedAssignment = { role: KyoproRole; name: string; note: string | null };
type ParsedShoot = {
  key: string;
  date: Date;
  clientName: string;
  venueName: string | null;
  kind: "SHOOT" | "SETUP";
  required: Partial<Record<KyoproRole, number>>;
  assignments: ParsedAssignment[];
};

function parseFile(): ParsedShoot[] {
  const text = fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCsv(text).slice(3); // 1〜3行目はヘッダ
  const shoots = new Map<string, ParsedShoot>();

  for (const row of rows) {
    const date = parseJpDate(cell(row, "C"));
    if (!date) continue;
    const clientName = cell(row, "E");
    if (!clientName) continue;
    const venueName = cell(row, "F") || null;
    const kind: "SHOOT" | "SETUP" = cell(row, "D") ? "SETUP" : "SHOOT";
    const key = `${date.toISOString().slice(0, 10)}|${clientName}|${venueName ?? ""}|${kind}`;

    let shoot = shoots.get(key);
    if (!shoot) {
      shoot = { key, date, clientName, venueName, kind, required: {}, assignments: [] };
      shoots.set(key, shoot);
    }
    // 依頼人数はグループ先頭行にだけ入っている（"-" や空欄は 0 扱い）
    for (const role of KYOPRO_ROLES) {
      if (shoot.required[role] !== undefined) continue;
      const v = cell(row, REQUIRED_COLUMN[role]);
      if (/^\d+$/.test(v)) shoot.required[role] = Number(v);
    }
    for (const role of KYOPRO_ROLES) {
      const parsed = parseStaffCell(cell(row, ROLE_COLUMN[role]));
      if (!parsed) continue;
      // 同一撮影会・同一職種に同じ人が2回出てくることはない（あっても1件に寄せる）
      if (shoot.assignments.some((a) => a.role === role && a.name === parsed.name)) continue;
      shoot.assignments.push({ role, name: parsed.name, note: parsed.note });
    }
  }
  return [...shoots.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ------------------------------------------------------------
// 投入
// ------------------------------------------------------------
async function main() {
  const shoots = parseFile();
  const clientNames = [...new Set(shoots.map((s) => s.clientName))];
  const venueNames = [...new Set(shoots.map((s) => s.venueName).filter((v): v is string => !!v))];
  const staffRoles = new Map<string, Set<KyoproRole>>();
  for (const s of shoots) {
    for (const a of s.assignments) {
      const set = staffRoles.get(a.name) ?? new Set<KyoproRole>();
      set.add(a.role);
      staffRoles.set(a.name, set);
    }
  }
  const assignmentCount = shoots.reduce((n, s) => n + s.assignments.length, 0);

  console.log(`ファイル: ${FILE}`);
  console.log(
    `撮影会 ${shoots.length}件（設営 ${shoots.filter((s) => s.kind === "SETUP").length}件） / ` +
      `クライアント ${clientNames.length}社 / 会場 ${venueNames.length} / ` +
      `人材 ${staffRoles.size}名 / アサイン ${assignmentCount}件`,
  );

  if (!APPLY) {
    console.log("\n--- ドライラン（--apply で投入） ---");
    for (const s of shoots.slice(0, 5)) {
      console.log(
        `${s.date.toISOString().slice(0, 10)} ${s.kind} ${s.clientName} / ${s.venueName ?? "会場なし"} ` +
          `依頼=${JSON.stringify(s.required)} 人員=${s.assignments.map((a) => `${a.role}:${a.name}`).join(",")}`,
      );
    }
    console.log(`… 以下 ${Math.max(0, shoots.length - 5)} 件`);
    console.log("\n人材:");
    for (const [name, roles] of staffRoles) console.log(`  ${name} [${[...roles].join(",")}]`);
    return;
  }

  await runAsTenant(TENANT_CODE, async () => {
    // --- マスタ ---
    const clientIds = new Map<string, string>();
    for (const [i, name] of clientNames.entries()) {
      const existing = await prisma.kyoproClient.findFirst({ where: { name } });
      const rec =
        existing ??
        (await prisma.kyoproClient.create({
          data: { name, colorHex: COLORS[i % COLORS.length], sortOrder: i + 1 },
        }));
      clientIds.set(name, rec.id);
    }
    const venueIds = new Map<string, string>();
    for (const [i, name] of venueNames.entries()) {
      const existing = await prisma.kyoproVenue.findFirst({ where: { name } });
      const rec =
        existing ?? (await prisma.kyoproVenue.create({ data: { name, sortOrder: i + 1 } }));
      venueIds.set(name, rec.id);
    }
    const staffIds = new Map<string, string>();
    let i = 0;
    for (const [name, roles] of staffRoles) {
      i++;
      const existing = await prisma.kyoproStaff.findFirst({ where: { name } });
      if (existing) {
        // 既存の対応職種に、リストから読み取れた職種を足す
        const merged = [...new Set([...(existing.roles as KyoproRole[]), ...roles])];
        const rec = await prisma.kyoproStaff.update({
          where: { id: existing.id },
          data: { roles: merged },
        });
        staffIds.set(name, rec.id);
      } else {
        const rec = await prisma.kyoproStaff.create({
          data: { name, roles: [...roles], sortOrder: i },
        });
        staffIds.set(name, rec.id);
      }
    }

    // --- レート（無ければ既定値で作る） ---
    const existingRates = await prisma.kyoproRate.findMany();
    const missing = KYOPRO_ROLES.filter((r) => !existingRates.some((e) => e.role === r));
    if (missing.length > 0) {
      await prisma.kyoproRate.createMany({
        data: missing.map((role) => ({
          role,
          billRate: DEFAULT_RATES[role].billRate,
          payRateDefault: DEFAULT_RATES[role].payRateDefault,
          payRateMin: DEFAULT_RATES[role].payRateMin ?? null,
          payRateMax: DEFAULT_RATES[role].payRateMax ?? null,
          effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
        })),
      });
    }
    if (!(await prisma.kyoproSetting.findFirst())) await prisma.kyoproSetting.create({ data: {} });
    const rates = (await prisma.kyoproRate.findMany()) as unknown as RateLike[];
    const staffRecords = await prisma.kyoproStaff.findMany();
    const overridesById = new Map(staffRecords.map((s) => [s.id, s.payOverrides]));

    // --- 撮影会とアサイン ---
    let createdShoots = 0;
    let updatedShoots = 0;
    let createdAssignments = 0;
    for (const s of shoots) {
      const sourceKey = `csv:${s.key}`;
      const data = {
        date: s.date,
        kind: s.kind,
        clientId: clientIds.get(s.clientName)!,
        venueId: s.venueName ? (venueIds.get(s.venueName) ?? null) : null,
        // 過去〜確定済みの日程なので確定扱いで入れる（実施済み判定は運用で更新）
        status: "CONFIRMED" as const,
        requiredCounts: Object.keys(s.required).length > 0 ? s.required : undefined,
        sourceKey,
      };
      const existing = await prisma.kyoproShoot.findFirst({ where: { sourceKey } });
      const shoot = existing
        ? await prisma.kyoproShoot.update({ where: { id: existing.id }, data })
        : await prisma.kyoproShoot.create({ data });
      if (existing) updatedShoots++;
      else createdShoots++;

      for (const a of s.assignments) {
        const staffId = staffIds.get(a.name)!;
        const rate = resolveRate(rates, a.role, s.date);
        const amounts = computeAssignmentAmounts({
          rate,
          role: a.role,
          payOverrides: overridesById.get(staffId),
          cleanup: false, // 過去分の片付け有無はリストに無いため未チェックで投入する
        });
        const assignKey = `${sourceKey}|${a.role}|${a.name}`;
        const dup = await prisma.kyoproAssignment.findFirst({
          where: { shootId: shoot.id, staffId, role: a.role },
        });
        if (dup) continue;
        await prisma.kyoproAssignment.create({
          data: {
            shootId: shoot.id,
            staffId,
            role: a.role,
            status: "CONFIRMED",
            billAmount: amounts.billAmount,
            payAmount: amounts.payAmount,
            cleanupBillAmount: 0,
            cleanupPayAmount: 0,
            note: a.note,
            sourceKey: assignKey,
          },
        });
        createdAssignments++;
      }
    }

    console.log(
      `投入完了: 撮影会 新規${createdShoots}/更新${updatedShoots}件、アサイン 新規${createdAssignments}件、` +
        `クライアント${clientIds.size}社、会場${venueIds.size}、人材${staffIds.size}名`,
    );
  });
}

const COLORS = [
  "#0d6b52",
  "#0284c7",
  "#7c3aed",
  "#c2710c",
  "#be123c",
  "#0f766e",
  "#4f46e5",
  "#65a30d",
];

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
