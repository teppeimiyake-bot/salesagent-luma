import Link from "next/link";
import { Header } from "@/components/layout/header";
import { KyoproTabs } from "@/components/kyopro/kyopro-tabs";
import { KyoproMonthSummary } from "@/components/kyopro/month-summary";
import { ShootsClient, type ShootRow } from "@/components/kyopro/shoots-client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { monthRange, parseYearMonth, shiftMonth, shootMetrics, toYearMonth } from "@/lib/kyopro";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function KyoproShootsPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string; focus?: string }>;
}) {
  const { ym, focus } = await searchParams;
  const now = new Date();
  const { year, month } = (ym && parseYearMonth(ym)) || {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
  const { start, end } = monthRange(year, month);

  const [permission, shoots, clients, venues] = await Promise.all([
    getCurrentPermission(),
    prisma.kyoproShoot.findMany({
      where: { date: { gte: start, lt: end } },
      include: {
        client: { select: { id: true, name: true, colorHex: true } },
        venue: { select: { id: true, name: true } },
        assignments: {
          select: {
            role: true,
            status: true,
            billAmount: true,
            payAmount: true,
            cleanupBillAmount: true,
            cleanupPayAmount: true,
            adjustAmount: true,
            staff: { select: { name: true } },
          },
        },
      },
      orderBy: [{ date: "asc" }, { kind: "asc" }],
    }),
    prisma.kyoproClient.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, colorHex: true },
    }),
    prisma.kyoproVenue.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, colorHex: true },
    }),
  ]);

  const rows: ShootRow[] = shoots.map((s) => {
    const m = shootMetrics(s);
    return {
      id: s.id,
      date: s.date.toISOString().slice(0, 10),
      kind: s.kind,
      status: s.status,
      clientId: s.client.id,
      clientName: s.client.name,
      clientColor: s.client.colorHex,
      venueId: s.venue?.id ?? null,
      venueName: s.venue?.name ?? null,
      startTime: s.startTime,
      endTime: s.endTime,
      note: s.note,
      required: m.requiredByRole as Record<string, number>,
      assigned: m.assigned,
      staff: s.assignments
        .filter((a) => a.status !== "CANCELLED")
        .map((a) => ({ role: a.role, name: a.staff.name })),
      shortage: m.shortage,
      bill: m.bill,
      pay: m.pay,
    };
  });

  const summary = rows.reduce(
    (acc, r) => {
      if (r.status === "CANCELLED") return acc;
      acc.shoots += 1;
      acc.persons += r.staff.length;
      acc.shortage += r.shortage;
      acc.bill += r.bill;
      acc.pay += r.pay;
      return acc;
    },
    { shoots: 0, persons: 0, shortage: 0, bill: 0, pay: 0 },
  );

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const ymOf = (v: { year: number; month: number }) =>
    `${v.year}-${String(v.month).padStart(2, "0")}`;

  return (
    <>
      <Header
        title="京プロ 撮影会一覧"
        subtitle={`${year}年${month}月 ／ ${summary.shoots}件${
          summary.shortage > 0 ? `・不足 ${summary.shortage}人日` : "・不足なし"
        }`}
      />
      <KyoproTabs isAdmin={permission === "admin"} />

      <div className="flex-1 overflow-y-auto bg-zinc-50 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Link
            href={`/kyopro/shoots?ym=${ymOf(prev)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:border-emerald-300 hover:text-emerald-700"
            aria-label="前の月"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="text-lg font-bold tracking-tight tabular-nums">
            {year}年{month}月
          </div>
          <Link
            href={`/kyopro/shoots?ym=${ymOf(next)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:border-emerald-300 hover:text-emerald-700"
            aria-label="次の月"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
          <Link
            href={`/kyopro/shoots?ym=${toYearMonth(now)}`}
            className="ml-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:border-emerald-300 hover:text-emerald-700"
          >
            今月
          </Link>
        </div>

        <KyoproMonthSummary
          shoots={summary.shoots}
          persons={summary.persons}
          shortage={summary.shortage}
          bill={summary.bill}
          pay={summary.pay}
        />

        <ShootsClient
          rows={rows}
          clients={clients}
          venues={venues}
          canEdit={hasPermission(permission, "user")}
          focusId={focus}
        />
      </div>
    </>
  );
}
