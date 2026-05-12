"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { YOMI_OPTIONS, yomiColor } from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";

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
 * 商談一覧の行内でヨミ・提案金額・ネクストアクション(テキスト/期日)をインライン編集する。
 * 行全体が <Link> なので、このコンポーネント内のクリックは preventDefault + stopPropagation で
 * リンク遷移を抑止する。
 */
export function DealInlineEdit({
  dealId,
  nextAction,
  nextActionAt,
  products,
}: {
  dealId: string;
  nextAction: string | null;
  nextActionAt: Date | string | null;
  products: ProductLite[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [naText, setNaText] = useState(nextAction ?? "");
  const [naFocused, setNaFocused] = useState(false);
  useEffect(() => {
    if (!naFocused) setNaText(nextAction ?? "");
  }, [nextAction, naFocused]);

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

  return (
    <div
      className="mt-2 space-y-1.5"
      onClick={(e) => {
        // 行全体の <Link> 遷移を抑止
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {products.length > 0 && (
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
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="text-[11px] text-zinc-400 shrink-0">Next:</span>
        <input
          type="text"
          value={naText}
          disabled={pending}
          placeholder="ネクストアクション"
          onChange={(e) => setNaText(e.target.value)}
          onFocus={() => setNaFocused(true)}
          onBlur={(e) => {
            setNaFocused(false);
            const v = e.target.value.trim();
            const next = v === "" ? null : v;
            if (next !== (nextAction ?? null)) patchDeal({ nextAction: next });
          }}
          className="min-w-[12rem] flex-1 rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50"
        />
        <span className="text-[11px] text-zinc-400 shrink-0">期日:</span>
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
          className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50"
          title="ネクストアクションの期日を変更"
        />
      </div>
    </div>
  );
}
