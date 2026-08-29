"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ROLE_LABEL, ROLE_STYLE, formatJPY } from "@/lib/kyopro";
import type { KyoproRole } from "@prisma/client";
import { Download, ChevronDown, ChevronRight, Sparkles, AlertTriangle } from "lucide-react";

export type BillLine = {
  id: string;
  date: string;
  kind: "SHOOT" | "SETUP";
  clientName: string;
  venueName: string | null;
  staffId: string;
  staffName: string;
  role: KyoproRole;
  cleanup: boolean;
  bill: number;
  pay: number;
};

export type PayoutRow = {
  staffId: string;
  staffName: string;
  days: number;
  cleanupDays: number;
  total: number;
  status: "UNPAID" | "SCHEDULED" | "PAID";
  paidDate: string | null;
  lines: { date: string; clientName: string; role: KyoproRole; pay: number }[];
};

const BILL_STATUS: { v: "NOT_SENT" | "SENT" | "PAID"; label: string }[] = [
  { v: "NOT_SENT", label: "未送付" },
  { v: "SENT", label: "送付済" },
  { v: "PAID", label: "入金済" },
];

const PAYOUT_STATUS: { v: PayoutRow["status"]; label: string }[] = [
  { v: "UNPAID", label: "未払" },
  { v: "SCHEDULED", label: "予定" },
  { v: "PAID", label: "支払済" },
];

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function md(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

/** Excel で開いても文字化けしないよう BOM 付きで書き出す */
function downloadCsv(filename: string, rows: (string | number)[][]) {
  const body = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob([`﻿${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BillingClient({
  yearMonth,
  lines,
  payouts,
  totalBill,
  totalPay,
  taxRate,
  payoutDue,
  period,
}: {
  yearMonth: string;
  lines: BillLine[];
  payouts: PayoutRow[];
  totalBill: number;
  totalPay: number;
  taxRate: number;
  payoutDue: string;
  period: { billStatus: "NOT_SENT" | "SENT" | "PAID"; invoiceDate: string | null; paidDate: string | null };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const margin = totalBill - totalPay;
  const gross = Math.round(totalBill * (1 + taxRate));
  const overdue = payoutDue < new Date().toISOString().slice(0, 10);

  function patchBilling(body: Record<string, unknown>) {
    start(async () => {
      const res = await fetch("/api/kyopro/billing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yearMonth, ...body }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "更新に失敗しました");
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  function patchPayout(row: PayoutRow, status: PayoutRow["status"]) {
    start(async () => {
      const res = await fetch("/api/kyopro/payouts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yearMonth, staffId: row.staffId, status, amount: row.total }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "更新に失敗しました");
        return;
      }
      setError(null);
      router.refresh();
    });
  }

  function exportBill() {
    downloadCsv(`京プロ請求明細_${yearMonth}.csv`, [
      ["日付", "区分", "クライアント", "会場", "氏名", "職種", "片付け", "受注額(税抜)"],
      ...lines.map((l) => [
        l.date,
        l.kind === "SETUP" ? "設営" : "撮影",
        l.clientName,
        l.venueName ?? "",
        l.staffName,
        ROLE_LABEL[l.role],
        l.cleanup ? "あり" : "",
        l.bill,
      ]),
      ["合計(税抜)", "", "", "", "", "", "", totalBill],
      ["合計(税込)", "", "", "", "", "", "", gross],
    ]);
  }

  function exportPayout() {
    downloadCsv(`京プロ人材支払_${yearMonth}.csv`, [
      ["氏名", "稼働日数", "片付け日数", "支払額", "支払期日", "ステータス"],
      ...payouts.map((p) => [
        p.staffName,
        p.days,
        p.cleanupDays,
        p.total,
        payoutDue,
        PAYOUT_STATUS.find((s) => s.v === p.status)?.label ?? "",
      ]),
      ["合計", "", "", totalPay, "", ""],
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {[
          { k: "受注（京プロ請求・税抜）", v: formatJPY(totalBill), sub: `税込 ${formatJPY(gross)}` },
          { k: "発注（人材支払）", v: formatJPY(totalPay) },
          { k: "粗利", v: formatJPY(margin), good: true },
          {
            k: "粗利率",
            v: totalBill > 0 ? `${Math.round((margin / totalBill) * 1000) / 10}%` : "—",
            good: true,
          },
        ].map((it) => (
          <div key={it.k} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div className="text-[11px] font-bold tracking-wide text-zinc-400">{it.k}</div>
            <div
              className={`text-xl font-semibold tabular-nums ${it.good ? "text-emerald-700" : "text-zinc-900"}`}
            >
              {it.v}
            </div>
            {it.sub && <div className="text-[11px] text-zinc-400">{it.sub}</div>}
          </div>
        ))}
      </div>

      {error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      <div className="grid gap-4 xl:grid-cols-2">
        {/* ---------------- 京プロ請求 ---------------- */}
        <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-bold text-zinc-800">京プロ請求</h2>
            <div className="flex gap-1">
              {BILL_STATUS.map((s) => (
                <button
                  key={s.v}
                  disabled={pending}
                  onClick={() => patchBilling({ billStatus: s.v })}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    period.billStatus === s.v
                      ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                      : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={exportBill}>
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-b border-zinc-100 px-4 py-2 text-xs text-zinc-600">
            <label className="inline-flex items-center gap-1.5">
              請求日
              <input
                type="date"
                value={period.invoiceDate ?? ""}
                onChange={(e) => patchBilling({ invoiceDate: e.target.value || null })}
                className="rounded border border-zinc-200 px-2 py-1"
              />
            </label>
            <label className="inline-flex items-center gap-1.5">
              入金日
              <input
                type="date"
                value={period.paidDate ?? ""}
                onChange={(e) => patchBilling({ paidDate: e.target.value || null })}
                className="rounded border border-zinc-200 px-2 py-1"
              />
            </label>
            <span className="ml-auto tabular-nums">
              税抜 <b>{formatJPY(totalBill)}</b> ／ 税込 <b>{formatJPY(gross)}</b>
            </span>
          </div>

          <div className="max-h-[520px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-50">
                <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="px-3 py-2 text-left font-bold">日付</th>
                  <th className="px-3 py-2 text-left font-bold">クライアント／会場</th>
                  <th className="px-3 py-2 text-left font-bold">氏名</th>
                  <th className="px-3 py-2 text-left font-bold">職種</th>
                  <th className="px-3 py-2 text-right font-bold">受注額</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const st = ROLE_STYLE[l.role];
                  return (
                    <tr key={l.id} className="border-b border-zinc-100 last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                        {md(l.date)}
                        {l.kind === "SETUP" && <span className="ml-1 text-zinc-400">設営</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        {l.clientName}
                        {l.venueName && <span className="text-zinc-400">／{l.venueName}</span>}
                      </td>
                      <td className="px-3 py-1.5">
                        {l.staffName}
                        {l.cleanup && (
                          <span
                            className="ml-1 inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1 py-0.5 text-[10px] font-semibold text-emerald-700"
                            title="片付け対応 +3,000円"
                          >
                            <Sparkles className="h-2.5 w-2.5" />
                            片付け
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${st.bg} ${st.border} ${st.text}`}>
                          {ROLE_LABEL[l.role]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{formatJPY(l.bill)}</td>
                    </tr>
                  );
                })}
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-zinc-400">
                      この月の実績がありません。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* ---------------- 人材支払 ---------------- */}
        <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-bold text-zinc-800">人材支払</h2>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                overdue && payouts.some((p) => p.status !== "PAID")
                  ? "bg-rose-50 text-rose-600"
                  : "bg-zinc-100 text-zinc-500"
              }`}
            >
              {overdue && payouts.some((p) => p.status !== "PAID") && (
                <AlertTriangle className="h-3 w-3" />
              )}
              支払期日 {payoutDue}
            </span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={exportPayout}>
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>

          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-50">
                <tr className="border-b border-zinc-200 text-[10px] uppercase tracking-wider text-zinc-400">
                  <th className="px-3 py-2 text-left font-bold">氏名</th>
                  <th className="px-3 py-2 text-right font-bold">稼働</th>
                  <th className="px-3 py-2 text-right font-bold">支払額</th>
                  <th className="px-3 py-2 text-left font-bold">ステータス</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <PayoutRowView
                    key={p.staffId}
                    row={p}
                    pending={pending}
                    onStatus={(s) => patchPayout(p, s)}
                  />
                ))}
                {payouts.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-10 text-center text-zinc-400">
                      この月の支払対象がありません。
                    </td>
                  </tr>
                )}
              </tbody>
              {payouts.length > 0 && (
                <tfoot>
                  <tr className="border-t border-zinc-200 bg-zinc-50 font-semibold">
                    <td className="px-3 py-2">合計</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {payouts.reduce((s, p) => s + p.days, 0)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatJPY(totalPay)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function PayoutRowView({
  row,
  pending,
  onStatus,
}: {
  row: PayoutRow;
  pending: boolean;
  onStatus: (s: PayoutRow["status"]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-zinc-100">
        <td className="px-3 py-1.5">
          <button
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 font-medium hover:text-emerald-700"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {row.staffName}
          </button>
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">
          {row.days}
          {row.cleanupDays > 0 && (
            <span className="ml-1 text-[10px] text-emerald-600">片{row.cleanupDays}</span>
          )}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums">{formatJPY(row.total)}</td>
        <td className="px-3 py-1.5">
          <div className="flex gap-1">
            {PAYOUT_STATUS.map((s) => (
              <button
                key={s.v}
                disabled={pending}
                onClick={() => onStatus(s.v)}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                  row.status === s.v
                    ? s.v === "PAID"
                      ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                      : "border-zinc-400 bg-zinc-100 text-zinc-700"
                    : "border-zinc-200 text-zinc-400 hover:border-zinc-300"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {row.paidDate && <div className="mt-0.5 text-[10px] text-zinc-400">{row.paidDate}</div>}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-zinc-100 bg-zinc-50/60">
          <td colSpan={4} className="px-3 py-2">
            <div className="space-y-1">
              {row.lines.map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] text-zinc-600">
                  <span className="w-16 tabular-nums">{md(l.date)}</span>
                  <span className="flex-1 truncate">{l.clientName}</span>
                  <span className={ROLE_STYLE[l.role].text}>{ROLE_LABEL[l.role]}</span>
                  <span className="w-20 text-right tabular-nums">{formatJPY(l.pay)}</span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
