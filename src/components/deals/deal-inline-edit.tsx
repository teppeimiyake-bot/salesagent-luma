"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { YOMI_OPTIONS, yomiColor } from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";
import { NextActionInput } from "@/components/deals/next-action-input";
import { DueBadge } from "@/components/ui/due-badge";
import { dueState } from "@/lib/due-date";

// 期日判定 dueState() は純粋ユーティリティ（@/lib/due-date）へ移動した。
// 後方互換のため、このモジュールからも引き続き利用できるよう re-export しておく。
export { dueState };

type ProductLite = {
  id: string;
  productName: string;
  yomiStatus: string | null;
  amount: number | null;
};

function yomiSelectOptions(current: string | null): string[] {
  const base = [...YOMI_OPTIONS];
  if (current && !base.includes(current as (typeof YOMI_OPTIONS)[number])) {
    return [current, ...base];
  }
  return base;
}

/** "Date | string | null" → <input type="date"> 用の "YYYY-MM-DD"（ローカル日付） */
function toDateInputValue(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
    <span className="inline-flex items-center gap-0.5">
      <span className="text-[11px] text-zinc-400">¥</span>
      <input
        type="number"
        min={0}
        step={10000}
        value={text}
        disabled={disabled}
        placeholder="—"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          const raw = e.target.value.trim();
          const v = raw === "" ? null : Number(raw);
          if (Number.isNaN(v as number)) return;
          if (v !== value) onCommit(v);
        }}
        className="w-24 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-right text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50"
        title="提案金額（円）を変更"
      />
    </span>
  );
}

/**
 * 商談一覧の行内でヨミ・提案金額をインライン編集する。
 * 行の遷移リンクは行全体を覆うオーバーレイ（deals-table.tsx）。この要素は relative z-10 で
 * その上に出るので、クリックはそのまま入力欄に届く。preventDefault は使わない
 * （使うと日付入力のカレンダーやセレクトが開かなくなる）。旧実装は preventDefault +
 * リンク遷移を抑止する。
 *
 * ネクストアクション(テキスト/期日)の編集は `DealNextActionEdit` に分離した
 * （カード内の重複表示解消・レイアウト整理のため）。
 */
export function DealInlineEdit({
  dealId,
  products,
}: {
  dealId: string;
  products: ProductLite[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function patchDealProduct(id: string, body: Record<string, unknown>) {
    start(async () => {
      await fetch(`/api/deal-products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });
  }

  if (products.length === 0) return null;

  return (
    <div
      // relative z-10 で行の遷移オーバーレイより前面に出す。
      // preventDefault はしない（セレクトが開かなくなるため）。
      className="relative z-10 mt-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {products.map((p) => {
          const bare = stripYomiPrefix(p.yomiStatus);
          const c = yomiColor(bare);
          return (
            <span key={p.id} className="inline-flex items-center gap-1.5">
              <span className="text-[11px] text-zinc-500">{p.productName}</span>
              <select
                value={bare ?? ""}
                onChange={(e) =>
                  patchDealProduct(p.id, {
                    yomiStatus: e.target.value === "" ? null : e.target.value,
                  })
                }
                disabled={pending}
                title={`${p.productName} のヨミを変更`}
                className={`cursor-pointer rounded-full border px-1.5 py-0.5 text-[11px] font-semibold ${c.bg} ${c.text} ${c.border} focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait`}
              >
                <option value="">-</option>
                {yomiSelectOptions(bare).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <AmountInput
                value={p.amount}
                disabled={pending}
                onCommit={(v) => patchDealProduct(p.id, { amount: v })}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 商談一覧の行内でネクストアクション(テキスト/期日)をインライン編集する。
 * カード中央〜右側エリアに配置する想定。
 * 行の遷移リンクは行全体を覆うオーバーレイ（deals-table.tsx）。この要素は relative z-10 で
 * その上に出るため、preventDefault なしでもリンクに遷移しない。
 * preventDefault を入れると日付入力のカレンダーが開かなくなるので入れないこと。
 */
export function DealNextActionEdit({
  dealId,
  nextAction,
  nextActionAt,
}: {
  dealId: string;
  nextAction: string | null;
  nextActionAt: Date | string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function patchDeal(body: Record<string, unknown>) {
    start(async () => {
      await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });
  }

  const state = dueState(nextActionAt);
  const overdue = state === "overdue";
  const today = state === "today";

  return (
    <div
      // relative z-10 で行の遷移オーバーレイより前面に出す。
      // preventDefault はしない（日付入力のカレンダーが開かなくなるため）。
      className="relative z-10"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <p className="text-xs text-zinc-500">ネクストアクション</p>
        {overdue && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 bg-red-100 border border-red-300 rounded px-1.5 py-0.5">
            <AlertTriangle className="h-3 w-3" />
            期限超過
          </span>
        )}
        {today && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
            <AlertTriangle className="h-3 w-3" />
            本日期日
          </span>
        )}
      </div>
      {/* テキスト欄：複数行で全文が読める高さを確保 */}
      <NextActionInput
        dealId={dealId}
        value={nextAction}
        rows={3}
        className={
          "w-full resize-y rounded border bg-white px-2 py-1 text-sm leading-snug focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50 " +
          (overdue
            ? "border-red-300 ring-1 ring-red-200"
            : today
              ? "border-red-200"
              : "border-zinc-200")
        }
      />
      {/* 期日：入力欄＋超過アラート付きバッジ */}
      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
        <input
          type="date"
          value={toDateInputValue(nextActionAt)}
          disabled={pending}
          onChange={(e) => {
            const v = e.target.value; // "YYYY-MM-DD" or ""
            if (v === "") {
              patchDeal({ nextActionAt: null });
            } else {
              const dt = new Date(`${v}T00:00:00`);
              if (!Number.isNaN(dt.getTime())) patchDeal({ nextActionAt: dt.toISOString() });
            }
          }}
          className={
            "shrink-0 rounded border bg-white px-1.5 py-1 text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50 " +
            (overdue ? "border-red-300 text-red-700 font-semibold" : "border-zinc-200")
          }
          title="ネクストアクションの期日を変更"
        />
        {nextActionAt && <DueBadge date={nextActionAt} size="sm" />}
      </div>
    </div>
  );
}
