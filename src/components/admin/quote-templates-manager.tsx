"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, Save, Trash2, X, FileText } from "lucide-react";
import { calculateQuote, type QuoteTaxCategory } from "@/lib/quote-calculation";

/**
 * T17: 見積テンプレート管理（管理者画面）
 *
 * 「テンプレートの新規作成はできない？」への回答として、明細付きの雛形をここで保守する。
 * 削除は既定で「非表示（active=false）」。完全削除は別ボタンにして誤操作で資産を失わないようにする。
 */

export type TemplateLineRow = {
  name: string;
  detail: string | null;
  qty: number;
  unit: string;
  unitPrice: number;
  taxCategory: QuoteTaxCategory;
  taxRate: number;
};

export type TemplateRow = {
  id: string;
  name: string;
  productId: string | null;
  planName: string | null;
  active: boolean;
  sortOrder: number;
  lines: TemplateLineRow[];
};

type ProductOption = { id: string; name: string };

const blankLine = (): TemplateLineRow => ({
  name: "", detail: "", qty: 1, unit: "式", unitPrice: 0, taxCategory: "taxable", taxRate: 10,
});

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/** 明細の合計（表示用）。サーバー計算と同じ関数を使う。 */
function totalsOf(lines: TemplateLineRow[]) {
  return calculateQuote(lines.map((l) => ({ ...l, detail: l.detail ?? null })));
}

export function QuoteTemplatesManager({
  initial,
  products,
}: {
  initial: TemplateRow[];
  products: ProductOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showInactive, setShowInactive] = useState(true);
  // 完全削除の確認（ブロッキングダイアログは使わず、行内で二段構えにする）
  const [confirmHardId, setConfirmHardId] = useState<string | null>(null);

  // 編集中／新規作成中のフォーム
  const [form, setForm] = useState<TemplateRow>({
    id: "", name: "", productId: null, planName: null, active: true, sortOrder: 0, lines: [blankLine()],
  });

  const visible = showInactive ? initial : initial.filter((t) => t.active);

  function notify(text: string) {
    setMsg(text);
    setError(null);
    setTimeout(() => setMsg(null), 3500);
  }

  function startAdd() {
    setForm({ id: "", name: "", productId: null, planName: null, active: true, sortOrder: initial.length, lines: [blankLine()] });
    setEditingId(null);
    setAdding(true);
    setError(null);
  }

  function startEdit(t: TemplateRow) {
    setForm({ ...t, lines: t.lines.length ? t.lines.map((l) => ({ ...l })) : [blankLine()] });
    setAdding(false);
    setEditingId(t.id);
    setError(null);
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setError(null);
  }

  function setLine(index: number, patch: Partial<TemplateLineRow>) {
    setForm((f) => ({ ...f, lines: f.lines.map((l, i) => (i === index ? { ...l, ...patch } : l)) }));
  }
  function addLine() {
    setForm((f) => ({ ...f, lines: [...f.lines, blankLine()] }));
  }
  function removeLine(index: number) {
    setForm((f) => ({ ...f, lines: f.lines.length > 1 ? f.lines.filter((_, i) => i !== index) : f.lines }));
  }
  /** 並べ替え（ドラッグは使わず上下ボタンで。行数が少ないのでこれで足りる） */
  function moveLine(index: number, delta: number) {
    setForm((f) => {
      const next = [...f.lines];
      const target = index + delta;
      if (target < 0 || target >= next.length) return f;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...f, lines: next };
    });
  }

  function payloadOf(f: TemplateRow) {
    return {
      name: f.name.trim(),
      productId: f.productId || null,
      planName: f.planName?.trim() || null,
      sortOrder: f.sortOrder,
      lines: f.lines
        .filter((l) => l.name.trim())
        .map((l) => ({
          name: l.name.trim(),
          detail: l.detail?.trim() || null,
          qty: Math.max(1, Math.round(l.qty)),
          unit: l.unit.trim() || "式",
          unitPrice: Math.max(0, Math.round(l.unitPrice)),
          taxCategory: l.taxCategory,
          taxRate: l.taxCategory === "non_taxable" ? 0 : l.taxRate,
        })),
    };
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = payloadOf(form);
    if (!payload.name) { setError("テンプレート名を入力してください"); return; }
    if (payload.lines.length === 0) { setError("明細を1行以上入力してください"); return; }
    start(async () => {
      const url = editingId ? `/api/quote-templates/${editingId}` : "/api/quote-templates";
      const r = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { ...payload, active: form.active } : payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "保存に失敗しました"); return; }
      notify(editingId ? "テンプレートを更新しました" : "テンプレートを作成しました");
      closeForm();
      router.refresh();
    });
  }

  function toggleActive(t: TemplateRow) {
    start(async () => {
      const r = await fetch(`/api/quote-templates/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !t.active }),
      });
      if (!r.ok) { setError("更新に失敗しました"); return; }
      notify(t.active ? "非表示にしました" : "表示に戻しました");
      router.refresh();
    });
  }

  function softDelete(t: TemplateRow) {
    start(async () => {
      const r = await fetch(`/api/quote-templates/${t.id}`, { method: "DELETE" });
      if (!r.ok) { setError("削除に失敗しました"); return; }
      notify("非表示にしました（データは残っています）");
      router.refresh();
    });
  }

  function hardDelete(t: TemplateRow) {
    start(async () => {
      const r = await fetch(`/api/quote-templates/${t.id}?hard=1`, { method: "DELETE" });
      if (!r.ok) { setError("削除に失敗しました"); return; }
      setConfirmHardId(null);
      notify("テンプレートを完全に削除しました");
      router.refresh();
    });
  }

  const formTotals = totalsOf(form.lines);

  return (
    <div className="space-y-5 text-[15px]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-zinc-600">
          {initial.length} 件 ／ 有効 {initial.filter((t) => t.active).length} 件
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {showInactive ? "非表示分を隠す" : "非表示分も表示"}
          </Button>
          {!adding && !editingId && (
            <Button variant="primary" size="sm" onClick={startAdd}>
              <Plus className="h-4 w-4" /> テンプレートを追加
            </Button>
          )}
        </div>
      </div>

      {msg && <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}
      {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {(adding || editingId) && (
        <form onSubmit={submit} className="rounded-lg border border-zinc-200 bg-white p-6 space-y-5">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-zinc-900">
              {editingId ? "テンプレートを編集" : "テンプレートを新規作成"}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={closeForm}>
              <X className="h-4 w-4" /> 閉じる
            </Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">テンプレート名</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例: 採用動画 スタンダード一式"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm">カテゴリ（任意）</Label>
                <select
                  value={form.productId ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, productId: e.target.value || null }))}
                  className="w-full h-9 rounded-md border border-zinc-300 px-2 text-sm bg-white"
                >
                  <option value="">（指定なし）</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">プラン名（任意）</Label>
                <Input
                  value={form.planName ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, planName: e.target.value }))}
                  placeholder="例: スタンダード"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-sm">表示順</Label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))}
                className="w-28"
              />
            </div>
            {editingId && (
              <div className="space-y-1.5">
                <Label className="text-sm">表示状態</Label>
                <label className="flex items-center gap-2 text-sm text-zinc-700 h-9">
                  <input
                    type="checkbox"
                    checked={form.active}
                    onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                    className="h-4 w-4 accent-orange-500"
                  />
                  商談画面のプルダウンに表示する
                </label>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm">明細</Label>
            <div className="space-y-2">
              {form.lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-start rounded-md border border-zinc-200 p-3">
                  <div className="col-span-12 md:col-span-4 space-y-1">
                    <Input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} placeholder="品目" />
                    <Input value={l.detail ?? ""} onChange={(e) => setLine(i, { detail: e.target.value })} placeholder="補足（任意）" className="text-xs" />
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <Input type="number" min={1} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) })} placeholder="数量" />
                  </div>
                  <div className="col-span-3 md:col-span-1">
                    <Input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="単位" />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <Input type="number" min={0} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })} placeholder="単価(税抜)" />
                  </div>
                  <div className="col-span-6 md:col-span-2">
                    <select
                      value={l.taxCategory}
                      onChange={(e) => setLine(i, { taxCategory: e.target.value as QuoteTaxCategory, taxRate: e.target.value === "non_taxable" ? 0 : 10 })}
                      className="w-full h-9 rounded-md border border-zinc-300 px-1 text-xs bg-white"
                    >
                      <option value="taxable">課税10%</option>
                      <option value="non_taxable">不課税</option>
                    </select>
                  </div>
                  <div className="col-span-6 md:col-span-2 flex items-center justify-end gap-1 pt-1">
                    <span className="text-xs text-zinc-500 mr-1">{yen(l.qty * l.unitPrice)}</span>
                    <button type="button" onClick={() => moveLine(i, -1)} disabled={i === 0} className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" title="上へ移動" aria-label="上へ移動">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => moveLine(i, 1)} disabled={i === form.lines.length - 1} className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30" title="下へ移動" aria-label="下へ移動">
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => removeLine(i)} className="text-zinc-300 hover:text-red-500" title="行を削除" aria-label="行を削除">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={addLine}>
              <Plus className="h-4 w-4" /> 明細を追加
            </Button>
          </div>

          <div className="rounded-md bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-right">
            <div className="text-zinc-600">小計 {yen(formTotals.subtotal)}　消費税 {yen(formTotals.taxTotal)}</div>
            {formTotals.nonTaxableBase > 0 && <div className="text-zinc-500 text-xs">不課税対象 {yen(formTotals.nonTaxableBase)}</div>}
            <div className="font-bold text-zinc-900">合計 {yen(formTotals.grandTotal)}（税込）</div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={closeForm}>キャンセル</Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              <Save className="h-4 w-4" /> {editingId ? "更新する" : "作成する"}
            </Button>
          </div>
        </form>
      )}

      {visible.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500">
          テンプレートはまだありません。「テンプレートを追加」から作成できます。
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((t) => {
            const totals = totalsOf(t.lines);
            const product = products.find((p) => p.id === t.productId);
            return (
              <li key={t.id} className={`rounded-lg border border-zinc-200 bg-white p-5 ${t.active ? "" : "opacity-70"}`}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <FileText className="h-4 w-4 text-orange-500 shrink-0" />
                      <p className="font-semibold text-zinc-900">{t.name}</p>
                      <Badge variant={t.active ? "success" : "secondary"} className="text-[10px]">
                        {t.active ? "表示" : "非表示"}
                      </Badge>
                      {product && <Badge variant="outline" className="text-[10px]">{product.name}</Badge>}
                      {t.planName && <Badge variant="outline" className="text-[10px]">{t.planName}</Badge>}
                    </div>
                    <p className="mt-1.5 text-sm text-zinc-500">
                      明細 {t.lines.length} 行 ／ 小計 {yen(totals.subtotal)} ／ 消費税 {yen(totals.taxTotal)} ／ 合計 {yen(totals.grandTotal)}（税込）
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => startEdit(t)} disabled={pending}>編集</Button>
                    <Button variant="ghost" size="sm" onClick={() => toggleActive(t)} disabled={pending}>
                      {t.active ? "非表示にする" : "表示に戻す"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => softDelete(t)} disabled={pending || !t.active}>
                      削除
                    </Button>
                  </div>
                </div>

                {t.lines.length > 0 && (
                  <ul className="mt-3 border-t border-zinc-100 pt-3 space-y-1">
                    {t.lines.map((l, i) => (
                      <li key={i} className="grid grid-cols-[1fr_auto] gap-3 text-sm text-zinc-600">
                        <span className="truncate">
                          {l.name}
                          {l.detail && <span className="text-xs text-zinc-400">（{l.detail}）</span>}
                          {l.taxCategory === "non_taxable" && <span className="ml-1 text-xs text-zinc-400">不課税</span>}
                        </span>
                        <span className="tabular-nums text-zinc-500">
                          {l.qty}{l.unit} × {yen(l.unitPrice)} = {yen(l.qty * l.unitPrice)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-3 border-t border-zinc-100 pt-3">
                  {confirmHardId === t.id ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                      <p>「{t.name}」を完全に削除します。明細も一緒に消え、元に戻せません。</p>
                      <div className="mt-2 flex gap-2">
                        <Button variant="destructive" size="sm" onClick={() => hardDelete(t)} disabled={pending}>完全に削除する</Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmHardId(null)}>やめる</Button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmHardId(t.id)}
                      className="text-xs text-zinc-400 hover:text-red-600"
                    >
                      完全に削除（元に戻せません）
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
