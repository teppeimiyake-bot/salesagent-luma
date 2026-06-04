"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Inbox, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { yen, ym, ymLabel, ymRange } from "@/lib/payments";

type Period = { id: string; yearMonth: number; sent: boolean; paid: boolean };
type Billing = {
  id: string;
  customerName: string;
  companyId: string | null;
  company: { id: string; name: string } | null;
  initialFee: number | null;
  monthlyFee: number | null;
  startDate: string | null;
  endDate: string | null;
  periods: Period[];
};

function dateToYm(s: string | null): number | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return ym(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function RecurringGrid({ canEdit }: { canEdit: boolean }) {
  const [billings, setBillings] = useState<Billing[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBillings = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/payments/recurring");
      const j = await r.json();
      setBillings(j.billings ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBillings();
  }, [fetchBillings]);

  // グリッドの月カラム範囲：全契約の最小開始月〜最大終了月（period/契約期間の両方から算出）
  const months = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const b of billings) {
      const candidates: number[] = [];
      const s = dateToYm(b.startDate);
      const e = dateToYm(b.endDate);
      if (s) candidates.push(s);
      if (e) candidates.push(e);
      for (const p of b.periods) candidates.push(p.yearMonth);
      for (const c of candidates) {
        if (c < min) min = c;
        if (c > max) max = c;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
    return ymRange(min, max);
  }, [billings]);

  const togglePeriod = useCallback(
    async (billingId: string, yearMonth: number, field: "sent" | "paid", next: boolean) => {
      // 楽観更新
      setBillings((prev) =>
        prev.map((b) => {
          if (b.id !== billingId) return b;
          const existing = b.periods.find((p) => p.yearMonth === yearMonth);
          let periods: Period[];
          if (existing) {
            periods = b.periods.map((p) =>
              p.yearMonth === yearMonth ? { ...p, [field]: next } : p,
            );
          } else {
            periods = [
              ...b.periods,
              {
                id: `tmp-${yearMonth}`,
                yearMonth,
                sent: field === "sent" ? next : false,
                paid: field === "paid" ? next : false,
              },
            ];
          }
          return { ...b, periods };
        }),
      );
      await fetch(`/api/payments/recurring/${billingId}/period`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yearMonth, [field]: next }),
      });
    },
    [],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        読み込み中...
      </div>
    );
  }

  if (billings.length === 0) {
    return (
      <div className="py-16 text-center text-zinc-400">
        <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
        定期契約がありません
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-sky-400" /> 請求送付
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm bg-emerald-500" /> 着金
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm border border-zinc-300 bg-white" /> 未
        </span>
        <Badge variant="secondary" className="ml-auto">
          {billings.length}契約
        </Badge>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            <tr className="bg-zinc-50 text-xs text-zinc-500">
              <th className="sticky left-0 z-10 bg-zinc-50 px-3 py-2 text-left font-medium min-w-[160px] border-r border-zinc-200">
                顧客名
              </th>
              <th className="px-2 py-2 text-right font-medium border-r border-zinc-200">初期費用</th>
              <th className="px-2 py-2 text-right font-medium border-r border-zinc-200">月額</th>
              <th className="px-2 py-2 text-center font-medium border-r border-zinc-200 min-w-[120px]">
                契約期間
              </th>
              {months.map((m) => (
                <th
                  key={m}
                  className="px-1 py-2 text-center font-medium tabular-nums border-r border-zinc-100 min-w-[52px]"
                >
                  {ymLabel(m).replace(/^\d{2}/, "")}
                  <div className="text-[9px] text-zinc-400">{String(Math.floor(m / 100))}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {billings.map((b) => {
              const pmap = new Map(b.periods.map((p) => [p.yearMonth, p]));
              const startYm = dateToYm(b.startDate);
              const endYm = dateToYm(b.endDate);
              return (
                <tr key={b.id} className="border-t border-zinc-100 hover:bg-zinc-50/40">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-zinc-200">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate max-w-[140px]">{b.customerName}</span>
                      {b.company && (
                        <span title={`企業: ${b.company.name}`}>
                          <Link2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums border-r border-zinc-200">
                    {yen(b.initialFee)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums border-r border-zinc-200">
                    {yen(b.monthlyFee)}
                  </td>
                  <td className="px-2 py-2 text-center text-xs text-zinc-500 tabular-nums border-r border-zinc-200">
                    {b.startDate ? b.startDate.slice(0, 7) : "—"}
                    {" 〜 "}
                    {b.endDate ? b.endDate.slice(0, 7) : "—"}
                  </td>
                  {months.map((m) => {
                    const p = pmap.get(m);
                    const inContract =
                      (startYm == null || m >= startYm) && (endYm == null || m <= endYm);
                    return (
                      <td
                        key={m}
                        className={`px-1 py-1 text-center border-r border-zinc-100 ${inContract ? "" : "bg-zinc-50/60"}`}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <Cell
                            on={!!p?.sent}
                            color="sky"
                            disabled={!canEdit}
                            title={`${ymLabel(m)} 請求送付`}
                            onClick={() => togglePeriod(b.id, m, "sent", !p?.sent)}
                          />
                          <Cell
                            on={!!p?.paid}
                            color="emerald"
                            disabled={!canEdit}
                            title={`${ymLabel(m)} 着金`}
                            onClick={() => togglePeriod(b.id, m, "paid", !p?.paid)}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-400">
        上=請求送付 / 下=着金。セルをクリックでトグル。薄いグレー背景は契約期間外の月です。
      </p>
    </div>
  );
}

function Cell({
  on,
  color,
  disabled,
  title,
  onClick,
}: {
  on: boolean;
  color: "sky" | "emerald";
  disabled?: boolean;
  title: string;
  onClick: () => void;
}) {
  const onBg = color === "sky" ? "bg-sky-400 border-sky-400" : "bg-emerald-500 border-emerald-500";
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`h-4 w-7 rounded-sm border transition-colors ${
        on ? onBg : "bg-white border-zinc-300 hover:border-zinc-400"
      } ${disabled ? "cursor-default opacity-80" : "cursor-pointer"}`}
    />
  );
}
