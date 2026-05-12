"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, Trash2, Package, Layers, X, Film, Check } from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { ProbabilityBadge } from "@/components/ui/probability-badge";
import {
  YOMI_OPTIONS,
  YOMI_TO_PROBABILITY,
  pipelineAmount,
  totalProposedAmount,
  weightedProbability,
  yomiColor,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";
import { planProposalColorClass } from "@/lib/plan-proposal";

type SalesUser = { id: string; name: string; avatarColor: string | null };
export type ProductPlanMaster = {
  id: string;
  name: string;
  basePrice: number | null;
};
export type ProductMaster = {
  id: string;
  name: string;
  category: string | null;
  plans: ProductPlanMaster[];
};
export type PlanProposalMaster = {
  id: string;
  name: string;
  color: string;
};

/** 映像カテゴリ判定：productName が「映像」or product マスタの category が「映像」 */
function isVideoProduct(productName: string, products: ProductMaster[], productId: string | null): boolean {
  if (productName === "映像") return true;
  const p = products.find((x) => x.id === productId) ?? products.find((x) => x.name === productName);
  return p?.name === "映像" || p?.category === "映像";
}

export type DealProductRow = {
  id: string;
  productId: string | null;
  productName: string;
  planName: string | null;
  planProposals: string[];
  probability: number;
  amount: number | null;
  yomiStatus: string | null;
  ownerUserId: string | null;
  notes: string | null;
  owner: SalesUser | null;
  product: { id: string; name: string } | null;
};

export function DealProductsPanel({
  dealId,
  initial,
  users,
  products,
  planProposalMasters,
  canEdit,
  isAdmin = false,
}: {
  dealId: string;
  initial: DealProductRow[];
  users: SalesUser[];
  products: ProductMaster[];
  planProposalMasters: PlanProposalMaster[];
  canEdit: boolean;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [items, setItems] = useState<DealProductRow[]>(initial);

  const aggregates = (() => {
    const lite: DealProductLite[] = items.map((i) => ({
      productName: i.productName,
      probability: i.probability,
      amount: i.amount,
      yomiStatus: i.yomiStatus,
    }));
    return {
      totalAmount: totalProposedAmount(lite),
      pipeline: pipelineAmount(lite),
      probability: weightedProbability(lite),
    };
  })();

  /**
   * @param payload UI(items) に楽観的反映する内容
   * @param apiPayload API に送るボディ。省略時は payload と同じ。
   *                   ヨミ変更時に楽観的には確度も即時反映したいが、
   *                   API送信側では probability を含めず yomiStatus のみ送って
   *                   サーバー側の自動上書き（パターンB）に任せたい場合に使う。
   */
  function patchRow(
    row: DealProductRow,
    payload: Record<string, unknown>,
    apiPayload?: Record<string, unknown>,
  ) {
    // 楽観的更新
    setItems((prev) => prev.map((i) => (i.id === row.id ? { ...i, ...payload } : i)));
    start(async () => {
      await fetch(`/api/deal-products/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiPayload ?? payload),
      });
      router.refresh();
    });
  }

  function deleteRow(row: DealProductRow) {
    if (!confirm(`「${row.productName}」を削除しますか？（取り消せません）`)) return;
    start(async () => {
      await fetch(`/api/deal-products/${row.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((i) => i.id !== row.id));
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
            <Layers className="h-4 w-4" />
          </div>
          プロダクト構成
          <Badge variant="secondary" className="ml-1">
            {items.length}件
          </Badge>
          {canEdit && (
            <div className="ml-auto">
              <AddProductDialog
                dealId={dealId}
                users={users}
                products={products}
                planProposalMasters={planProposalMasters}
                isAdmin={isAdmin}
                onAdded={(newRow) => {
                  setItems((prev) => [...prev, newRow]);
                  router.refresh();
                }}
              />
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 space-y-0">
        {/* 合計サマリー（左寄せ・横スクロール不要） */}
        {items.length > 0 && (
          <div className="px-5 py-3 border-b border-zinc-200 bg-gradient-to-r from-orange-50/50 to-amber-50/30 flex flex-wrap items-center gap-x-6 gap-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-zinc-500 font-medium">見込み金額</span>
              <span className="font-bold text-xl tabular-nums text-orange-700">
                {formatJPY(aggregates.pipeline)}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-zinc-500 font-medium">提案合計</span>
              <span className="font-semibold text-base tabular-nums text-zinc-800">
                {formatJPY(aggregates.totalAmount)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 font-medium">代表確度</span>
              <ProbabilityBadge value={aggregates.probability} size="sm" />
            </div>
          </div>
        )}
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-zinc-500">
            プロダクトがまだ登録されていません。
            {canEdit && "「プロダクトを追加」ボタンから登録してください。"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-fixed min-w-[920px]">
              <thead>
                <tr className="text-[11px] text-zinc-500 border-b border-zinc-200">
                  <th className="text-left font-medium py-2 px-4 w-[200px]">プロダクト</th>
                  <th className="text-left font-medium py-2 px-2 w-[160px]">プラン</th>
                  <th className="text-left font-medium py-2 px-2 w-[110px]">ヨミ</th>
                  <th className="text-right font-medium py-2 px-2 w-[90px]">確度</th>
                  <th className="text-right font-medium py-2 px-2 w-[140px]">提案金額</th>
                  <th className="text-left font-medium py-2 px-2 w-[150px]">担当</th>
                  {canEdit && <th className="w-[40px]" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {items.map((row) => (
                  <ProductRow
                    key={row.id}
                    row={row}
                    users={users}
                    products={products}
                    planProposalMasters={planProposalMasters}
                    canEdit={canEdit}
                    pending={pending}
                    colCount={canEdit ? 7 : 6}
                    onPatch={(p, api) => patchRow(row, p, api)}
                    onDelete={() => deleteRow(row)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProductRow({
  row,
  users,
  products,
  planProposalMasters,
  canEdit,
  pending,
  colCount,
  onPatch,
  onDelete,
}: {
  row: DealProductRow;
  users: SalesUser[];
  products: ProductMaster[];
  planProposalMasters: PlanProposalMaster[];
  canEdit: boolean;
  pending: boolean;
  colCount: number;
  onPatch: (
    payload: Record<string, unknown>,
    apiPayload?: Record<string, unknown>,
  ) => void;
  onDelete: () => void;
}) {
  const yomiC = yomiColor(row.yomiStatus);
  const product = products.find((p) => p.id === row.productId) ?? products.find((p) => p.name === row.productName);
  const showPlanProposals =
    isVideoProduct(row.productName, products, row.productId) || row.planProposals.length > 0;
  return (
    <>
    <tr className="hover:bg-zinc-50/50">
      <td className="py-2 px-4 align-top" title={row.productName}>
        <div className="flex items-center gap-2 min-w-0">
          <Package className="h-3.5 w-3.5 text-orange-500 shrink-0" />
          <div className="min-w-0 flex-1">
            {canEdit ? (
              <Select
                value={row.productId ?? "__custom__"}
                onValueChange={(v) => {
                  if (v === "__custom__") return;
                  const p = products.find((x) => x.id === v);
                  if (p) onPatch({ productId: p.id, productName: p.name });
                }}
              >
                <SelectTrigger className="h-8 text-sm font-semibold border-0 shadow-none px-1 hover:bg-zinc-100 w-full max-w-full">
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
            ) : (
              <span className="font-semibold block truncate">{row.productName}</span>
            )}
          </div>
        </div>
      </td>
      <td className="py-2 px-2 align-top" title={row.planName ?? ""}>
        <div className="min-w-0">
          {canEdit && product?.plans.length ? (
            <Select
              value={row.planName ?? "__none__"}
              onValueChange={(v) => {
                if (v === "__none__") {
                  onPatch({ planName: null });
                  return;
                }
                const plan = product.plans.find((pl) => pl.name === v);
                const payload: Record<string, unknown> = { planName: v };
                // プラン変更時、提案金額が未入力ならプランの basePrice を自動入力（ユーザー入力済みなら尊重）
                if (plan?.basePrice != null && (row.amount == null || row.amount === 0)) {
                  payload.amount = plan.basePrice;
                }
                onPatch(payload);
              }}
            >
              <SelectTrigger className="h-8 text-xs border-0 shadow-none px-1 hover:bg-zinc-100 w-full max-w-full">
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
                {product.plans.map((p) => (
                  <SelectItem key={p.id} value={p.name}>
                    <span className="inline-flex items-center gap-2">
                      <span>{p.name}</span>
                      {p.basePrice != null && (
                        <span className="text-[10px] tabular-nums text-zinc-500">
                          {formatJPY(p.basePrice)}
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-zinc-700 block truncate">{row.planName ?? "-"}</span>
          )}
        </div>
      </td>
      <td className="py-2 px-2">
        {canEdit ? (
          <Select
            value={row.yomiStatus ?? "__none__"}
            onValueChange={(v) => {
              const newYomi = v === "__none__" ? null : v;
              // 社長判断（パターンB）：ヨミ変更時、API には yomiStatus のみ送る。
              // サーバー側で yomiStatus 変更 && probability 未送信 → YOMI_TO_PROBABILITY 由来で自動上書き。
              // UI(items) は楽観的に probability も即時反映してチラつき回避。
              const optimistic: Record<string, unknown> = { yomiStatus: newYomi };
              if (newYomi && newYomi in YOMI_TO_PROBABILITY) {
                optimistic.probability = YOMI_TO_PROBABILITY[newYomi];
              }
              const apiPayload: Record<string, unknown> = { yomiStatus: newYomi };
              onPatch(optimistic, apiPayload);
            }}
          >
            <SelectTrigger className="h-8 border-0 shadow-none px-1 hover:bg-zinc-100">
              <SelectValue placeholder="-">
                {row.yomiStatus ? (
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${yomiC.bg} ${yomiC.text} ${yomiC.border}`}
                    title={row.yomiStatus}
                  >
                    {stripYomiPrefix(row.yomiStatus)}
                  </span>
                ) : (
                  <span className="text-zinc-400 text-xs">-</span>
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
        ) : row.yomiStatus ? (
          <span
            className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${yomiC.bg} ${yomiC.text} ${yomiC.border}`}
            title={row.yomiStatus}
          >
            {stripYomiPrefix(row.yomiStatus)}
          </span>
        ) : (
          <span className="text-zinc-400 text-xs">-</span>
        )}
      </td>
      <td className="py-2 px-2 text-right">
        {canEdit ? (
          <ProbabilityInput
            value={row.probability}
            disabled={pending}
            onCommit={(v) => {
              if (v !== row.probability) onPatch({ probability: v });
            }}
          />
        ) : (
          <span className="font-semibold tabular-nums">{row.probability}%</span>
        )}
      </td>
      <td className="py-2 px-2 text-right">
        {canEdit ? (
          <AmountInput
            value={row.amount}
            disabled={pending}
            onCommit={(v) => {
              if (v !== row.amount) onPatch({ amount: v });
            }}
          />
        ) : (
          <span className="tabular-nums">{formatJPY(row.amount)}</span>
        )}
      </td>
      <td className="py-2 px-2">
        {canEdit ? (
          <Select
            value={row.ownerUserId ?? "__none__"}
            onValueChange={(v) => onPatch({ ownerUserId: v === "__none__" ? null : v })}
          >
            <SelectTrigger className="h-8 text-xs border-0 shadow-none px-1 hover:bg-zinc-100">
              <SelectValue placeholder="未割当">
                {row.owner ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
                      style={{ background: row.owner.avatarColor ?? "#6366f1" }}
                    >
                      {row.owner.name.charAt(0)}
                    </span>
                    <span className="text-xs">{row.owner.name}</span>
                  </span>
                ) : (
                  <span className="text-zinc-400 text-xs">未割当</span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                <span className="text-zinc-400">未割当</span>
              </SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : row.owner ? (
          <span className="text-xs">{row.owner.name}</span>
        ) : (
          <span className="text-zinc-400 text-xs">未割当</span>
        )}
      </td>
      {canEdit && (
        <td className="py-2 px-2 text-right">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onDelete}
            className="h-7 w-7 text-zinc-400 hover:text-red-600 hover:bg-red-50"
            title="削除"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </td>
      )}
    </tr>
    {showPlanProposals && (
      <tr className="bg-orange-50/30">
        <td colSpan={colCount} className="px-4 pb-3 pt-1">
          <div className="flex items-start gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-700 shrink-0 mt-1">
              <Film className="h-3 w-3" />
              企画提案
            </span>
            <div className="flex-1 min-w-0">
              <PlanProposalPicker
                selected={row.planProposals}
                masters={planProposalMasters}
                canEdit={canEdit}
                disabled={pending}
                onChange={(next) =>
                  onPatch({ planProposals: next }, { planProposals: next })
                }
              />
            </div>
          </div>
        </td>
      </tr>
    )}
    </>
  );
}

/**
 * 企画提案マルチセレクト（コンボボックス＋色付きピル）
 * - PlanProposal マスタから選択肢を取得（props で渡される）
 * - 複数選択・空OK
 * - 編集不可（canEdit=false）のときはピル表示のみ
 */
function PlanProposalPicker({
  selected,
  masters,
  canEdit,
  disabled,
  onChange,
}: {
  selected: string[];
  masters: PlanProposalMaster[];
  canEdit: boolean;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const colorOf = (name: string) => {
    const m = masters.find((x) => x.name === name);
    return planProposalColorClass(m?.color);
  };
  function toggle(name: string) {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name));
    } else {
      onChange([...selected, name]);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.length === 0 && !canEdit && (
        <span className="text-[11px] text-zinc-400 italic">未設定</span>
      )}
      {selected.map((name) => {
        const c = colorOf(name);
        return (
          <span
            key={name}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${c.bg} ${c.text} ${c.border}`}
          >
            {name}
            {canEdit && (
              <button
                type="button"
                onClick={() => toggle(name)}
                disabled={disabled}
                className="opacity-60 hover:opacity-100"
                title="外す"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        );
      })}
      {canEdit && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-orange-300 bg-white px-2 py-0.5 text-xs text-orange-700 hover:bg-orange-50"
          >
            <Plus className="h-3 w-3" />
            {selected.length === 0 ? "企画提案を選択" : "追加"}
          </button>
          {open && (
            <div
              className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
              onClick={() => setOpen(false)}
            >
              <div
                className="w-[36rem] max-w-full rounded-lg border border-zinc-200 bg-white p-4 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-800">企画提案を選択（複数可）</span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                    title="閉じる"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {masters.length === 0 ? (
                  <div className="px-1 py-2 text-sm text-zinc-400">
                    企画提案マスタが未登録です（管理画面で追加）
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {masters.map((m) => {
                      const c = planProposalColorClass(m.color);
                      const checked = selected.includes(m.name);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggle(m.name)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-zinc-100 ${checked ? "bg-orange-50" : ""}`}
                        >
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checked ? "border-orange-500 bg-orange-500 text-white" : "border-zinc-300 bg-white"}`}
                          >
                            {checked && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <span className={`rounded px-2 py-0.5 text-xs ${c.bg} ${c.text}`}>{m.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded-md bg-zinc-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                  >
                    完了
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddProductDialog({
  dealId,
  users,
  products,
  planProposalMasters,
  isAdmin,
  onAdded,
}: {
  dealId: string;
  users: SalesUser[];
  products: ProductMaster[];
  planProposalMasters: PlanProposalMaster[];
  isAdmin: boolean;
  onAdded: (newRow: DealProductRow) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [planName, setPlanName] = useState("");
  const [yomiStatus, setYomiStatus] = useState<string>("Cヨミ");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState("");
  const [planProposals, setPlanProposals] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // 新規カテゴリ追加（admin限定）
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const product = products.find((p) => p.id === productId);
  const isVideo = !!product && isVideoProduct(product.name, products, product.id);

  function selectPlan(name: string) {
    setPlanName(name);
    if (!product) return;
    const plan = product.plans.find((pl) => pl.name === name);
    // 提案金額がユーザー入力されていなければ basePrice を自動入力
    if (plan?.basePrice != null && !amountTouched) {
      setAmount(String(plan.basePrice));
    }
  }

  async function createCategory() {
    if (!newCategoryName.trim()) return;
    setCreatingCategory(true);
    setCreateError(null);
    const r = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCategoryName.trim() }),
    });
    const j = await r.json();
    setCreatingCategory(false);
    if (!r.ok) {
      setCreateError(j.error ?? "作成に失敗しました");
      return;
    }
    setShowNewCategory(false);
    setNewCategoryName("");
    setProductId(j.product.id);
    // 親に products リストを再取得させる
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!product) return;
    setLoading(true);
    const res = await fetch(`/api/deals/${dealId}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        productName: product.name,
        planName: planName || null,
        planProposals: isVideo ? planProposals : [],
        probability: YOMI_TO_PROBABILITY[yomiStatus] ?? 0,
        amount: amount ? Number(amount) : null,
        yomiStatus,
        ownerUserId: ownerUserId || null,
      }),
    });
    setLoading(false);
    if (res.ok) {
      const json = await res.json();
      const dp = json.dealProduct;
      const newRow: DealProductRow = {
        id: dp.id,
        productId: dp.productId,
        productName: dp.productName,
        planName: dp.planName,
        planProposals: dp.planProposals ?? [],
        probability: dp.probability,
        amount: dp.amount,
        yomiStatus: dp.yomiStatus,
        ownerUserId: dp.ownerUserId,
        notes: dp.notes,
        owner: dp.owner,
        product: dp.product,
      };
      setOpen(false);
      setProductId("");
      setPlanName("");
      setYomiStatus("Cヨミ");
      setAmount("");
      setAmountTouched(false);
      setOwnerUserId("");
      setPlanProposals([]);
      onAdded(newRow);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="primary" className="h-8">
          <Plus className="h-3.5 w-3.5" />
          プロダクトを追加
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>プロダクトを追加</DialogTitle>
          <DialogDescription>この商談に提案するカテゴリ＋プランを選択します</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">カテゴリ</Label>
            <Select
              value={productId}
              onValueChange={(v) => {
                if (v === "__new__") {
                  setShowNewCategory(true);
                  return;
                }
                setProductId(v);
                setPlanName("");
                setAmount("");
                setAmountTouched(false);
                setPlanProposals([]);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="カテゴリを選択" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
                {isAdmin && (
                  <SelectItem value="__new__">
                    <span className="text-emerald-600 font-semibold inline-flex items-center gap-1">
                      <Plus className="h-3 w-3" /> 新規カテゴリ追加（管理者のみ）
                    </span>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {showNewCategory && isAdmin && (
              <div className="mt-2 p-2 rounded-md border border-emerald-200 bg-emerald-50/50 space-y-1">
                <div className="flex gap-1.5">
                  <Input
                    autoFocus
                    placeholder="新しいカテゴリ名"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={createCategory}
                    disabled={creatingCategory || !newCategoryName.trim()}
                    className="h-8"
                  >
                    {creatingCategory ? "作成中..." : "作成"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowNewCategory(false);
                      setNewCategoryName("");
                      setCreateError(null);
                    }}
                    className="h-8"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                {createError && (
                  <p className="text-[11px] text-red-600">{createError}</p>
                )}
                <p className="text-[10px] text-zinc-500">
                  作成後、このダイアログで選択できます。プランは管理画面から追加してください。
                </p>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">提案プラン</Label>
              <Select value={planName} onValueChange={selectPlan} disabled={!product}>
                <SelectTrigger>
                  <SelectValue placeholder="プランを選択" />
                </SelectTrigger>
                <SelectContent>
                  {product?.plans.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      <span className="inline-flex items-center gap-2">
                        <span>{p.name}</span>
                        {p.basePrice != null && (
                          <span className="text-[10px] tabular-nums text-zinc-500">
                            {formatJPY(p.basePrice)}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">ヨミ</Label>
              <Select value={yomiStatus} onValueChange={setYomiStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {YOMI_OPTIONS.map((y) => (
                    <SelectItem key={y} value={y}>
                      {y} （{YOMI_TO_PROBABILITY[y]}%）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {isVideo && (
            <div className="space-y-1 rounded-md border border-orange-200 bg-orange-50/30 p-3">
              <Label className="text-xs inline-flex items-center gap-1 text-orange-700">
                <Film className="h-3 w-3" /> 企画提案（映像）
                <span className="text-[10px] text-zinc-400 font-normal">複数選択・空でもOK</span>
              </Label>
              <PlanProposalPicker
                selected={planProposals}
                masters={planProposalMasters}
                canEdit
                disabled={loading}
                onChange={setPlanProposals}
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs inline-flex items-center gap-1">
                提案金額（円）
                {planName &&
                  product?.plans.find((p) => p.name === planName)?.basePrice != null &&
                  !amountTouched && (
                    <span className="text-[10px] text-emerald-600 font-normal">
                      ベース価格自動入力
                    </span>
                  )}
              </Label>
              <Input
                type="number"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountTouched(true);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">担当者</Label>
              <Select value={ownerUserId} onValueChange={setOwnerUserId}>
                <SelectTrigger>
                  <SelectValue placeholder="未割当" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !productId}>
              {loading ? "追加中..." : "追加"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 確度入力（controlled）：
 * - 親(row.probability)が変わったら DOM 値も追従（ヨミ変更による自動同期で重要）
 * - 編集中は編集中の値を保持（フォーカス中の変更は奪わない）
 */
function ProbabilityInput({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <Input
      type="number"
      min={0}
      max={100}
      step={5}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        setFocused(false);
        const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
        setText(String(v));
        onCommit(v);
      }}
      className="h-8 w-20 text-right tabular-nums font-semibold ml-auto"
    />
  );
}

/**
 * 金額入力（controlled・null許容）
 */
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
        const v = raw === "" ? null : Number(raw);
        onCommit(v);
      }}
      className="h-8 w-32 text-right tabular-nums ml-auto"
    />
  );
}
