"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Save, X, Pencil, Package, Layers, GripVertical } from "lucide-react";
import { formatJPY } from "@/lib/utils";

export type ProductPlanRow = {
  id: string;
  name: string;
  basePrice: number | null;
  description: string | null;
  sortOrder: number;
  active: boolean;
};

export type ProductWithPlans = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  active: boolean;
  plans: ProductPlanRow[];
};

export function ProductsAdmin({ initial }: { initial: ProductWithPlans[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 新規追加フォーム（カテゴリ＋初期プラン）
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draftPlans, setDraftPlans] = useState<{ name: string; basePrice: string }[]>([
    { name: "", basePrice: "" },
  ]);

  function resetNew() {
    setName("");
    setDescription("");
    setDraftPlans([{ name: "", basePrice: "" }]);
    setAdding(false);
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validPlans = draftPlans
      .filter((p) => p.name.trim())
      .map((p, i) => ({
        name: p.name.trim(),
        basePrice: p.basePrice ? Number(p.basePrice) : null,
        sortOrder: i,
      }));
    start(async () => {
      const r = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          plans: validPlans,
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

  function remove(id: string) {
    if (!confirm("削除しますか？（既存商談は影響なし）")) return;
    start(async () => {
      await fetch(`/api/products/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">
          {initial.length} 件のカテゴリ ／ 各カテゴリにプラン（金額付き）を登録
        </p>
        {!adding && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" />
            カテゴリ追加
          </Button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={add}
          className="space-y-3 p-4 rounded-lg bg-orange-50/40 border border-orange-200"
        >
          <div className="space-y-1">
            <Label className="text-sm">カテゴリ名</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例: 映像 / SNS / CATV / アライアンス" />
          </div>
          <div className="space-y-1">
            <Label className="text-sm">説明（任意）</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm inline-flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-orange-600" /> 初期プラン（後から追加・編集できます）
            </Label>
            <div className="space-y-2">
              {draftPlans.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input
                    placeholder="プラン名（例: ベーシック）"
                    value={p.name}
                    onChange={(e) => {
                      const next = [...draftPlans];
                      next[i] = { ...next[i], name: e.target.value };
                      setDraftPlans(next);
                    }}
                    className="h-9 flex-1"
                  />
                  <Input
                    placeholder="ベース価格（円）"
                    type="number"
                    value={p.basePrice}
                    onChange={(e) => {
                      const next = [...draftPlans];
                      next[i] = { ...next[i], basePrice: e.target.value };
                      setDraftPlans(next);
                    }}
                    className="h-9 w-44"
                  />
                  {draftPlans.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setDraftPlans(draftPlans.filter((_, idx) => idx !== i))}
                      className="h-9 w-9 text-zinc-400 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDraftPlans([...draftPlans, { name: "", basePrice: "" }])
                }
                className="text-orange-600"
              >
                <Plus className="h-3.5 w-3.5" />
                プラン追加
              </Button>
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

      {/* カテゴリ一覧（カード） */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {initial.map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            isEditing={editingId === p.id}
            onEdit={() => setEditingId(p.id)}
            onCancel={() => setEditingId(null)}
            onSaved={() => {
              setEditingId(null);
              router.refresh();
            }}
            onDelete={() => remove(p.id)}
            pending={pending}
          />
        ))}
      </div>
    </div>
  );
}

function ProductCard({
  product,
  isEditing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
  pending,
}: {
  product: ProductWithPlans;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [active, setActive] = useState(product.active);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: description || null,
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
        className="rounded-lg border border-orange-300 bg-orange-50/40 p-4 space-y-2"
      >
        <div className="space-y-1">
          <Label className="text-xs">カテゴリ名</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="h-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">説明</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div className="flex items-center justify-between">
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            有効（商談新規作成の選択肢に表示）
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
        <PlanList
          productId={product.id}
          plans={product.plans}
          pending={pending}
          onChanged={() => router.refresh()}
        />
      </form>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 hover:shadow-sm transition-shadow space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1">
              <Package className="h-3.5 w-3.5" />
            </span>
            <p className="font-bold text-base">{product.name}</p>
            {!product.active && <Badge variant="secondary">無効</Badge>}
          </div>
          {product.description && (
            <p className="text-sm text-zinc-600 mt-1 whitespace-pre-wrap">
              {product.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            disabled={pending}
            className="text-zinc-400 hover:text-orange-600"
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
      <PlanList
        productId={product.id}
        plans={product.plans}
        pending={pending}
        onChanged={() => router.refresh()}
      />
    </div>
  );
}

/**
 * プラン一覧（インライン編集）
 * - 各行: プラン名 / ベース価格 / 削除
 * - 末尾に「プラン追加」入力行
 */
function PlanList({
  productId,
  plans,
  pending,
  onChanged,
}: {
  productId: string;
  plans: ProductPlanRow[];
  pending: boolean;
  onChanged: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [adding, setAdding] = useState(false);

  async function addPlan() {
    if (!newName.trim()) return;
    setAdding(true);
    await fetch(`/api/products/${productId}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newName.trim(),
        basePrice: newPrice ? Number(newPrice) : null,
      }),
    });
    setAdding(false);
    setNewName("");
    setNewPrice("");
    onChanged();
  }

  return (
    <div className="space-y-1.5 pt-2 border-t border-zinc-100">
      <div className="text-[11px] font-bold text-zinc-500 inline-flex items-center gap-1">
        <Layers className="h-3 w-3 text-orange-500" /> プラン × ベース価格
        <span className="text-zinc-400 font-normal">（{plans.length}件）</span>
      </div>
      {plans.length === 0 && (
        <p className="text-xs text-zinc-400 italic">プランがまだありません</p>
      )}
      <div className="space-y-1">
        {plans.map((pl) => (
          <PlanRow key={pl.id} plan={pl} pending={pending} onChanged={onChanged} />
        ))}
      </div>
      <div className="flex gap-1.5 pt-1">
        <Input
          placeholder="プラン名"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="h-7 text-xs flex-1"
        />
        <Input
          placeholder="価格"
          type="number"
          value={newPrice}
          onChange={(e) => setNewPrice(e.target.value)}
          className="h-7 text-xs w-28 text-right tabular-nums"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={addPlan}
          disabled={adding || !newName.trim()}
          className="h-7 px-2 text-orange-600 hover:bg-orange-50"
        >
          <Plus className="h-3 w-3" />
          追加
        </Button>
      </div>
    </div>
  );
}

function PlanRow({
  plan,
  pending,
  onChanged,
}: {
  plan: ProductPlanRow;
  pending: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const [price, setPrice] = useState(plan.basePrice == null ? "" : String(plan.basePrice));
  const [editing, setEditing] = useState(false);

  async function commit() {
    if (name === plan.name && (price === "" ? null : Number(price)) === plan.basePrice) {
      setEditing(false);
      return;
    }
    await fetch(`/api/product-plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        basePrice: price === "" ? null : Number(price),
      }),
    });
    setEditing(false);
    onChanged();
  }

  async function remove() {
    if (!confirm(`プラン「${plan.name}」を削除しますか？`)) return;
    await fetch(`/api/product-plans/${plan.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="flex items-center gap-1.5 group">
      <GripVertical className="h-3 w-3 text-zinc-300 shrink-0" />
      {editing ? (
        <>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-7 text-xs flex-1"
          />
          <Input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="h-7 text-xs w-28 text-right tabular-nums"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={commit}
            disabled={pending}
            className="h-7 px-2 text-orange-600 hover:bg-orange-50"
          >
            <Save className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setName(plan.name);
              setPrice(plan.basePrice == null ? "" : String(plan.basePrice));
              setEditing(false);
            }}
            className="h-7 px-2 text-zinc-400"
          >
            <X className="h-3 w-3" />
          </Button>
        </>
      ) : (
        <>
          <span className="text-xs font-semibold flex-1 truncate" title={plan.name}>
            {plan.name}
          </span>
          <span className="text-xs tabular-nums text-zinc-600">
            {plan.basePrice != null ? formatJPY(plan.basePrice) : <span className="text-zinc-300">価格未設定</span>}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-zinc-300 hover:text-orange-600 opacity-0 group-hover:opacity-100"
            title="編集"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={remove}
            className="text-zinc-300 hover:text-red-500 opacity-0 group-hover:opacity-100"
            title="削除"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}
