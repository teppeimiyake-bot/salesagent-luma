import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { getFiscalQuarterMonths } from "@/lib/config";

// 週次実績の取得（閲覧は全ロール）。
// クエリ: ?fy=2026&q=1 で会計年度の四半期に属する3暦月のレコードだけ返す。
// q 省略時は fy 全体（12暦月）を返す。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fy = url.searchParams.get("fy");
  const q = url.searchParams.get("q");

  let monthFilters: { year: number; month: number }[] | undefined;
  if (fy) {
    const fyNum = Number(fy);
    if (q) {
      // 四半期(1〜4) → quarterIndex(0〜3)
      monthFilters = getFiscalQuarterMonths(fyNum, Number(q) - 1);
    } else {
      monthFilters = [];
      for (let qi = 0; qi < 4; qi++) {
        monthFilters.push(...getFiscalQuarterMonths(fyNum, qi));
      }
    }
  }

  const entries = await prisma.msWeeklyEntry.findMany({
    where: monthFilters
      ? { OR: monthFilters.map((m) => ({ year: m.year, month: m.month })) }
      : undefined,
    orderBy: [{ year: "asc" }, { month: "asc" }, { weekOfMonth: "asc" }],
  });
  return NextResponse.json({ entries });
}

// 週次実績は (worker, year, month, weekOfMonth) で一意。upsert。
// 編集は user 以上。値が全て0なら未入力扱いでレコード削除。
const upsertSchema = z.object({
  workerId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  weekOfMonth: z.number().int().min(1).max(5),
  sent: z.number().int().min(0).default(0),
  appointments: z.number().int().min(0).default(0),
  listOrders: z.number().int().min(0).default(0),
  inquiryOrders: z.number().int().min(0).default(0),
  notes: z.string().max(2000).optional().nullable(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden: user 以上が必要です" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { workerId, year, month, weekOfMonth, sent, appointments, listOrders, inquiryOrders, notes } =
    parsed.data;

  const where = {
    workerId_year_month_weekOfMonth: { workerId, year, month, weekOfMonth },
  };

  // 全数値0かつ notes 空 → 未入力扱いで削除
  const isEmpty =
    sent === 0 && appointments === 0 && listOrders === 0 && inquiryOrders === 0 && !notes;
  if (isEmpty) {
    const existing = await prisma.msWeeklyEntry.findUnique({ where });
    if (existing) await prisma.msWeeklyEntry.delete({ where });
    return NextResponse.json({ entry: null });
  }

  const entry = await prisma.msWeeklyEntry.upsert({
    where,
    create: {
      workerId,
      year,
      month,
      weekOfMonth,
      sent,
      appointments,
      listOrders,
      inquiryOrders,
      notes: notes ?? null,
    },
    update: { sent, appointments, listOrders, inquiryOrders, notes: notes ?? null },
  });
  return NextResponse.json({ entry });
}
