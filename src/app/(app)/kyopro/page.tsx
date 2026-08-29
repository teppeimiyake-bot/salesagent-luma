import Link from "next/link";
import { Header } from "@/components/layout/header";
import { KyoproTabs } from "@/components/kyopro/kyopro-tabs";
import { KyoproMonthSummary } from "@/components/kyopro/month-summary";
import { ShootDrawerLauncher } from "@/components/kyopro/shoot-drawer-launcher";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import {
  KYOPRO_ROLES,
  ROLE_LABEL,
  ROLE_STYLE,
  monthRange,
  parseYearMonth,
  shiftMonth,
  shootMetrics,
  toYearMonth,
} from "@/lib/kyopro";
import { holidayName } from "@/lib/jp-holidays";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

export const dynamic = "force-dynamic";

const WEEK_HEAD = ["日", "月", "火", "水", "木", "金", "土"];

export default async function KyoproCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const { ym } = await searchParams;
  const now = new Date();
  const parsed = (ym && parseYearMonth(ym)) || {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
  const { year, month } = parsed;
  const { start, end } = monthRange(year, month);

  const [permission, shoots] = await Promise.all([
    getCurrentPermission(),
    prisma.kyoproShoot.findMany({
      where: { date: { gte: start, lt: end } },
      include: {
        client: { select: { id: true, name: true, shortName: true, colorHex: true } },
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
          },
        },
      },
      orderBy: [{ date: "asc" }, { kind: "asc" }],
    }),
  ]);

  const canEdit = hasPermission(permission, "user");
  const rows = shoots.map((s) => ({ shoot: s, m: shootMetrics(s) }));
  const summary = rows.reduce(
    (acc, r) => {
      if (r.shoot.status === "CANCELLED") return acc;
      acc.shoots += 1;
      acc.persons += r.m.count;
      acc.shortage += r.m.shortage;
      acc.bill += r.m.bill;
      acc.pay += r.m.pay;
      return acc;
    },
    { shoots: 0, persons: 0, shortage: 0, bill: 0, pay: 0 },
  );

  // 月グリッド（日曜始まり）。date列は @db.Date なので UTC で扱う。
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<number, typeof rows>();
  for (const r of rows) {
    const d = r.shoot.date.getUTCDate();
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const ymOf = (v: { year: number; month: number }) =>
    `${v.year}-${String(v.month).padStart(2, "0")}`;

  return (
    <>
      <Header
        title="京プロ 撮影会派遣"
        subtitle={`${year}年${month}月 ／ 撮影会 ${summary.shoots}件・稼働 ${summary.persons}人日${
          summary.shortage > 0 ? `・不足 ${summary.shortage}人日` : ""
        }`}
      />
      <KyoproTabs isAdmin={permission === "admin"} />

      <div className="flex-1 overflow-y-auto bg-zinc-50 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Link
            href={`/kyopro?ym=${ymOf(prev)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:text-emerald-700 hover:border-emerald-300"
            aria-label="前の月"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="text-lg font-bold tracking-tight tabular-nums">
            {year}年{month}月
          </div>
          <Link
            href={`/kyopro?ym=${ymOf(next)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:text-emerald-700 hover:border-emerald-300"
            aria-label="次の月"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
          <Link
            href={`/kyopro?ym=${toYearMonth(now)}`}
            className="ml-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:border-emerald-300 hover:text-emerald-700"
          >
            今月
          </Link>
          <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-zinc-500">
            {KYOPRO_ROLES.map((r) => (
              <span key={r} className="inline-flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-full ${ROLE_STYLE[r].solid}`} />
                {ROLE_LABEL[r]}
              </span>
            ))}
          </div>
        </div>

        <KyoproMonthSummary
          shoots={summary.shoots}
          persons={summary.persons}
          shortage={summary.shortage}
          bill={summary.bill}
          pay={summary.pay}
        />

        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="grid grid-cols-7 border-b border-zinc-200 bg-zinc-50">
            {WEEK_HEAD.map((w, i) => (
              <div
                key={w}
                className={`py-2 text-center text-xs font-bold tracking-wider ${
                  i === 0 ? "text-rose-500" : i === 6 ? "text-sky-600" : "text-zinc-400"
                }`}
              >
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const weekday = i % 7;
              const iso =
                day === null
                  ? null
                  : `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const holiday = iso ? holidayName(iso) : null;
              // 撮影会は土日祝に集中するので、平日はトーンを落として休日を目立たせる
              const isRestCell = weekday === 0 || weekday === 6 || holiday !== null;
              const list = day ? (byDay.get(day) ?? []) : [];
              return (
                <div
                  key={i}
                  className={`min-h-[116px] border-b border-r border-zinc-100 p-1.5 last:border-r-0 ${
                    day === null ? "bg-zinc-50/60" : isRestCell ? "bg-emerald-50/40" : "bg-white"
                  }`}
                >
                  {day !== null && (
                    <>
                      <div
                        className={`flex items-baseline gap-1 px-1 text-[11px] tabular-nums ${
                          weekday === 0 || holiday
                            ? "text-rose-500 font-semibold"
                            : weekday === 6
                              ? "text-sky-600 font-semibold"
                              : "text-zinc-400"
                        }`}
                      >
                        {day}
                        {holiday && (
                          <span className="truncate text-[10px] font-normal text-rose-400">
                            {holiday}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 space-y-1">
                        {list.map(({ shoot, m }) => {
                          const cancelled = shoot.status === "CANCELLED";
                          const label = shoot.client.shortName || shoot.client.name;
                          return (
                            <ShootDrawerLauncher
                              key={shoot.id}
                              shootId={shoot.id}
                              canEdit={canEdit}
                              style={{ borderLeftColor: shoot.client.colorHex }}
                              className={`flex w-full items-center justify-between gap-1 rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight transition-colors ${
                                cancelled
                                  ? "bg-zinc-100 text-zinc-400 line-through"
                                  : shoot.kind === "SETUP"
                                    ? "border-dashed bg-zinc-50 text-zinc-500 hover:bg-zinc-100"
                                    : "bg-zinc-50 text-zinc-700 hover:bg-zinc-100"
                              }`}
                              title={`${label}${shoot.venue ? ` ／ ${shoot.venue.name}` : ""}`}
                            >
                              <span className="truncate">
                                {shoot.kind === "SETUP" && (
                                  <span className="mr-1 text-[10px] text-zinc-400">設営</span>
                                )}
                                {label}
                              </span>
                              {m.required > 0 && (
                                <span
                                  className={`shrink-0 tabular-nums text-[10px] font-semibold ${
                                    m.isShort ? "text-rose-600" : "text-emerald-600"
                                  }`}
                                >
                                  {m.filled}/{m.required}
                                </span>
                              )}
                            </ShootDrawerLauncher>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {rows.length === 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-white p-8 text-sm text-zinc-500">
            <CalendarDays className="h-5 w-5 text-zinc-300" />
            この月の撮影会はまだ登録されていません。「撮影会一覧」タブから登録できます。
          </div>
        )}
      </div>
    </>
  );
}
