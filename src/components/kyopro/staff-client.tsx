"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KYOPRO_ROLES, ROLE_LABEL, ROLE_STYLE, DEFAULT_RATES, formatJPY } from "@/lib/kyopro";
import { Plus, Pencil, UserX, RotateCcw } from "lucide-react";

export type StaffRow = {
  id: string;
  name: string;
  kana: string | null;
  phone: string | null;
  email: string | null;
  roles: string[];
  payOverrides: Record<string, number> | null;
  bankInfo: string | null;
  note: string | null;
  trainee: boolean;
  active: boolean;
  monthDays: number;
  monthPay: number;
  totalDays: number;
  totalPay: number;
};

export function StaffClient({
  rows,
  canEdit,
  isAdmin,
  monthLabel,
}: {
  rows: StaffRow[];
  canEdit: boolean;
  isAdmin: boolean;
  monthLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const visible = rows.filter((r) => showInactive || r.active);

  function toggleTrainee(row: StaffRow) {
    start(async () => {
      await fetch(`/api/kyopro/staff/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trainee: !row.trainee }),
      });
      router.refresh();
    });
  }

  function toggleActive(row: StaffRow) {
    start(async () => {
      await fetch(`/api/kyopro/staff/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !row.active }),
      });
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="accent-emerald-600"
          />
          無効な人材も表示
        </label>
        <span className="text-xs text-zinc-500">{visible.length} 名</span>
        {canEdit && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            人材を追加
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] uppercase tracking-wider text-zinc-400">
              <th className="px-3 py-2 text-left font-bold">氏名</th>
              <th className="px-3 py-2 text-left font-bold">対応職種</th>
              <th className="px-3 py-2 text-left font-bold">単価区分</th>
              <th className="px-3 py-2 text-right font-bold">{monthLabel} 稼働</th>
              <th className="px-3 py-2 text-right font-bold">{monthLabel} 支払見込</th>
              <th className="px-3 py-2 text-right font-bold">累計稼働</th>
              <th className="px-3 py-2 text-right font-bold">累計支払</th>
              <th className="px-3 py-2 text-left font-bold">個別単価</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50 ${
                  r.active ? "" : "text-zinc-400"
                }`}
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{r.name}</div>
                  {r.kana && <div className="text-[11px] text-zinc-400">{r.kana}</div>}
                  {!r.active && <Badge variant="secondary">無効</Badge>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {r.roles.map((role) => {
                      const st = ROLE_STYLE[role as keyof typeof ROLE_STYLE];
                      if (!st) return null;
                      return (
                        <span
                          key={role}
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${st.bg} ${st.border} ${st.text}`}
                        >
                          {ROLE_LABEL[role as keyof typeof ROLE_LABEL]}
                        </span>
                      );
                    })}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <button
                    disabled={!canEdit || pending}
                    onClick={() => toggleTrainee(r)}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors ${
                      r.trainee
                        ? "border-violet-400 bg-violet-50 text-violet-700"
                        : "border-zinc-200 text-zinc-500 hover:border-violet-300"
                    }`}
                    title="押すと研修中／規定（研修明け）を切り替えます。以降のアサインの既定単価が変わります（過去分はそのまま）"
                  >
                    {r.trainee ? "研修中" : "規定"}
                  </button>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.monthDays || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.monthPay ? formatJPY(r.monthPay) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">{r.totalDays}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                  {formatJPY(r.totalPay)}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-500">
                  {r.payOverrides && Object.keys(r.payOverrides).length > 0
                    ? Object.entries(r.payOverrides)
                        .map(([k, v]) => `${ROLE_LABEL[k as keyof typeof ROLE_LABEL]} ${formatJPY(v)}`)
                        .join(" / ")
                    : "—"}
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
                        onClick={() => toggleActive(r)}
                        disabled={pending}
                        className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-rose-600"
                        title={r.active ? "無効にする" : "有効に戻す"}
                      >
                        {r.active ? <UserX className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-sm text-zinc-400">
                  人材が登録されていません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <StaffDialog
          row={editing}
          isAdmin={isAdmin}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function StaffDialog({
  row,
  isAdmin,
  onClose,
}: {
  row: StaffRow | null;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(row?.name ?? "");
  const [kana, setKana] = useState(row?.kana ?? "");
  const [phone, setPhone] = useState(row?.phone ?? "");
  const [roles, setRoles] = useState<string[]>(row?.roles ?? []);
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      KYOPRO_ROLES.map((r) => [r, row?.payOverrides?.[r] ? String(row.payOverrides[r]) : ""]),
    ),
  );
  const [trainee, setTrainee] = useState(row?.trainee ?? false);
  const [bankInfo, setBankInfo] = useState(row?.bankInfo ?? "");
  const [note, setNote] = useState(row?.note ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (roles.length === 0) {
      setError("対応職種を1つ以上選んでください");
      return;
    }
    const payOverrides: Record<string, number> = {};
    for (const r of KYOPRO_ROLES) {
      const n = Number(overrides[r]);
      if (Number.isFinite(n) && n > 0) payOverrides[r] = n;
    }
    const body = {
      name,
      kana: kana || null,
      phone: phone || null,
      roles,
      payOverrides: Object.keys(payOverrides).length > 0 ? payOverrides : null,
      trainee,
      ...(isAdmin ? { bankInfo: bankInfo || null } : {}),
      note: note || null,
    };
    start(async () => {
      const res = await fetch(row ? `/api/kyopro/staff/${row.id}` : "/api/kyopro/staff", {
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

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? "人材を編集" : "人材を追加"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">氏名</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required className="h-9" placeholder="例：寒川井" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">かな（任意）</Label>
              <Input value={kana} onChange={(e) => setKana(e.target.value)} className="h-9" />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">対応職種</Label>
            <div className="flex flex-wrap gap-2">
              {KYOPRO_ROLES.map((r) => {
                const on = roles.includes(r);
                const st = ROLE_STYLE[r];
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      setRoles((p) => (on ? p.filter((x) => x !== r) : [...p, r]))
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                      on ? `${st.bg} ${st.border} ${st.text}` : "border-zinc-200 bg-white text-zinc-400"
                    }`}
                  >
                    {ROLE_LABEL[r]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">単価区分</Label>
            <div className="flex gap-2">
              {[
                { v: false, label: "規定（研修明け）" },
                { v: true, label: "研修中" },
              ].map((o) => (
                <button
                  key={String(o.v)}
                  type="button"
                  onClick={() => setTrainee(o.v)}
                  className={`h-9 flex-1 rounded-md border text-sm ${
                    trainee === o.v
                      ? "border-violet-500 bg-violet-50 font-semibold text-violet-700"
                      : "border-zinc-200 bg-white text-zinc-600"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-400">
              これから作るアサインの既定になります。過去の稼働は当時の区分のまま残ります。
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">個別の発注単価（空欄ならレートマスタの既定値）</Label>
            <div className="grid grid-cols-4 gap-2">
              {KYOPRO_ROLES.map((r) => (
                <div key={r} className="rounded-lg border border-zinc-200 px-2 py-1.5">
                  <div className="text-[11px] text-zinc-500">{ROLE_LABEL[r]}</div>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={overrides[r]}
                    onChange={(e) => setOverrides((p) => ({ ...p, [r]: e.target.value }))}
                    placeholder={String(DEFAULT_RATES[r].payRateDefault)}
                    className="w-full bg-transparent text-sm tabular-nums outline-none"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">連絡先（任意）</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-9" placeholder="090-..." />
            </div>
            {isAdmin && (
              <div className="space-y-1">
                <Label className="text-xs">振込先（管理者のみ）</Label>
                <Input value={bankInfo} onChange={(e) => setBankInfo(e.target.value)} className="h-9" placeholder="○○銀行 ○○支店 普通..." />
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs">メモ</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-9" />
          </div>

          {error && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" disabled={pending || !name}>
              保存
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              キャンセル
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
