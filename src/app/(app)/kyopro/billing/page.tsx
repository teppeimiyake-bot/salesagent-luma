import Link from "next/link";
import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { KyoproTabs } from "@/components/kyopro/kyopro-tabs";
import { BillingClient, type BillLine, type PayoutRow } from "@/components/kyopro/billing-client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { ensureKyoproRates } from "@/lib/kyopro-server";
import {
  billTotal,
  monthRange,
  parseYearMonth,
  payTotal,
  payoutDueDate,
  shiftMonth,
  toYearMonth,
} from "@/lib/kyopro";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function KyoproBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const permission = await getCurrentPermission();
  // 金額の確定・ステータス変更は admin のみ（要件定義 §8）
  if (!hasPermission(permission, "admin")) redirect("/kyopro");

  const { ym } = await searchParams;
  const now = new Date();
  const { year, month } = (ym && parseYearMonth(ym)) || {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
  const { start, end } = monthRange(year, month);

  const { setting } = await ensureKyoproRates();
  const [assignments, period, payouts] = await Promise.all([
    prisma.kyoproAssignment.findMany({
      where: {
        status: { not: "CANCELLED" },
        shoot: { date: { gte: start, lt: end }, status: { not: "CANCELLED" } },
      },
      include: {
        staff: { select: { id: true, name: true } },
        shoot: {
          select: {
            date: true,
            kind: true,
            client: { select: { name: true } },
            venue: { select: { name: true } },
          },
        },
      },
    }),
    prisma.kyoproBillingPeriod.findFirst({ where: { yearMonth } }),
    prisma.kyoproPayout.findMany({ where: { yearMonth } }),
  ]);

  const lines: BillLine[] = assignments
    .map((a) => ({
      id: a.id,
      date: a.shoot.date.toISOString().slice(0, 10),
      kind: a.shoot.kind,
      clientName: a.shoot.client.name,
      venueName: a.shoot.venue?.name ?? null,
      staffId: a.staff.id,
      staffName: a.staff.name,
      role: a.role,
      cleanup: a.cleanup,
      bill: billTotal(a),
      pay: payTotal(a),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.clientName.localeCompare(b.clientName));

  const payoutByStaff = new Map(payouts.map((p) => [p.staffId, p]));
  const grouped = new Map<string, PayoutRow>();
  for (const l of lines) {
    const cur =
      grouped.get(l.staffId) ??
      ({
        staffId: l.staffId,
        staffName: l.staffName,
        days: 0,
        total: 0,
        cleanupDays: 0,
        status: payoutByStaff.get(l.staffId)?.status ?? "UNPAID",
        paidDate: payoutByStaff.get(l.staffId)?.paidDate?.toISOString().slice(0, 10) ?? null,
        lines: [],
      } satisfies PayoutRow);
    cur.days += 1;
    cur.total += l.pay;
    if (l.cleanup) cur.cleanupDays += 1;
    cur.lines.push({ date: l.date, clientName: l.clientName, role: l.role, pay: l.pay });
    grouped.set(l.staffId, cur);
  }
  const payoutRows = [...grouped.values()].sort((a, b) => b.total - a.total);

  const totalBill = lines.reduce((s, l) => s + l.bill, 0);
  const totalPay = lines.reduce((s, l) => s + l.pay, 0);

  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const ymOf = (v: { year: number; month: number }) =>
    `${v.year}-${String(v.month).padStart(2, "0")}`;

  return (
    <>
      <Header
        title="京プロ 請求・支払"
        subtitle={`${year}年${month}月 ／ ${lines.length}人日・${payoutRows.length}名`}
      />
      <KyoproTabs isAdmin />
      <div className="flex-1 overflow-y-auto bg-zinc-50 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Link
            href={`/kyopro/billing?ym=${ymOf(prev)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:border-emerald-300 hover:text-emerald-700"
            aria-label="前の月"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <div className="text-lg font-bold tracking-tight tabular-nums">
            {year}年{month}月
          </div>
          <Link
            href={`/kyopro/billing?ym=${ymOf(next)}`}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:border-emerald-300 hover:text-emerald-700"
            aria-label="次の月"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
          <Link
            href={`/kyopro/billing?ym=${toYearMonth(now)}`}
            className="ml-1 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:border-emerald-300 hover:text-emerald-700"
          >
            今月
          </Link>
        </div>

        <BillingClient
          yearMonth={yearMonth}
          lines={lines}
          payouts={payoutRows}
          totalBill={totalBill}
          totalPay={totalPay}
          taxRate={setting.taxRate}
          payoutDue={payoutDueDate(yearMonth, setting.payoutDueMonths).toISOString().slice(0, 10)}
          period={{
            billStatus: period?.billStatus ?? "NOT_SENT",
            invoiceDate: period?.invoiceDate?.toISOString().slice(0, 10) ?? null,
            paidDate: period?.paidDate?.toISOString().slice(0, 10) ?? null,
          }}
        />
      </div>
    </>
  );
}
