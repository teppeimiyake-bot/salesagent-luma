"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  KYOPRO_ROLES,
  ROLE_LABEL,
  ROLE_STYLE,
  SHOOT_KIND_LABEL,
  SHOOT_STATUS_LABEL,
  formatJPY,
} from "@/lib/kyopro";
import type { KyoproRole } from "@prisma/client";
import { holidayName } from "@/lib/jp-holidays";
import { ShootDrawer } from "@/components/kyopro/shoot-drawer";
import { Plus, Pencil, AlertTriangle, Trash2, Copy, Users } from "lucide-react";

export type ShootRow = {
  id: string;
  date: string;
  kind: "SHOOT" | "SETUP";
  status: "PLANNED" | "CONFIRMED" | "DONE" | "CANCELLED";
  clientId: string;
  clientName: string;
  clientColor: string;
  venueId: string | null;
  venueName: string | null;
  startTime: string | null;
  endTime: string | null;
  note: string | null;
  required: Record<string, number>;
  assigned: Record<string, number>;
  staff: { role: KyoproRole; name: string }[];
  shortage: number;
  bill: number;
  pay: number;
};

export type MasterOption = { id: string; name: string; colorHex: string };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function dateLabel(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const holiday = holidayName(iso);
  return { text: `${m}/${d}`, wd, holiday, isRest: wd === "土" || wd === "日" || holiday !== null };
}

const STATUS_VARIANT: Record<string, "secondary" | "success" | "warning" | "danger"> = {
  PLANNED: "secondary",
  CONFIRMED: "success",
  DONE: "warning",
  CANCELLED: "danger",
};

export function ShootsClient({
  rows,
  clients,
  venues,
  canEdit,
  focusId,
}: {
  rows: ShootRow[];
  clients: MasterOption[];
  venues: MasterOption[];
  canEdit: boolean;
  focusId?: string;
}) {
  const [clientFilter, setClientFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [shortOnly, setShortOnly] = useState(false);
  const [editing, setEditing] = useState<ShootRow | null>(null);
  const [creating, setCreating] = useState<Partial<ShootRow> | null>(null);
  // カレンダーから ?focus= で飛んできたときは、その撮影会の詳細を開いた状態で始める
  const [drawerId, setDrawerId] = useState<string | null>(focusId ?? null);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (clientFilter && r.clientId !== clientFilter) return false;
        if (kindFilter && r.kind !== kindFilter) return false;
        if (shortOnly && r.shortage === 0) return false;
        return true;
      }),
    [rows, clientFilter, kindFilter, shortOnly],
  );

  const totals = filtered.reduce(
    (a, r) => {
      if (r.status !== "CANCELLED") {
        a.bill += r.bill;
        a.pay += r.pay;
        a.shortage += r.shortage;
      }
      return a;
    },
    { bill: 0, pay: 0, shortage: 0 },
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700"
        >
          <option value="">全クライアント</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-700"
        >
          <option value="">撮影・設営すべて</option>
          <option value="SHOOT">撮影のみ</option>
          <option value="SETUP">設営のみ</option>
        </select>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700">
          <input
            type="checkbox"
            checked={shortOnly}
            onChange={(e) => setShortOnly(e.target.checked)}
            className="accent-rose-500"
          />
          不足のみ
        </label>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500 tabular-nums">
          <span>{filtered.length} 件</span>
          {totals.shortage > 0 && <span className="text-rose-600 font-semibold">不足 {totals.shortage} 人日</span>}
          <span>受注 {formatJPY(totals.bill)}</span>
          <span>発注 {formatJPY(totals.pay)}</span>
          <span className="font-semibold text-emerald-700">粗利 {formatJPY(totals.bill - totals.pay)}</span>
        </div>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={() => setCreating({})}>
            <Plus className="h-4 w-4" />
            撮影会を追加
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2 text-left font-bold">日付</th>
              <th className="px-3 py-2 text-left font-bold">クライアント</th>
              <th className="px-3 py-2 text-left font-bold">会場</th>
              <th className="px-3 py-2 text-left font-bold">区分</th>
              <th className="px-3 py-2 text-left font-bold">人員（アサイン / 依頼）</th>
              <th className="px-3 py-2 text-right font-bold">受注</th>
              <th className="px-3 py-2 text-right font-bold">発注</th>
              <th className="px-3 py-2 text-right font-bold">粗利</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const d = dateLabel(r.date);
              return (
                <tr
                  key={r.id}
                  className={`border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 ${
                    r.status === "CANCELLED" ? "text-zinc-400" : ""
                  }`}
                >
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    <span className="font-semibold">{d.text}</span>
                    <span className={`ml-1 text-xs ${d.isRest ? "text-rose-500" : "text-zinc-400"}`}>
                      ({d.wd})
                    </span>
                    {d.holiday && (
                      <span className="ml-1 text-[10px] text-rose-400">{d.holiday}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: r.clientColor }}
                      />
                      {r.clientName}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-zinc-600">{r.venueName ?? "—"}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {r.kind === "SETUP" && <Badge variant="outline">設営</Badge>}
                      <Badge variant={STATUS_VARIANT[r.status]}>{SHOOT_STATUS_LABEL[r.status]}</Badge>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setDrawerId(r.id)}
                      className="flex flex-wrap items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-emerald-50"
                      title="人員の割り当てを開く"
                    >
                      {KYOPRO_ROLES.map((role) => {
                        const req = r.required[role] ?? 0;
                        const asg = r.assigned[role] ?? 0;
                        if (req === 0 && asg === 0) return null;
                        const short = asg < req;
                        const st = ROLE_STYLE[role];
                        return (
                          <span
                            key={role}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.bg} ${st.border} ${st.text}`}
                            title={r.staff
                              .filter((s) => s.role === role)
                              .map((s) => s.name)
                              .join("、")}
                          >
                            {ROLE_LABEL[role]}
                            <span className={`tabular-nums ${short ? "text-rose-600" : ""}`}>
                              {asg}
                              {req > 0 && `/${req}`}
                            </span>
                          </span>
                        );
                      })}
                      {r.shortage > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-600">
                          <AlertTriangle className="h-3 w-3" />
                          不足 {r.shortage}
                        </span>
                      )}
                      {r.staff.length === 0 && r.shortage === 0 && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                          <Users className="h-3 w-3" />
                          未割り当て
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatJPY(r.bill)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{formatJPY(r.pay)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-700">
                    {formatJPY(r.bill - r.pay)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setEditing(r)}
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-700"
                          title="編集"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() =>
                            setCreating({
                              clientId: r.clientId,
                              venueId: r.venueId,
                              kind: r.kind,
                              required: r.required,
                              startTime: r.startTime,
                              endTime: r.endTime,
                            })
                          }
                          className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-700"
                          title="この内容で別日を作る"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-400">
                  該当する撮影会がありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerId && (
        <ShootDrawer shootId={drawerId} canEdit={canEdit} onClose={() => setDrawerId(null)} />
      )}

      {(editing || creating) && (
        <ShootDialog
          row={editing}
          preset={creating ?? undefined}
          clients={clients}
          venues={venues}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
        />
      )}
    </div>
  );
}

function ShootDialog({
  row,
  preset,
  clients,
  venues,
  onClose,
}: {
  row: ShootRow | null;
  preset?: Partial<ShootRow>;
  clients: MasterOption[];
  venues: MasterOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const base = row ?? preset ?? {};
  const [date, setDate] = useState(row?.date ?? "");
  const [kind, setKind] = useState<"SHOOT" | "SETUP">(base.kind ?? "SHOOT");
  const [clientId, setClientId] = useState(base.clientId ?? clients[0]?.id ?? "");
  const [venueId, setVenueId] = useState(base.venueId ?? "");
  const [status, setStatus] = useState(row?.status ?? "PLANNED");
  const [required, setRequired] = useState<Record<string, string>>(() => {
    const src = base.required ?? {};
    return Object.fromEntries(KYOPRO_ROLES.map((r) => [r, src[r] ? String(src[r]) : ""]));
  });
  const [startTime, setStartTime] = useState(base.startTime ?? "");
  const [endTime, setEndTime] = useState(base.endTime ?? "");
  const [note, setNote] = useState(row?.note ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const counts: Record<string, number> = {};
    for (const r of KYOPRO_ROLES) {
      const n = Number(required[r]);
      if (Number.isFinite(n) && n > 0) counts[r] = n;
    }
    const body = {
      date,
      kind,
      clientId,
      venueId: venueId || null,
      status,
      requiredCounts: counts,
      startTime: startTime || null,
      endTime: endTime || null,
      note: note || null,
    };
    start(async () => {
      const res = await fetch(row ? `/api/kyopro/shoots/${row.id}` : "/api/kyopro/shoots", {
        method: row ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? "保存に失敗しました");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function remove() {
    if (!row) return;
    if (!confirm("この撮影会を削除しますか？\nアサインが入っている場合は削除せず「中止」にします。")) return;
    start(async () => {
      const res = await fetch(`/api/kyopro/shoots/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "削除に失敗しました");
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{row ? "撮影会を編集" : "撮影会を追加"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">日付</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">区分</Label>
              <div className="flex gap-1">
                {(["SHOOT", "SETUP"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    className={`h-9 flex-1 rounded-md border text-sm ${
                      kind === k
                        ? "border-emerald-600 bg-emerald-50 font-semibold text-emerald-700"
                        : "border-zinc-200 bg-white text-zinc-600"
                    }`}
                  >
                    {SHOOT_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">クライアント（呉服店）</Label>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
              >
                <option value="">選択してください</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">会場（任意）</Label>
              <select
                value={venueId ?? ""}
                onChange={(e) => setVenueId(e.target.value)}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
              >
                <option value="">未設定（クライアント店舗など）</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">依頼人数（京プロからの依頼）</Label>
            <div className="grid grid-cols-4 gap-2">
              {KYOPRO_ROLES.map((r) => {
                const st = ROLE_STYLE[r];
                return (
                  <div key={r} className={`rounded-lg border px-2 py-1.5 ${st.bg} ${st.border}`}>
                    <div className={`text-[11px] font-bold ${st.text}`}>{ROLE_LABEL[r]}</div>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={required[r]}
                      onChange={(e) => setRequired((p) => ({ ...p, [r]: e.target.value }))}
                      placeholder="0"
                      className="w-full bg-transparent text-lg font-semibold tabular-nums outline-none"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">開始</Label>
              <Input value={startTime} onChange={(e) => setStartTime(e.target.value)} placeholder="10:00" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">終了</Label>
              <Input value={endTime} onChange={(e) => setEndTime(e.target.value)} placeholder="17:00" className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">ステータス</Label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as ShootRow["status"])}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
              >
                {Object.entries(SHOOT_STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">メモ</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="集合場所・持ち物など" className="h-9" />
          </div>

          {error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" variant="primary" disabled={pending || !date || !clientId}>
              保存
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
            {row && (
              <Button type="button" variant="ghost" onClick={remove} className="ml-auto text-red-600 hover:bg-red-50">
                <Trash2 className="h-4 w-4" />
                削除／中止
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
