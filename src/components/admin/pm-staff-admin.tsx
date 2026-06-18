"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Save, X, Pencil, RotateCcw } from "lucide-react";

export type PmStaffRow = {
  id: string;
  role: string;
  name: string;
  active: boolean;
  sortOrder: number;
};

const ROLE_LABEL: Record<string, string> = {
  pm: "PM担当",
  director: "ディレクター",
  camera: "カメラ",
  editor: "編集",
};
const ROLES = ["pm", "director", "camera", "editor"] as const;

export function PmStaffAdmin({ initial }: { initial: PmStaffRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="space-y-8">
      {ROLES.map((role) => (
        <RoleSection
          key={role}
          role={role}
          label={ROLE_LABEL[role]}
          rows={initial.filter((s) => s.role === role)}
          pending={pending}
          start={start}
          onChanged={() => router.refresh()}
        />
      ))}
    </div>
  );
}

function RoleSection({
  role,
  label,
  rows,
  pending,
  start,
  onChanged,
}: {
  role: string;
  label: string;
  rows: PmStaffRow[];
  pending: boolean;
  start: (cb: () => Promise<void> | void) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch("/api/pm-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, name, sortOrder: rows.length + 1 }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      setName("");
      setAdding(false);
      onChanged();
    });
  }

  function toggleActive(s: PmStaffRow) {
    start(async () => {
      await fetch(`/api/pm-staff/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !s.active }),
      });
      onChanged();
    });
  }

  function remove(s: PmStaffRow) {
    if (!confirm(`「${s.name}」を選択肢から外しますか？\n（既存案件の表示値は維持されます）`)) return;
    start(async () => {
      await fetch(`/api/pm-staff/${s.id}`, { method: "DELETE" });
      onChanged();
    });
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-800">
          {label}
          <span className="ml-2 text-xs font-normal text-zinc-400">{rows.length} 名</span>
        </h3>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            追加
          </Button>
        )}
      </div>

      {adding && (
        <form onSubmit={add} className="mb-3 flex items-end gap-2 rounded-md bg-emerald-50/40 border border-emerald-200 p-3">
          <div className="flex-1 space-y-1">
            <Label className="text-xs">{label}の名前</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：山田太郎 / 外注カメラA"
              required
              className="h-8"
            />
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={pending || !name}>
            <Save className="h-3.5 w-3.5" />
            保存
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setAdding(false);
              setName("");
              setError(null);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </form>
      )}
      {error && <p className="mb-2 text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}

      {rows.length === 0 ? (
        <p className="text-xs text-zinc-400">まだ登録がありません。「追加」から人員を登録してください。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map((s) =>
            editingId === s.id ? (
              <EditChip
                key={s.id}
                row={s}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  onChanged();
                }}
              />
            ) : (
              <div
                key={s.id}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${
                  s.active
                    ? "border-zinc-200 bg-white text-zinc-700"
                    : "border-zinc-200 bg-zinc-50 text-zinc-400"
                }`}
              >
                <span>{s.name}</span>
                {!s.active && <Badge variant="secondary">無効</Badge>}
                <button
                  onClick={() => setEditingId(s.id)}
                  disabled={pending}
                  className="text-zinc-400 hover:text-emerald-600"
                  title="名前を編集"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {s.active ? (
                  <button
                    onClick={() => remove(s)}
                    disabled={pending}
                    className="text-zinc-300 hover:text-red-500"
                    title="選択肢から外す（無効化）"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => toggleActive(s)}
                    disabled={pending}
                    className="text-zinc-400 hover:text-emerald-600"
                    title="再度有効化"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function EditChip({
  row,
  onCancel,
  onSaved,
}: {
  row: PmStaffRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/pm-staff/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setSaving(false);
    onSaved();
  }

  return (
    <form onSubmit={save} className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50/40 px-2 py-1">
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 w-[140px] text-xs" required />
      <button type="submit" disabled={saving} className="text-emerald-600 hover:text-emerald-700" title="保存">
        <Save className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={onCancel} className="text-zinc-400 hover:text-zinc-600" title="キャンセル">
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}
