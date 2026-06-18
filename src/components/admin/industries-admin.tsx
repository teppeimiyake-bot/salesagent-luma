"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Save, X, Pencil, Tag } from "lucide-react";

type Industry = {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
};

export function IndustriesAdmin({ initial }: { initial: Industry[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("");

  function resetNew() {
    setName("");
    setSortOrder("");
    setAdding(false);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch("/api/industries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sortOrder: sortOrder ? Number(sortOrder) : initial.length + 1,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      resetNew();
      router.refresh();
    });
  }

  function remove(s: Industry) {
    if (!confirm(`「${s.name}」を削除しますか？\n（使用中の場合は自動的に無効化されます）`)) return;
    start(async () => {
      const r = await fetch(`/api/industries/${s.id}`, { method: "DELETE" });
      const j = await r.json();
      if (j.message) alert(j.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">
          {initial.length} 件 ／ 会社情報・商談ページの業種ピッカーの選択肢になります
        </p>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            業種を追加
          </Button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={add}
          className="space-y-3 p-4 rounded-lg bg-emerald-50/40 border border-emerald-200"
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1 md:col-span-2">
              <Label className="text-sm">業種名</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：物流・運輸"
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">並び順</Label>
              <Input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                placeholder={String(initial.length + 1)}
              />
            </div>
          </div>
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={resetNew}>
              <X className="h-3.5 w-3.5" />
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending || !name}>
              <Save className="h-3.5 w-3.5" />
              保存
            </Button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {initial.map((s) => (
          <IndustryCard
            key={s.id}
            industry={s}
            isEditing={editingId === s.id}
            onEdit={() => setEditingId(s.id)}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null);
              router.refresh();
            }}
            onDelete={() => remove(s)}
            pending={pending}
          />
        ))}
      </div>
    </div>
  );
}

function IndustryCard({
  industry,
  isEditing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
  pending,
}: {
  industry: Industry;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(industry.name);
  const [sortOrder, setSortOrder] = useState(String(industry.sortOrder));
  const [active, setActive] = useState(industry.active);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/industries/${industry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        sortOrder: Number(sortOrder) || 0,
        active,
      }),
    });
    setSaving(false);
    onSaved();
  }

  if (isEditing) {
    return (
      <form
        onSubmit={save}
        className="rounded-lg border border-emerald-300 bg-emerald-50/40 p-4 space-y-2"
      >
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1 col-span-2">
            <Label className="text-xs">業種名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required className="h-8" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">並び順</Label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="h-8"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            有効（選択肢に表示）
          </label>
          <div className="flex gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              <X className="h-3 w-3" />
              キャンセル
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              <Save className="h-3 w-3" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-bold border bg-emerald-50 text-emerald-700 border-emerald-200">
              <Tag className="h-3 w-3" />
              {industry.name}
            </span>
            {!industry.active && <Badge variant="secondary">無効</Badge>}
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            並び順: <span className="font-mono">{industry.sortOrder}</span>
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            disabled={pending}
            className="text-zinc-400 hover:text-emerald-600"
            title="編集"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={pending}
            className="text-zinc-300 hover:text-red-500"
            title="削除"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
