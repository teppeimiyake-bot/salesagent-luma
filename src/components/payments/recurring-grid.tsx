"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Inbox, ExternalLink, RefreshCw, AlertTriangle, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { yen, ym, ymLabel, ymRange } from "@/lib/payments";

type Period = { id: string; yearMonth: number; sent: boolean; paid: boolean };
type Billing = {
  id: string;
  customerName: string;
  companyId: string | null;
  company: { id: string; name: string } | null;
  dealId: string | null;
  deal: { id: string; title: string } | null;
  dealProductId: string | null;
  dealProduct: {
    id: string;
    productName: string;
    amount: number | null;
    productionProject: {
      serviceStartMonth: string | null;
      serviceEndMonth: string | null;
    } | null;
  } | null;
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

/** yyyymm の start/end（含む）から契約月数を算出。どちらか無ければ null。 */
function monthsBetween(startYm: number | null, endYm: number | null): number | null {
  if (startYm == null || endYm == null || endYm < startYm) return null;
  return ymRange(startYm, endYm).length;
}

/** YYYY-MM-DD → YYYY-MM */
function ymStr(s: string | null): string {
  if (!s) return "";
  return s.slice(0, 7);
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

  // 定期ヘッダ（初期費用/月額/契約期間）の編集
  const patchBilling = useCallback(
    async (billingId: string, body: Record<string, unknown>) => {
      setBillings((prev) => prev.map((b) => (b.id === billingId ? { ...b, ...body } : b)));
      const res = await fetch(`/api/payments/recurring/${billingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j = await res.json();
        if (j.billing)
          setBillings((prev) =>
            prev.map((b) => (b.id === billingId ? { ...b, ...j.billing } : b)),
          );
      }
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
              <th className="px-2 py-2 text-center font-medium border-r border-zinc-200 min-w-[150px]">
                契約期間
              </th>
              <th className="px-2 py-2 text-right font-medium border-r border-zinc-200 min-w-[120px]">
                提案金額／検算
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
              // 検算：初期費用 + 月額 × 契約月数 = 提案金額(DealProduct.amount)
              const contractMonths = monthsBetween(startYm, endYm);
              const proposalAmount = b.dealProduct?.amount ?? null;
              const computed =
                contractMonths != null && (b.initialFee != null || b.monthlyFee != null)
                  ? (b.initialFee ?? 0) + (b.monthlyFee ?? 0) * contractMonths
                  : null;
              const verifyMismatch =
                proposalAmount != null && computed != null && Math.abs(computed - proposalAmount) > 1;
              const verifyOk =
                proposalAmount != null && computed != null && Math.abs(computed - proposalAmount) <= 1;
              // PM（ProductionProject）の SNS 提供開始/終了月
              const pmStart = b.dealProduct?.productionProject?.serviceStartMonth ?? null;
              const pmEnd = b.dealProduct?.productionProject?.serviceEndMonth ?? null;
              const pmPeriodDiffers =
                (pmStart != null || pmEnd != null) &&
                (ymStr(pmStart) !== ymStr(b.startDate) || ymStr(pmEnd) !== ymStr(b.endDate));
              return (
                <tr key={b.id} className="border-t border-zinc-100 hover:bg-zinc-50/40">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-zinc-200">
                    <div className="flex items-center gap-1.5">
                      {b.dealId ? (
                        <Link
                          href={`/deals/${b.dealId}`}
                          target="_blank"
                          className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-800 hover:underline truncate max-w-[150px]"
                          title={b.deal?.title ? `商談「${b.deal.title}」を開く` : "紐づく商談を開く"}
                        >
                          <span className="truncate">{b.customerName}</span>
                          <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                        </Link>
                      ) : (
                        <span className="font-medium truncate max-w-[140px]">{b.customerName}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums border-r border-zinc-200">
                    {canEdit ? (
                      <Input
                        key={`${b.id}-init-${b.initialFee ?? ""}`}
                        type="number"
                        defaultValue={b.initialFee ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const n = v === "" ? null : parseInt(v, 10);
                          if (n !== b.initialFee) patchBilling(b.id, { initialFee: n });
                        }}
                        className="h-7 w-[96px] text-right tabular-nums"
                      />
                    ) : (
                      yen(b.initialFee)
                    )}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums border-r border-zinc-200">
                    {canEdit ? (
                      <Input
                        key={`${b.id}-mon-${b.monthlyFee ?? ""}`}
                        type="number"
                        defaultValue={b.monthlyFee ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const n = v === "" ? null : parseInt(v, 10);
                          if (n !== b.monthlyFee) patchBilling(b.id, { monthlyFee: n });
                        }}
                        className="h-7 w-[96px] text-right tabular-nums"
                      />
                    ) : (
                      yen(b.monthlyFee)
                    )}
                  </td>
                  <td className="px-2 py-2 text-center text-xs text-zinc-500 tabular-nums border-r border-zinc-200">
                    {canEdit ? (
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex items-center gap-1">
                          <Input
                            type="month"
                            value={ymStr(b.startDate)}
                            onChange={(e) =>
                              patchBilling(b.id, {
                                startDate: e.target.value ? `${e.target.value}-01` : null,
                              })
                            }
                            className="h-7 w-[110px] text-xs"
                          />
                          <span>〜</span>
                          <Input
                            type="month"
                            value={ymStr(b.endDate)}
                            onChange={(e) =>
                              patchBilling(b.id, {
                                endDate: e.target.value ? `${e.target.value}-01` : null,
                              })
                            }
                            className="h-7 w-[110px] text-xs"
                          />
                        </div>
                        {contractMonths != null && (
                          <span className="text-[10px] text-zinc-400">契約 {contractMonths}ヶ月</span>
                        )}
                        {(pmStart != null || pmEnd != null) && (
                          <div className="flex items-center gap-1 text-[10px] text-zinc-400">
                            <span title="PM受注管理のSNS提供期間">
                              PM: {ymStr(pmStart) || "—"}〜{ymStr(pmEnd) || "—"}
                            </span>
                            {pmPeriodDiffers && (
                              <button
                                type="button"
                                onClick={() =>
                                  patchBilling(b.id, {
                                    startDate: pmStart ? `${ymStr(pmStart)}-01` : b.startDate,
                                    endDate: pmEnd ? `${ymStr(pmEnd)}-01` : b.endDate,
                                  })
                                }
                                className="inline-flex items-center gap-0.5 text-indigo-500 hover:text-indigo-700"
                                title="PMのSNS提供期間に合わせる"
                              >
                                <RefreshCw className="h-2.5 w-2.5" />
                                合わせる
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {ymStr(b.startDate) || "—"}
                        {" 〜 "}
                        {ymStr(b.endDate) || "—"}
                        {contractMonths != null && (
                          <div className="text-[10px] text-zinc-400">契約 {contractMonths}ヶ月</div>
                        )}
                      </>
                    )}
                  </td>
                  {/* 提案金額／検算（初期費用 + 月額×契約月数 = 提案金額） */}
                  <td className="px-2 py-2 text-right text-xs tabular-nums border-r border-zinc-200">
                    {proposalAmount != null ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-zinc-600">提案 {yen(proposalAmount)}</span>
                        {computed != null && (
                          <span
                            className={`inline-flex items-center gap-0.5 ${
                              verifyMismatch
                                ? "text-red-600 font-semibold"
                                : verifyOk
                                  ? "text-emerald-600"
                                  : "text-zinc-400"
                            }`}
                            title={`初期費用 + 月額×${contractMonths ?? "?"}ヶ月 = ${yen(computed)}`}
                          >
                            {verifyMismatch ? (
                              <AlertTriangle className="h-3 w-3" />
                            ) : verifyOk ? (
                              <Check className="h-3 w-3" />
                            ) : null}
                            計 {yen(computed)}
                          </span>
                        )}
                        {contractMonths == null && (
                          <span className="text-[10px] text-zinc-400">期間未設定</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
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
