/**
 * 既存 meetings.{strategy, topSales, nextActions} のうち、
 * UI で string レンダリングしているフィールドに object/array が入っているレコードを
 * 整形 JSON 文字列に書き換える。
 *
 * 該当した原因：
 *   AI（Claude）が一部の生成で closing_plan などを {"week1": "...", "week2": "..."}
 *   のようなネスト object で返すケースがあり、`<p>{strategy.closing_plan}</p>` で
 *   "Objects are not valid as a React child" 例外を踏んで Server Component が落ちる。
 *
 * 使い方:
 *   DATABASE_URL="postgres://..." npx tsx scripts/fix-meeting-ai-fields.ts            # 確認だけ
 *   DATABASE_URL="postgres://..." npx tsx scripts/fix-meeting-ai-fields.ts --apply    # 書き換え
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const APPLY = process.argv.includes("--apply");

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function normalizeStrategy(raw: unknown): { changed: boolean; value: unknown } {
  if (!raw || typeof raw !== "object") return { changed: false, value: raw };
  const s = raw as Record<string, unknown>;
  const next = {
    ...s,
    strategy: toStr(s.strategy),
    differentiation: toStr(s.differentiation),
    closing_plan: toStr(s.closing_plan),
  };
  const changed =
    typeof s.strategy !== "string" ||
    typeof s.differentiation !== "string" ||
    typeof s.closing_plan !== "string";
  return { changed, value: next };
}

function normalizeTopSales(raw: unknown): { changed: boolean; value: unknown } {
  if (!raw || typeof raw !== "object") return { changed: false, value: raw };
  const t = raw as Record<string, unknown>;
  const risksRaw = t.risks;
  const risks = Array.isArray(risksRaw) ? risksRaw.map(toStr) : [];
  const next = {
    ...t,
    real_intent: toStr(t.real_intent),
    decision_structure: toStr(t.decision_structure),
    risks,
    winning_scenario: toStr(t.winning_scenario),
  };
  const changed =
    typeof t.real_intent !== "string" ||
    typeof t.decision_structure !== "string" ||
    typeof t.winning_scenario !== "string" ||
    (Array.isArray(risksRaw) && risksRaw.some((r) => typeof r !== "string"));
  return { changed, value: next };
}

function normalizeNextActions(raw: unknown): { changed: boolean; value: unknown } {
  if (!raw || typeof raw !== "object") return { changed: false, value: raw };
  const r = raw as Record<string, unknown>;
  const arr = r.next_actions;
  if (!Array.isArray(arr)) return { changed: false, value: raw };
  let changed = false;
  const nextArr = arr.map((a) => {
    if (!a || typeof a !== "object") return a;
    const x = a as Record<string, unknown>;
    if (
      typeof x.action !== "string" ||
      typeof x.reason !== "string" ||
      typeof x.expected_outcome !== "string"
    ) {
      changed = true;
    }
    return {
      ...x,
      action: toStr(x.action),
      reason: toStr(x.reason),
      expected_outcome: toStr(x.expected_outcome),
    };
  });
  return { changed, value: { ...r, next_actions: nextArr } };
}

async function main() {
  const meetings = await prisma.meeting.findMany({
    select: { id: true, dealId: true, strategy: true, topSales: true, nextActions: true },
  });
  console.log(`Scanning ${meetings.length} meetings...`);
  let scanned = 0;
  let needsFix = 0;
  let fixed = 0;

  for (const m of meetings) {
    scanned++;
    const s = normalizeStrategy(m.strategy);
    const t = normalizeTopSales(m.topSales);
    const n = normalizeNextActions(m.nextActions);
    if (!s.changed && !t.changed && !n.changed) continue;
    needsFix++;
    console.log(`- meeting ${m.id} (deal ${m.dealId}) needs fix:`, {
      strategy: s.changed,
      topSales: t.changed,
      nextActions: n.changed,
    });
    if (APPLY) {
      await prisma.meeting.update({
        where: { id: m.id },
        data: {
          ...(s.changed ? { strategy: s.value as never } : {}),
          ...(t.changed ? { topSales: t.value as never } : {}),
          ...(n.changed ? { nextActions: n.value as never } : {}),
        },
      });
      fixed++;
    }
  }

  console.log(`\nScanned: ${scanned}, needs fix: ${needsFix}, fixed: ${fixed} (apply=${APPLY})`);
  if (!APPLY && needsFix > 0) {
    console.log("Re-run with --apply to actually write changes.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
