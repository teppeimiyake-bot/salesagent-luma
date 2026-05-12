"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Save, X, Pencil, Film } from "lucide-react";
import {
  planProposalColorClass,
  planProposalCategory,
  PLAN_PROPOSAL_COLOR_OPTIONS,
} from "@/lib/plan-proposal";

type PlanProposal = {
  id: string;
  name: string;
  color: string;
  displayOrder: number;
  active: boolean;
};

function ColorPreview({ color, name }: { color: string; name: string }) {
  const c = planProposalColorClass(color);
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text} ${c.border}`}>
      {name}
    </span>
  );
}

export function PlanProposalsAdmin({ initial }: { initial: PlanProposal[] }) {
  const router = useRouter();
  const [items, setItems] = useState<PlanProposal[]>(initial);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState("default");
  const [displayOrder, setDisplayOrder] = useState("");

  function resetNew() {
    setName("");
    setColor("default");
    setDisplayOrder("");
    setAdding(false);
    setError(null);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fetch("/api/plan-proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          color,
          displayOrder: displayOrder ? Number(displayOrder) : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "追加に失敗しました");
        return;
      }
      setItems((arr) => [...arr, j.planProposal].sort((a, b) => a.displayOrder - b.displayOrder));
      resetNew();
      router.refresh();
    });
  }

  function remove(p: PlanProposal) {
    if (!confirm(`「${p.name}」を削除しますか？\n（既存商談に付いたタグはそのまま残ります。色だけ無彩になります）`)) return;
    start(async () => {
      const r = await fetch(`/api/plan-proposals/${p.id}`, { method: "DELETE" });
      if (r.ok) {
        setItems((arr) => arr.filter((x) => x.id !== p.id));
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">
          {items.length} 件 ／ 商談詳細「映像」プロダクトの企画提案マルチセレクトに表示されます
        </p>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            企画提案を追加
          </Button>
        )}
      </div>

      {adding && (
        <form onSubmit={add} className="space-y-3 p-4 rounded-lg bg-orange-50/40 border border-orange-200">
          <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="space-y-1 md:col-span-3">
              <Label className="text-sm">名前（角括弧【】付きの完全一致文字列を推奨）</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：【採用】ドラマ風動画"
                required
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label className="text-sm">色</Label>
              <Select value={color} onValueChange={setColor}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_PROPOSAL_COLOR_OPTIONS.map((o) => {
                    const c = planProposalColorClass(o.value);
                    return (
                      <SelectItem key={o.value} value={o.value}>
                        <span className={`inline-block px-2 py-0.5 rounded text-xs ${c.bg} ${c.text}`}>{o.label}</span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 md:col-span-1">
              <Label className="text-sm">並び順</Label>
              <Input
                type="number"
                value={displayOrder}
                onChange={(e) => setDisplayOrder(e.target.value)}
                placeholder="末尾"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-500">プレビュー：</span>
            <ColorPreview color={color} name={name || "（名前）"} />
            {name && (
              <Badge variant="outline" className="text-[10px]">
                カテゴリ: {planProposalCategory(name)}
              </Badge>
            )}
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
        {items.map((p) => (
          <PlanProposalCard
            key={p.id}
            item={p}
            isEditing={editingId === p.id}
            onEdit={() => setEditingId(p.id)}
            onCancel={() => setEditingId(null)}
            onSaved={(updated) => {
              setItems((arr) =>
                arr.map((x) => (x.id === updated.id ? updated : x)).sort((a, b) => a.displayOrder - b.displayOrder),
              );
              setEditingId(null);
              router.refresh();
            }}
            onDelete={() => remove(p)}
            pending={pending}
          />
        ))}
        {items.length === 0 && (
          <p className="text-xs text-zinc-400 px-2 py-3 col-span-full">
            企画提案がまだありません。「企画提案を追加」から登録してください（初期13種は scripts/seed-plan-proposals.ts で投入できます）。
          </p>
        )}
      </div>
    </div>
  );
}

function PlanProposalCard({
  item,
  isEditing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
  pending,
}: {
  item: PlanProposal;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (updated: PlanProposal) => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const [name, setName] = useState(item.name);
  const [color, setColor] = useState(item.color);
  const [displayOrder, setDisplayOrder] = useState(String(item.displayOrder));
  const [active, setActive] = useState(item.active);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await fetch(`/api/plan-proposals/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        color,
        displayOrder: Number(displayOrder) || 0,
        active,
      }),
    });
    const j = await r.json();
    setSaving(false);
    if (j.planProposal) onSaved(j.planProposal);
  }

  if (isEditing) {
    return (
      <form onSubmit={save} className="rounded-lg border border-orange-300 bg-orange-50/40 p-3 space-y-2">
        <div className="space-y-1">
          <Label className="text-xs">名前</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} required className="h-8" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1 col-span-2">
            <Label className="text-xs">色</Label>
            <Select value={color} onValueChange={setColor}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_PROPOSAL_COLOR_OPTIONS.map((o) => {
                  const c = planProposalColorClass(o.value);
                  return (
                    <SelectItem key={o.value} value={o.value}>
                      <span className={`inline-block px-2 py-0.5 rounded text-xs ${c.bg} ${c.text}`}>{o.label}</span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">並び順</Label>
            <Input type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} className="h-8" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">プレビュー：</span>
          <ColorPreview color={color} name={name || "（名前）"} />
        </div>
        <div className="flex items-center justify-between">
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
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
    <div className="rounded-lg border border-zinc-200 bg-white p-3 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1">
              <Film className="h-3 w-3" />
            </span>
            <ColorPreview color={item.color} name={item.name} />
            {!item.active && <Badge variant="secondary">無効</Badge>}
          </div>
          <p className="text-[10px] text-zinc-500 mt-1.5">
            並び順: <span className="font-mono">{item.displayOrder}</span> ／ カテゴリ: {planProposalCategory(item.name)} ／ 色: {item.color}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onEdit} disabled={pending} className="text-zinc-400 hover:text-orange-600" title="編集">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button onClick={onDelete} disabled={pending} className="text-zinc-300 hover:text-red-500" title="削除">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
