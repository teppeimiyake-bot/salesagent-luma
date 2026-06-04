"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Inbox, Search, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAYMENT_TIMINGS,
  CONTRACT_STATUSES,
  INVOICE_SENT_STATUSES,
  PAYMENT_RECV_STATUSES,
  PAYMENT_TIMING_LABEL,
  CONTRACT_STATUS_LABEL,
  INVOICE_SENT_LABEL,
  PAYMENT_RECV_LABEL,
  grossFromNet,
  yen,
  type PaymentTiming,
  type ContractStatus,
  type InvoiceSentStatus,
  type PaymentRecvStatus,
} from "@/lib/payments";
import {
  PAYMENT_TIMING_BADGE,
  CONTRACT_STATUS_BADGE,
  INVOICE_SENT_BADGE,
  PAYMENT_RECV_BADGE,
} from "@/lib/payments-ui";
import { StatusBadge } from "@/components/payments/status-badge";
import {
  SpotFilters,
  defaultSpotFilterState,
  type SpotFilterState,
} from "@/components/payments/spot-filters";

type SpotRecord = {
  id: string;
  customerName: string;
  companyId: string | null;
  company: { id: string; name: string } | null;
  dealId: string | null;
  deal: { id: string; title: string } | null;
  paymentTiming: PaymentTiming;
  contractStatus: ContractStatus;
  invoiceStatus: InvoiceSentStatus;
  paymentStatus: PaymentRecvStatus;
  deliveryDate: string | null;
  expectedPaymentDate: string | null;
  amountNet: number | null;
  amountGross: number | null;
};

function isoDay(s: string | null): string {
  if (!s) return "";
  return s.slice(0, 10);
}

export function SpotTable({ canEdit }: { canEdit: boolean }) {
  const [records, setRecords] = useState<SpotRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  // 着金状況は初期で「未確認 + 前金分確認済み」のみ表示（確認済みを隠す）。他項目は全選択。
  const [filters, setFilters] = useState<SpotFilterState>(defaultSpotFilterState);

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/payments/spot");
      const j = await r.json();
      setRecords(j.records ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setSavingId(id);
      // 楽観更新
      setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, ...body } : r)));
      try {
        const res = await fetch(`/api/payments/spot/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const j = await res.json();
          if (j.record) setRecords((prev) => prev.map((r) => (r.id === id ? j.record : r)));
        }
      } finally {
        setSavingId(null);
      }
    },
    [],
  );

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return records.filter((r) => {
      if (t && !r.customerName.toLowerCase().includes(t)) return false;
      if (!filters.paymentTiming.includes(r.paymentTiming)) return false;
      if (!filters.contractStatus.includes(r.contractStatus)) return false;
      if (!filters.invoiceStatus.includes(r.invoiceStatus)) return false;
      if (!filters.paymentStatus.includes(r.paymentStatus)) return false;
      return true;
    });
  }, [records, q, filters]);

  // KPI: 着金確認済みの税込合計 / 未確認の税込合計
  const totals = useMemo(() => {
    let confirmed = 0;
    let pending = 0;
    for (const r of records) {
      const g = r.amountGross ?? grossFromNet(r.amountNet) ?? 0;
      if (r.paymentStatus === "CONFIRMED") confirmed += g;
      else pending += g;
    }
    return { confirmed, pending };
  }, [records]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        読み込み中...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* サマリ + 検索 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="顧客名で検索"
            className="pl-9 w-64"
          />
        </div>
        <div className="ml-auto flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500">着金確認済み</span>
            <span className="font-semibold text-emerald-700">{yen(totals.confirmed)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-500">未確認</span>
            <span className="font-semibold text-amber-700">{yen(totals.pending)}</span>
          </div>
          <Badge variant="secondary">{filtered.length}件</Badge>
        </div>
      </div>

      {/* 項目別フィルタ（複数選択トグル）。着金状況は初期=未確認+前金分確認済み */}
      <SpotFilters state={filters} onChange={setFilters} />

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
              <th className="px-3 py-2.5 font-medium min-w-[180px]">顧客名</th>
              <th className="px-3 py-2.5 font-medium">支払時期</th>
              <th className="px-3 py-2.5 font-medium">契約締結</th>
              <th className="px-3 py-2.5 font-medium">請求書送付</th>
              <th className="px-3 py-2.5 font-medium">着金状況</th>
              <th className="px-3 py-2.5 font-medium">納品予定日</th>
              <th className="px-3 py-2.5 font-medium">着金見込み日</th>
              <th className="px-3 py-2.5 font-medium text-right">契約金額(税抜)</th>
              <th className="px-3 py-2.5 font-medium text-right">着金金額(税込)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="py-16 text-center text-zinc-400">
                  <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  該当する入金レコードがありません
                </td>
              </tr>
            )}
            {filtered.map((r) => {
              const grossPreview = r.amountGross ?? grossFromNet(r.amountNet);
              const mismatch =
                r.amountNet != null &&
                r.amountGross != null &&
                Math.abs((grossFromNet(r.amountNet) ?? 0) - r.amountGross) > 1;
              return (
                <tr
                  key={r.id}
                  className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60 align-middle"
                >
                  {/* 顧客名（紐づく受注商談があればクリックで /deals/[id] へ。無ければプレーン表示） */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {r.dealId ? (
                        <Link
                          href={`/deals/${r.dealId}`}
                          target="_blank"
                          className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                          title={r.deal?.title ? `商談「${r.deal.title}」を開く` : "紐づく商談を開く"}
                        >
                          {r.customerName}
                          <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                        </Link>
                      ) : (
                        <span className="font-medium">{r.customerName}</span>
                      )}
                    </div>
                  </td>

                  {/* 支払時期 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Select
                        value={r.paymentTiming}
                        onValueChange={(v) => patch(r.id, { paymentTiming: v })}
                      >
                        <SelectTrigger className="h-8 w-[130px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_TIMINGS.map((t) => (
                            <SelectItem key={t} value={t}>
                              {PAYMENT_TIMING_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <StatusBadge tone={PAYMENT_TIMING_BADGE[r.paymentTiming]}>
                        {PAYMENT_TIMING_LABEL[r.paymentTiming]}
                      </StatusBadge>
                    )}
                  </td>

                  {/* 契約締結 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Select
                        value={r.contractStatus}
                        onValueChange={(v) => patch(r.id, { contractStatus: v })}
                      >
                        <SelectTrigger className="h-8 w-[100px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONTRACT_STATUSES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {CONTRACT_STATUS_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <StatusBadge tone={CONTRACT_STATUS_BADGE[r.contractStatus]}>
                        {CONTRACT_STATUS_LABEL[r.contractStatus]}
                      </StatusBadge>
                    )}
                  </td>

                  {/* 請求書送付 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Select
                        value={r.invoiceStatus}
                        onValueChange={(v) => patch(r.id, { invoiceStatus: v })}
                      >
                        <SelectTrigger className="h-8 w-[140px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {INVOICE_SENT_STATUSES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {INVOICE_SENT_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <StatusBadge tone={INVOICE_SENT_BADGE[r.invoiceStatus]}>
                        {INVOICE_SENT_LABEL[r.invoiceStatus]}
                      </StatusBadge>
                    )}
                  </td>

                  {/* 着金状況 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Select
                        value={r.paymentStatus}
                        onValueChange={(v) => patch(r.id, { paymentStatus: v })}
                      >
                        <SelectTrigger className="h-8 w-[140px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_RECV_STATUSES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {PAYMENT_RECV_LABEL[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <StatusBadge tone={PAYMENT_RECV_BADGE[r.paymentStatus]}>
                        {PAYMENT_RECV_LABEL[r.paymentStatus]}
                      </StatusBadge>
                    )}
                  </td>

                  {/* 納品予定日 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <DateInput
                        value={isoDay(r.deliveryDate)}
                        onChange={(v) => patch(r.id, { deliveryDate: v || null })}
                        className="scale-90 origin-left"
                      />
                    ) : (
                      <span className="tabular-nums">{isoDay(r.deliveryDate) || "—"}</span>
                    )}
                  </td>

                  {/* 着金見込み日 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <DateInput
                        value={isoDay(r.expectedPaymentDate)}
                        onChange={(v) => patch(r.id, { expectedPaymentDate: v || null })}
                        className="scale-90 origin-left"
                      />
                    ) : (
                      <span className="tabular-nums">{isoDay(r.expectedPaymentDate) || "—"}</span>
                    )}
                  </td>

                  {/* 契約金額(税抜) */}
                  <td className="px-3 py-2 text-right">
                    {canEdit ? (
                      <Input
                        type="number"
                        defaultValue={r.amountNet ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const n = v === "" ? null : parseInt(v, 10);
                          if (n !== r.amountNet)
                            patch(r.id, { amountNet: n, recomputeGross: true });
                        }}
                        className="h-8 w-[120px] text-right tabular-nums"
                      />
                    ) : (
                      <span className="tabular-nums">{yen(r.amountNet)}</span>
                    )}
                  </td>

                  {/* 着金金額(税込) = net×1.1 自動 */}
                  <td className="px-3 py-2 text-right">
                    <span
                      className={`tabular-nums font-medium ${mismatch ? "text-amber-600" : "text-zinc-700"}`}
                      title={mismatch ? "契約金額×1.1 と不一致（CSV原値を保持）" : "契約金額×1.1"}
                    >
                      {yen(grossPreview)}
                    </span>
                    {savingId === r.id && (
                      <Loader2 className="inline h-3 w-3 animate-spin ml-1 text-zinc-400" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-400">
        着金金額(税込)は契約金額(税抜)×1.1 を自動計算します。CSV原値と差がある行は金額がオレンジ表示になります。
      </p>
    </div>
  );
}
