import Link from "next/link";
import { prisma } from "@/lib/db";
import { isKyoproTenant } from "@/lib/kyopro-server";
import {
  KYOPRO_ROLES,
  ROLE_LABEL,
  ROLE_STYLE,
  formatJPY,
  monthRange,
  shootMetrics,
} from "@/lib/kyopro";
import { holidayName } from "@/lib/jp-holidays";
import { Camera, ArrowRight, AlertTriangle } from "lucide-react";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * ダッシュボード用の京プロサマリ。
 * リージーを見ているときだけ出す（Luma・全社ビューでは何も描かない）。
 * 見たいのは「直近で人が埋まっていない撮影会」と「当月の粗利」なので、この2つに絞る。
 */
export async function KyoproDashboardCard() {
  if (!(await isKyoproTenant())) return null;

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const horizon = new Date(todayUtc);
  horizon.setUTCDate(horizon.getUTCDate() + 28);
  const { start, end } = monthRange(today.getFullYear(), today.getMonth() + 1);

  const select = {
    role: true,
    status: true,
    billAmount: true,
    payAmount: true,
    cleanupBillAmount: true,
    cleanupPayAmount: true,
    adjustAmount: true,
  } as const;

  const [upcoming, thisMonth] = await Promise.all([
    prisma.kyoproShoot.findMany({
      where: { date: { gte: todayUtc, lte: horizon }, status: { not: "CANCELLED" } },
      include: {
        client: { select: { name: true, colorHex: true } },
        venue: { select: { name: true } },
        assignments: { select },
      },
      orderBy: [{ date: "asc" }],
      take: 12,
    }),
    prisma.kyoproShoot.findMany({
      where: { date: { gte: start, lt: end }, status: { not: "CANCELLED" } },
      select: { requiredCounts: true, assignments: { select } },
    }),
  ]);

  if (upcoming.length === 0 && thisMonth.length === 0) return null;

  const month = thisMonth.reduce(
    (acc, s) => {
      const m = shootMetrics(s);
      acc.bill += m.bill;
      acc.pay += m.pay;
      acc.persons += m.count;
      acc.shortage += m.shortage;
      return acc;
    },
    { bill: 0, pay: 0, persons: 0, shortage: 0 },
  );
  const rows = upcoming.map((s) => ({ shoot: s, m: shootMetrics(s) }));
  const shortRows = rows.filter((r) => r.m.isShort);

  return (
    <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 px-5 py-3">
        <Camera className="h-4 w-4 text-emerald-600" />
        <h2 className="text-sm font-bold text-zinc-800">京プロ 撮影会</h2>
        <span className="text-xs text-zinc-400">今後4週間 ／ 当月実績</span>
        <Link
          href="/kyopro"
          className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:text-emerald-800"
        >
          カレンダーを開く
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-px bg-zinc-100 md:grid-cols-4">
        {[
          { k: "当月 稼働", v: `${month.persons}`, unit: "人日" },
          { k: "当月 不足", v: `${month.shortage}`, unit: "人日", alert: month.shortage > 0 },
          { k: "当月 受注", v: formatJPY(month.bill) },
          { k: "当月 粗利", v: formatJPY(month.bill - month.pay), good: true },
        ].map((it) => (
          <div key={it.k} className="bg-white px-5 py-3">
            <div className="text-[11px] font-bold tracking-wide text-zinc-400">{it.k}</div>
            <div
              className={`text-lg font-semibold tabular-nums ${
                it.alert ? "text-rose-600" : it.good ? "text-emerald-700" : "text-zinc-900"
              }`}
            >
              {it.v}
              {it.unit && <span className="ml-1 text-xs text-zinc-400">{it.unit}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 py-3">
        {shortRows.length > 0 && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            人員が埋まっていない撮影会 {shortRows.length} 件
          </div>
        )}
        <div className="space-y-1">
          {rows.slice(0, 6).map(({ shoot, m }) => {
            const iso = shoot.date.toISOString().slice(0, 10);
            const holiday = holidayName(iso);
            const wd = WEEKDAYS[shoot.date.getUTCDay()];
            return (
              <Link
                key={shoot.id}
                href={`/kyopro/shoots?ym=${iso.slice(0, 7)}&focus=${shoot.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50"
              >
                <span className="w-24 shrink-0 tabular-nums text-zinc-600">
                  {shoot.date.getUTCMonth() + 1}/{shoot.date.getUTCDate()}
                  <span className={holiday || wd === "日" ? "text-rose-500" : "text-zinc-400"}>
                    （{wd}）
                  </span>
                </span>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: shoot.client.colorHex }}
                />
                <span className="min-w-0 flex-1 truncate">
                  {shoot.client.name}
                  {shoot.venue && <span className="text-zinc-400">／{shoot.venue.name}</span>}
                  {shoot.kind === "SETUP" && <span className="ml-1 text-xs text-zinc-400">設営</span>}
                </span>
                <span className="flex shrink-0 gap-1">
                  {KYOPRO_ROLES.map((role) => {
                    const req = m.requiredByRole[role] ?? 0;
                    const asg = m.assigned[role] ?? 0;
                    if (req === 0 && asg === 0) return null;
                    const st = ROLE_STYLE[role];
                    return (
                      <span
                        key={role}
                        className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${st.bg} ${st.border} ${st.text}`}
                        title={ROLE_LABEL[role]}
                      >
                        {ROLE_LABEL[role].slice(0, 2)} {asg}
                        {req > 0 && `/${req}`}
                      </span>
                    );
                  })}
                </span>
                {m.isShort && (
                  <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600">
                    不足 {m.shortage}
                  </span>
                )}
              </Link>
            );
          })}
          {rows.length === 0 && (
            <p className="py-2 text-xs text-zinc-400">今後4週間の撮影会はありません。</p>
          )}
        </div>
      </div>
    </section>
  );
}
