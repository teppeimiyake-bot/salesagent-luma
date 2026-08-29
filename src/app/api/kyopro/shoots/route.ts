import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import { KYOPRO_ROLES, parseYearMonth, monthRange } from "@/lib/kyopro";

const roleEnum = z.enum(KYOPRO_ROLES as [string, ...string[]]);

/**
 * GET /api/kyopro/shoots?ym=2026-11
 *   指定月の撮影会（クライアント・会場・アサイン込み）。ym 省略時は今月。
 */
export async function GET(req: Request) {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const ym = new URL(req.url).searchParams.get("ym");
  const parsed = ym ? parseYearMonth(ym) : null;
  const now = new Date();
  const { year, month } = parsed ?? { year: now.getFullYear(), month: now.getMonth() + 1 };
  const { start, end } = monthRange(year, month);

  const shoots = await prisma.kyoproShoot.findMany({
    where: { date: { gte: start, lt: end } },
    include: {
      client: { select: { id: true, name: true, shortName: true, colorHex: true } },
      venue: { select: { id: true, name: true, colorHex: true } },
      assignments: {
        include: { staff: { select: { id: true, name: true } } },
        orderBy: { role: "asc" },
      },
    },
    orderBy: [{ date: "asc" }, { kind: "asc" }],
  });
  return NextResponse.json({ shoots, yearMonth: `${year}-${String(month).padStart(2, "0")}` });
}

const requiredCountsSchema = z.record(roleEnum, z.number().int().min(0).max(50));

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(["SHOOT", "SETUP"]).optional(),
  clientId: z.string().uuid(),
  venueId: z.string().uuid().nullish(),
  status: z.enum(["PLANNED", "CONFIRMED", "DONE", "CANCELLED"]).optional(),
  requiredCounts: requiredCountsSchema.nullish(),
  startTime: z.string().max(10).nullish(),
  endTime: z.string().max(10).nullish(),
  note: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const date = new Date(`${d.date}T00:00:00.000Z`);
  const kind = d.kind ?? "SHOOT";

  // 同じ日・同じクライアント・同じ会場・同じ区分の重複起票を防ぐ
  const dup = await prisma.kyoproShoot.findFirst({
    where: { date, kind, clientId: d.clientId, venueId: d.venueId ?? null },
  });
  if (dup) {
    return NextResponse.json({ error: "同じ日・クライアント・会場の撮影会が既に登録されています" }, { status: 409 });
  }

  // 会場未指定ならクライアントの既定会場（店舗開催など）を使う
  let venueId = d.venueId ?? null;
  if (!venueId) {
    const client = await prisma.kyoproClient.findUnique({ where: { id: d.clientId } });
    if (!client) return NextResponse.json({ error: "クライアントが見つかりません" }, { status: 404 });
    venueId = client.defaultVenueId;
  }

  const shoot = await prisma.kyoproShoot.create({
    data: {
      date,
      kind,
      clientId: d.clientId,
      venueId,
      status: d.status ?? "PLANNED",
      requiredCounts: d.requiredCounts ?? undefined,
      startTime: d.startTime ?? null,
      endTime: d.endTime ?? null,
      note: d.note ?? null,
    },
    include: { client: true, venue: true },
  });
  return NextResponse.json({ shoot });
}
