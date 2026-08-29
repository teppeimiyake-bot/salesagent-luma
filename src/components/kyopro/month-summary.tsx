import { formatJPY } from "@/lib/kyopro";

/**
 * 月次サマリ（カレンダー・一覧の上に出す）。
 * 「不足」は依頼人数に対して埋まっていない人日で、0 でなければ赤で立てる。
 */
export function KyoproMonthSummary({
  shoots,
  persons,
  shortage,
  bill,
  pay,
}: {
  shoots: number;
  persons: number;
  shortage: number;
  bill: number;
  pay: number;
}) {
  const margin = bill - pay;
  const rate = bill > 0 ? Math.round((margin / bill) * 1000) / 10 : 0;
  const items = [
    { k: "撮影会", v: `${shoots}`, unit: "件" },
    { k: "稼働", v: `${persons}`, unit: "人日" },
    { k: "不足", v: `${shortage}`, unit: "人日", alert: shortage > 0 },
    { k: "受注（京プロ請求）", v: formatJPY(bill) },
    { k: "発注（人材支払）", v: formatJPY(pay) },
    { k: "粗利", v: formatJPY(margin), sub: `${rate}%`, good: margin >= 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {items.map((it) => (
        <div key={it.k} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
          <div className="text-[11px] font-bold tracking-wide text-zinc-400">{it.k}</div>
          <div
            className={`text-xl font-semibold tabular-nums ${
              it.alert ? "text-rose-600" : it.good ? "text-emerald-700" : "text-zinc-900"
            }`}
          >
            {it.v}
            {it.unit && <span className="ml-1 text-xs text-zinc-400">{it.unit}</span>}
            {it.sub && <span className="ml-1.5 text-xs text-zinc-400">{it.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
