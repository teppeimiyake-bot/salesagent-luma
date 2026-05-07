"use client";
import { useEffect, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 日付入力：手入力（YYYY-MM-DD / YYYY/MM/DD / 8桁数字）+ カレンダーボタン両対応
 * value: "YYYY-MM-DD" 形式の文字列、または ""
 * onChange: 確定時に "YYYY-MM-DD" or "" を渡す（blur or カレンダー選択）
 */
export function DateInput({
  value,
  onChange,
  disabled,
  className,
  placeholder = "YYYY-MM-DD",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const dateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(value);
  }, [value]);

  function normalize(s: string): string | null {
    const t = s.trim().replaceAll("/", "-").replaceAll(".", "-");
    if (t === "") return "";
    if (/^\d{8}$/.test(t)) {
      return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    }
    const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }
    return null;
  }

  function handleBlur() {
    const n = normalize(text);
    if (n === null) {
      // 不正な入力 → 元の値に戻す
      setText(value);
      return;
    }
    if (n !== value) {
      setText(n);
      onChange(n);
    }
  }

  function openPicker() {
    if (disabled) return;
    const el = dateRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      el.showPicker();
    } else {
      el.click();
    }
  }

  return (
    <div className={cn("relative inline-flex items-center", className)}>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.currentTarget.blur();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        className="h-9 w-[150px] rounded-md border border-zinc-300 bg-white px-3 text-sm tabular-nums shadow-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 focus:outline-none disabled:opacity-60"
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-50"
        title="カレンダーから選択"
      >
        <Calendar className="h-4 w-4" />
      </button>
      <input
        ref={dateRef}
        type="date"
        value={value || ""}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        disabled={disabled}
        className="absolute opacity-0 pointer-events-none w-0 h-0"
        tabIndex={-1}
      />
    </div>
  );
}
