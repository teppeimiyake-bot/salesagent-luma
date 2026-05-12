"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 商談のネクストアクション（Deal.nextAction）をその場で編集する小さな入力欄。
 * blur または Ctrl/Cmd+Enter で確定 → PATCH /api/deals/[id] → router.refresh()。
 * 一覧（ToDo一覧・商談一覧）の行内で使う想定。
 */
export function NextActionInput({
  dealId,
  value,
  rows = 1,
  className,
  placeholder = "ネクストアクションを入力…",
}: {
  dealId: string;
  value: string | null;
  rows?: number;
  className?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [text, setText] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value ?? "");
  }, [value, focused]);

  function commit() {
    const v = text.trim();
    const next = v === "" ? null : v;
    if (next === (value ?? null)) return;
    start(async () => {
      await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextAction: next }),
      });
      router.refresh();
    });
  }

  return (
    <textarea
      rows={rows}
      value={text}
      disabled={pending}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={
        className ??
        "w-full resize-y rounded border border-zinc-200 bg-white px-2 py-1 text-sm leading-snug focus:outline-none focus:ring-1 focus:ring-emerald-400 disabled:cursor-wait disabled:bg-zinc-50"
      }
      title="ネクストアクションを編集（フォーカスを外すと保存）"
    />
  );
}
