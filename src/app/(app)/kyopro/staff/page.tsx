import { Header } from "@/components/layout/header";
import { KyoproTabs } from "@/components/kyopro/kyopro-tabs";
import { StaffClient, type StaffRow } from "@/components/kyopro/staff-client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { monthRange, parseYearMonth, payTotal } from "@/lib/kyopro";

export const dynamic = "force-dynamic";

export default async function KyoproStaffPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string }>;
}) {
  const { ym } = await searchParams;
  const now = new Date();
  const { year, month } = (ym && parseYearMonth(ym)) || {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  };
  const { start, end } = monthRange(year, month);

  const [permission, staff, assignments] = await Promise.all([
    getCurrentPermission(),
    prisma.kyoproStaff.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    // 165件規模のため全件読んで JS で集計する（月次と累計を1クエリで出す）
    prisma.kyoproAssignment.findMany({
      where: { status: { not: "CANCELLED" } },
      select: {
        staffId: true,
        payAmount: true,
        cleanupPayAmount: true,
        cleanupBillAmount: true,
        billAmount: true,
        adjustAmount: true,
        status: true,
        shoot: { select: { date: true, status: true } },
      },
    }),
  ]);

  const stats = new Map<string, { monthDays: number; monthPay: number; totalDays: number; totalPay: number }>();
  for (const a of assignments) {
    if (a.shoot.status === "CANCELLED") continue;
    const cur = stats.get(a.staffId) ?? { monthDays: 0, monthPay: 0, totalDays: 0, totalPay: 0 };
    const pay = payTotal(a);
    cur.totalDays += 1;
    cur.totalPay += pay;
    if (a.shoot.date >= start && a.shoot.date < end) {
      cur.monthDays += 1;
      cur.monthPay += pay;
    }
    stats.set(a.staffId, cur);
  }

  const isAdmin = permission === "admin";
  const rows: StaffRow[] = staff.map((s) => {
    const st = stats.get(s.id) ?? { monthDays: 0, monthPay: 0, totalDays: 0, totalPay: 0 };
    return {
      id: s.id,
      name: s.name,
      kana: s.kana,
      phone: s.phone,
      email: s.email,
      roles: s.roles as unknown as string[],
      payOverrides: (s.payOverrides as Record<string, number> | null) ?? null,
      // 振込先は管理者以外には渡さない（クライアントへ載せない）
      bankInfo: isAdmin ? s.bankInfo : null,
      note: s.note,
      active: s.active,
      ...st,
    };
  });

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <>
      <Header
        title="京プロ 人材"
        subtitle={`稼働中 ${activeCount} 名 ／ ${year}年${month}月の稼働・支払見込`}
      />
      <KyoproTabs isAdmin={isAdmin} />
      <div className="flex-1 overflow-y-auto bg-zinc-50 p-6">
        <StaffClient
          rows={rows}
          canEdit={hasPermission(permission, "user")}
          isAdmin={isAdmin}
          monthLabel={`${month}月`}
        />
      </div>
    </>
  );
}
