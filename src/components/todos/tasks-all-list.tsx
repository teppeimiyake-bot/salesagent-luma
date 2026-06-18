"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Sparkles,
  Trash2,
  RotateCcw,
  Building2,
  Target,
  ArrowRight,
} from "lucide-react";
import { DueBadge } from "@/components/ui/due-badge";
import { YOMI_OPTIONS, yomiColor } from "@/lib/deal-aggregations";
import { stripYomiPrefix } from "@/lib/yomi-status";
import { NextActionInput } from "@/components/deals/next-action-input";

type DealProductLite = {
  id: string;
  productName: string;
  yomiStatus: string | null;
  amount: number | null;
};

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  reason: string | null;
  isAiGenerated: boolean;
  dueDate: Date | string | null;
  /** Deal由来の「次回アクション」項目はこのフラグをtrueに */
  isDealNextAction?: boolean;
  deal: {
    id: string;
    title: string;
    /** 主要プロダクト名（カンマ区切り、最大3件 + "他N件"）。省略時は表示なし */
    productSummary?: string | null;
    /** この商談の DealProduct 一覧（ヨミをインラインで変更するため）。省略時は表示なし */
    products?: DealProductLite[];
    company: { name: string };
    owner: { id: string; name: string; avatarColor: string | null } | null;
  };
};

/** Date|string|null → input[type=date] 用の YYYY-MM-DD（ローカル日付） */
function toDateInputValue(d: Date | string | null): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 期日の表示＋編集。クリックでバッジ⇄日付入力をトグル。
 * 変更すると onChange(YYYY-MM-DD | null) を呼ぶ。空にすると期日クリア。
 */
function EditableDue({
  date,
  done,
  disabled,
  onChange,
}: {
  date: Date | string | null;
  done: boolean;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <input
          type="date"
          autoFocus
          defaultValue={toDateInputValue(date)}
          disabled={disabled}
          onBlur={(e) => {
            const v = e.target.value || null;
            setEditing(false);
            if (v !== toDateInputValue(date) || (v === null && date !== null)) {
              onChange(v);
            }
          }}
          className="h-8 rounded-md border border-zinc-300 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait"
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      disabled={disabled}
      title="期日を変更"
      className="cursor-pointer rounded-lg hover:ring-2 hover:ring-emerald-200 disabled:cursor-wait"
    >
      <DueBadge date={date} size="md" done={done} />
    </button>
  );
}

/** native <select> の選択肢用にヨミの候補リストを組み立てる（現在値が候補外なら先頭に足す） */
function yomiSelectOptions(current: string | null): string[] {
  const base = [...YOMI_OPTIONS];
  if (current && !base.includes(current as (typeof YOMI_OPTIONS)[number])) {
    return [current, ...base];
  }
  return base;
}

/** 提案金額のインライン入力（controlled・null許容・blurで確定） */
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

export function TasksAllList({ tasks }: { tasks: Task[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function changeYomi(dealProductId: string, newYomi: string | null) {
    start(async () => {
      await fetch(`/api/deal-products/${dealProductId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ yomiStatus: newYomi }),
      });
      router.refresh();
    });
  }

  function changeAmount(dealProductId: string, amount: number | null) {
    start(async () => {
      await fetch(`/api/deal-products/${dealProductId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      router.refresh();
    });
  }

  function changeDue(id: string, dueDate: string | null) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // date(YYYY-MM-DD) → ISO。null は期日クリア。
        body: JSON.stringify({ dueDate: dueDate ? new Date(dueDate).toISOString() : null }),
      });
      router.refresh();
    });
  }

  function complete(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      });
      router.refresh();
    });
  }

  function reopen(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "OPEN" }),
      });
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm("削除しますか？")) return;
    start(async () => {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  if (tasks.length === 0) {
    return <p className="px-5 py-12 text-center text-base text-zinc-500">該当するToDoはありません</p>;
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {tasks.map((t) => {
        const done = t.status === "DONE";
        const isDealNA = !!t.isDealNextAction;
        return (
          <li
            key={t.id}
            className={`px-5 py-4 flex items-start gap-4 transition-colors ${
              done ? "bg-zinc-50/40" : isDealNA ? "bg-green-50/20 hover:bg-green-50/40" : "hover:bg-zinc-50"
            }`}
          >
            {isDealNA ? (
              // Deal由来は商談画面で完了するため、チェックボタンの代わりにアイコン
              <Link
                href={`/deals/${t.deal.id}`}
                className="text-green-500 hover:text-green-700 transition-colors mt-1"
                title="商談詳細を開く（次回アクションは商談画面で更新）"
              >
                <Target className="h-7 w-7" />
              </Link>
            ) : (
              <button
                onClick={() => (done ? reopen(t.id) : complete(t.id))}
                disabled={pending}
                className={
                  done
                    ? "text-emerald-500 hover:text-zinc-400 transition-colors mt-1"
                    : "text-zinc-300 hover:text-emerald-500 transition-colors mt-1"
                }
                title={done ? "未完了に戻す" : "完了にする"}
              >
                <CheckCircle2 className="h-7 w-7" />
              </button>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {isDealNA && (
                  <Badge
                    variant="info"
                    className="text-xs px-2 py-0.5 inline-flex items-center gap-1 bg-green-100 text-green-700 border-green-200"
                  >
                    <Target className="h-3 w-3" />
                    商談アクション
                  </Badge>
                )}
                {t.isAiGenerated && (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600 font-semibold">
                    <Sparkles className="h-3.5 w-3.5" /> AI生成
                  </span>
                )}
                {t.priority === "high" && (
                  <Badge variant="danger" className="text-xs px-2 py-0.5">最優先</Badge>
                )}
                {t.priority === "medium" && (
                  <Badge variant="warning" className="text-xs px-2 py-0.5">優先</Badge>
                )}
                {t.priority === "low" && (
                  <Badge variant="secondary" className="text-xs px-2 py-0.5">通常</Badge>
                )}
                <Link
                  href={isDealNA ? `/deals/${t.deal.id}` : `/companies/${t.deal.id}`}
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-600"
                >
                  <Building2 className="h-3 w-3" />
                  {t.deal.company.name}
                  {t.deal.productSummary && ` / ${t.deal.productSummary}`}
                </Link>
              </div>

              {isDealNA ? (
                <div className="flex items-start gap-1.5">
                  <div className="flex-1 min-w-0">
                    <NextActionInput
                      dealId={t.deal.id}
                      value={t.title}
                      rows={2}
                      placeholder="ネクストアクションを入力…"
                      className="w-full resize-y rounded border border-transparent bg-transparent px-1.5 py-1 text-base font-medium leading-snug text-zinc-900 hover:border-zinc-200 hover:bg-white focus:border-emerald-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait"
                    />
                  </div>
                  <Link
                    href={`/deals/${t.deal.id}`}
                    className="mt-1.5 shrink-0 text-zinc-300 hover:text-green-600"
                    title="商談詳細を開く"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              ) : (
                <p className={`text-base font-medium leading-snug ${done ? "line-through text-zinc-500" : "text-zinc-900"}`}>
                  {t.title}
                </p>
              )}
              {t.reason && (
                <p className="text-sm text-zinc-500 mt-1.5">理由: {t.reason}</p>
              )}

              {t.deal.products && t.deal.products.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {t.deal.products.map((p) => {
                    const bare = stripYomiPrefix(p.yomiStatus);
                    const c = yomiColor(bare);
                    return (
                      <span key={p.id} className="inline-flex items-center gap-1.5">
                        <span className="text-[11px] text-zinc-500">{p.productName}</span>
                        <select
                          value={bare ?? ""}
                          onChange={(e) =>
                            changeYomi(p.id, e.target.value === "" ? null : e.target.value)
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
                          onCommit={(v) => changeAmount(p.id, v)}
                        />
                      </span>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0">
              {isDealNA ? (
                <DueBadge date={t.dueDate} size="md" done={done} />
              ) : (
                <EditableDue
                  date={t.dueDate}
                  done={done}
                  disabled={pending}
                  onChange={(v) => changeDue(t.id, v)}
                />
              )}
              <div className="flex items-center gap-2">
                {t.deal.owner && (
                  <div
                    className="w-7 h-7 rounded-full text-white text-xs font-semibold flex items-center justify-center"
                    style={{ background: t.deal.owner.avatarColor ?? "#6366f1" }}
                    title={t.deal.owner.name}
                  >
                    {t.deal.owner.name.charAt(0)}
                  </div>
                )}
                {!isDealNA && done && (
                  <button
                    onClick={() => reopen(t.id)}
                    disabled={pending}
                    className="text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1 text-xs"
                    title="未完了に戻す"
                  >
                    <RotateCcw className="h-4 w-4" />
                    戻す
                  </button>
                )}
                {!isDealNA && (
                  <button
                    onClick={() => remove(t.id)}
                    disabled={pending}
                    className="text-zinc-300 hover:text-red-500"
                    title="削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
