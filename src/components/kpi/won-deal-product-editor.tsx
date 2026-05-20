"use client";

/**
 * 受注企業カード（KPI月次ドリルダウン）上での、その案件のプロダクト編集UI。
 *
 * 既存 deal詳細の DealProductsPanel と同じ API・同じ受注ロジックに揃える：
 *   - 追加  : POST   /api/deals/[id]/products  （カテゴリ＋プラン選択 → DealProduct 作成）
 *   - 変更  : PATCH  /api/deal-products/[id]    （カテゴリ/プラン/ヨミ差し替え）
 *   - 金額  : PATCH  /api/deal-products/[id]    （amount 修正）
 *   - 削除  : DELETE /api/deal-products/[id]
 *
 * 受注金額（wonAmount）は yomiStatus が「受注/締結済み」の DealProduct.amount 合計（isWonProduct）。
 * 編集後は router.refresh() で KPI 集計（受注金額/件数/カード）を再取得して即反映する。
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Package, Check, X, Loader2 } from "lucide-react";
import { formatJPY } from "@/lib/utils";
import {
  YOMI_OPTIONS,
  YOMI_TO_PROBABILITY,
  isWonProduct,
  yomiColor,
} from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";
import type { WonDealEditableProduct } from "@/lib/queries";

export type KpiProductPlanMaster = {
  id: string;
  name: string;
  basePrice: number | null;
};
export type KpiProductMaster = {
  id: string;
  name: string;
  category: string | null;
  plans: KpiProductPlanMaster[];
};

type Row = WonDealEditableProduct;

export function WonDealProductEditor({
  dealId,
  initial,
  products,
  canEdit,
  onLocalWonAmountChange,
}: {
  dealId: string;
  initial: Row[];
  products: KpiProductMaster[];
  canEdit: boolean;
  /** ローカル受注金額が変わったらカードのバッジを楽観的に更新するため親へ通知 */
  onLocalWonAmountChange?: (wonAmount: number) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [items, setItems] = useState<Row[]>(initial);
  const [adding, setAdding] = useState(false);

  // initial（サーバー再取得後の最新）が変わったらローカルも同期
  useEffect(() => {
    setItems(initial);
  }, [initial]);

  const localWonAmount = items
    .filter((i) => isWonProduct({ productName: i.productName, amount: i.amount, yomiStatus: i.yomiStatus }))
    .reduce((s, i) => s + (i.amount ?? 0), 0);

  useEffect(() => {
    onLocalWonAmountChange?.(localWonAmount);
  }, [localWonAmount, onLocalWonAmountChange]);

  function patchRow(
    row: Row,
    optimistic: Partial<Row>,
    apiPayload: Record<string, unknown>,
  ) {
    setItems((prev) => prev.map((i) => (i.id === row.id ? { ...i, ...optimistic } : i)));
    start(async () => {
      await fetch(`/api/deal-products/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiPayload),
      });
      router.refresh();
    });
  }

  function deleteRow(row: Row) {
    if (!confirm(`「${row.productName}」を削除しますか？（取り消せません）`)) return;
    setItems((prev) => prev.filter((i) => i.id !== row.id));
    start(async () => {
      await fetch(`/api/deal-products/${row.id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  if (!canEdit) return null;

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold text-zinc-500">プロダクト編集</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-emerald-700 hover:bg-emerald-50"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="h-3.5 w-3.5" />
          追加
        </Button>
      </div>

      {/* 既存プロダクト行（カテゴリ/プラン/ヨミ/金額 を編集） */}
      <div className="space-y-1.5">
        {items.length === 0 && !adding && (
          <p className="text-[11px] text-zinc-400 py-1">プロダクトがありません。「追加」から登録できます。</p>
        )}
        {items.map((row) => (
          <EditableRow
            key={row.id}
            row={row}
            products={products}
            pending={pending}
            onPatch={(opt, api) => patchRow(row, opt, api)}
            onDelete={() => deleteRow(row)}
          />
        ))}
      </div>

      {/* 追加フォーム */}
      {adding && (
        <AddRow
          dealId={dealId}
          products={products}
          pending={pending}
          onCancel={() => setAdding(false)}
          onAdded={(created) => {
            setItems((prev) => [...prev, created]);
            setAdding(false);
            start(() => {
              router.refresh();
            });
          }}
        />
      )}
    </div>
  );
}

function EditableRow({
  row,
  products,
  pending,
  onPatch,
  onDelete,
}: {
  row: Row;
  products: KpiProductMaster[];
  pending: boolean;
  onPatch: (optimistic: Partial<Row>, apiPayload: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const yomiC = yomiColor(stripYomiPrefix(row.yomiStatus));
  const product =
    products.find((p) => p.id === row.productId) ??
    products.find((p) => p.name === row.productName);

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 py-1.5">
      <Package className="h-3.5 w-3.5 text-orange-500 shrink-0" />

      {/* カテゴリ */}
      <Select
        value={row.productId ?? "__custom__"}
        onValueChange={(v) => {
          if (v === "__custom__") return;
          const p = products.find((x) => x.id === v);
          if (p) onPatch({ productId: p.id, productName: p.name }, { productId: p.id, productName: p.name });
        }}
      >
        <SelectTrigger className="h-7 w-[120px] text-xs">
          <SelectValue>
            <span className="block truncate text-left">{row.productName}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {products.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {!row.productId && (
            <SelectItem value="__custom__" disabled>
              （カスタム: {row.productName}）
            </SelectItem>
          )}
        </SelectContent>
      </Select>

      {/* プラン */}
      <Select
        value={row.planName ?? "__none__"}
        disabled={!product?.plans.length}
        onValueChange={(v) => {
          if (v === "__none__") {
            onPatch({ planName: null }, { planName: null });
            return;
          }
          const plan = product?.plans.find((pl) => pl.name === v);
          const optimistic: Partial<Row> = { planName: v };
          const api: Record<string, unknown> = { planName: v };
          // 金額未入力ならプランの basePrice を自動セット（既存パネルと同じ挙動）
          if (plan?.basePrice != null && (row.amount == null || row.amount === 0)) {
            optimistic.amount = plan.basePrice;
            api.amount = plan.basePrice;
          }
          onPatch(optimistic, api);
        }}
      >
        <SelectTrigger className="h-7 w-[110px] text-xs">
          <SelectValue placeholder="-">
            {row.planName ? (
              <span className="block truncate text-left">{row.planName}</span>
            ) : (
              <span className="text-zinc-400">-</span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            <span className="text-zinc-400">-</span>
          </SelectItem>
          {product?.plans.map((p) => (
            <SelectItem key={p.id} value={p.name}>
              <span className="inline-flex items-center gap-2">
                <span>{p.name}</span>
                {p.basePrice != null && (
                  <span className="text-[10px] tabular-nums text-zinc-500">{formatJPY(p.basePrice)}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* ヨミ（受注/締結済みかどうかが受注金額に直結） */}
      <Select
        value={row.yomiStatus ?? "__none__"}
        onValueChange={(v) => {
          const newYomi = v === "__none__" ? null : v;
          const optimistic: Partial<Row> = { yomiStatus: newYomi };
          if (newYomi && newYomi in YOMI_TO_PROBABILITY) {
            optimistic.probability = YOMI_TO_PROBABILITY[newYomi];
          }
          // API には yomiStatus のみ送り、probability はサーバー側自動上書きに任せる（既存パターンB）
          onPatch(optimistic, { yomiStatus: newYomi });
        }}
      >
        <SelectTrigger className="h-7 w-[92px] text-xs">
          <SelectValue placeholder="-">
            {row.yomiStatus ? (
              <span
                className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${yomiC.bg} ${yomiC.text} ${yomiC.border}`}
              >
                {stripYomiPrefix(row.yomiStatus)}
              </span>
            ) : (
              <span className="text-zinc-400">-</span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            <span className="text-zinc-400">-</span>
          </SelectItem>
          {YOMI_OPTIONS.map((y) => {
            const c = yomiColor(y);
            return (
              <SelectItem key={y} value={y}>
                <span
                  className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${c.bg} ${c.text} ${c.border}`}
                >
                  {y}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {/* 金額 */}
      <AmountInput
        value={row.amount}
        disabled={pending}
        onCommit={(v) => {
          if (v !== row.amount) onPatch({ amount: v }, { amount: v });
        }}
      />

      {/* 削除 */}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onDelete}
        disabled={pending}
        className="h-7 w-7 text-zinc-400 hover:text-red-600 hover:bg-red-50 ml-auto"
        title="削除"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function AddRow({
  dealId,
  products,
  pending,
  onCancel,
  onAdded,
}: {
  dealId: string;
  products: KpiProductMaster[];
  pending: boolean;
  onCancel: () => void;
  onAdded: (created: Row) => void;
}) {
  const [productId, setProductId] = useState("");
  const [planName, setPlanName] = useState("");
  const [yomiStatus, setYomiStatus] = useState<string>("受注");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const product = products.find((p) => p.id === productId);

  function selectPlan(name: string) {
    setPlanName(name);
    const plan = product?.plans.find((pl) => pl.name === name);
    if (plan?.basePrice != null && !amountTouched) {
      setAmount(String(plan.basePrice));
    }
  }

  async function submit() {
    if (!product) return;
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        productName: product.name,
        planName: planName || null,
        probability: YOMI_TO_PROBABILITY[yomiStatus] ?? 0,
        amount: amount ? Number(amount) : null,
        yomiStatus,
      }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "追加に失敗しました");
      return;
    }
    const json = await res.json();
    const dp = json.dealProduct;
    onAdded({
      id: dp.id,
      productId: dp.productId,
      productName: dp.productName,
      planName: dp.planName,
      amount: dp.amount,
      yomiStatus: dp.yomiStatus,
      probability: dp.probability,
    });
  }

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/40 p-2.5 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <Label className="text-[10px]">カテゴリ</Label>
          <Select
            value={productId}
            onValueChange={(v) => {
              setProductId(v);
              setPlanName("");
              setAmount("");
              setAmountTouched(false);
            }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="選択" />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-0.5">
          <Label className="text-[10px]">プラン</Label>
          <Select value={planName} onValueChange={selectPlan} disabled={!product?.plans.length}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="選択" />
            </SelectTrigger>
            <SelectContent>
              {product?.plans.map((p) => (
                <SelectItem key={p.id} value={p.name}>
                  <span className="inline-flex items-center gap-2">
                    <span>{p.name}</span>
                    {p.basePrice != null && (
                      <span className="text-[10px] tabular-nums text-zinc-500">{formatJPY(p.basePrice)}</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-0.5">
          <Label className="text-[10px]">ヨミ</Label>
          <Select value={yomiStatus} onValueChange={setYomiStatus}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YOMI_OPTIONS.map((y) => (
                <SelectItem key={y} value={y}>
                  {y}（{YOMI_TO_PROBABILITY[y]}%）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-0.5">
          <Label className="text-[10px]">金額（円）</Label>
          <Input
            type="number"
            min={0}
            step={10000}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setAmountTouched(true);
            }}
            className="h-8 text-xs text-right tabular-nums"
          />
        </div>
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={loading}>
          <X className="h-3.5 w-3.5" />
          キャンセル
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="h-7 text-xs"
          onClick={submit}
          disabled={loading || pending || !productId}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          追加
        </Button>
      </div>
    </div>
  );
}

/** 金額入力（controlled・null許容。blur で確定） */
function AmountInput({
  value,
  disabled,
  onCommit,
}: {
  value: number | null;
  disabled: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? "" : String(value));
  }, [value, focused]);
  return (
    <Input
      type="number"
      min={0}
      step={10000}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        const raw = e.target.value.trim();
        onCommit(raw === "" ? null : Number(raw));
      }}
      className="h-7 w-24 text-right text-xs tabular-nums"
      placeholder="金額"
    />
  );
}
