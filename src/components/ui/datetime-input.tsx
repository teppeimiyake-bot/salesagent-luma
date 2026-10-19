"use client";
import { useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 日時入力：手入力（YYYY-MM-DD HH:mm 系のゆるい表記）＋ ピッカーボタン両対応。
 * date-input.tsx の時刻対応版（T01 商談日時）。
 *
 * value: "YYYY-MM-DDTHH:mm"（JST前提。変換は @/lib/meeting-datetime）または ""
 * onChange: 確定時に "YYYY-MM-DDTHH:mm" or "" を渡す（blur or ピッカー選択）
 *
 * 受け付ける手入力の例：
 *   2026-08-20 14:00 / 2026/8/20 14:00 / 20260820 1400 / 2026-08-20T14:00
 *   時刻を省略した場合は 00:00 を補う（日付だけ入れたいケース）
 */
export function DateTimeInput({
  value,
  onChange,
  disabled,
  className,
  placeholder = "YYYY-MM-DD HH:mm",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const [text, setText] = useState(() => displayOf(value));
  const [previousValue, setPreviousValue] = useState(value);
  const pickerRef = useRef<HTMLInputElement>(null);

  if (previousValue !== value) {
    setPreviousValue(value);
    setText(displayOf(value));
  }

  function handleBlur() {
    const n = normalize(text);
    if (n === null) {
      // 不正な入力 → 元の値に戻す
      setText(displayOf(value));
      return;
    }
    if (n !== value) {
      setText(displayOf(n));
      onChange(n);
    } else {
      // 表記ゆれを正規化した見た目に揃える
      setText(displayOf(n));
    }
  }

  function openPicker() {
    if (disabled) return;
    const el = pickerRef.current;
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
        aria-label={ariaLabel}
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
        className="h-9 w-[190px] rounded-md border border-zinc-300 bg-white px-3 text-sm tabular-nums shadow-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 focus:outline-none disabled:opacity-60"
      />
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-500 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-50"
        title="カレンダーから選択"
        aria-label={ariaLabel ? `${ariaLabel}をカレンダーから選択` : "カレンダーから選択"}
      >
        <CalendarClock className="h-4 w-4" />
      </button>
      <input
        ref={pickerRef}
        type="datetime-local"
        aria-label={ariaLabel ? `${ariaLabel}のカレンダー` : "日時のカレンダー"}
        value={value || ""}
        onChange={(e) => {
          setText(displayOf(e.target.value));
          onChange(e.target.value);
        }}
        disabled={disabled}
        className="absolute opacity-0 pointer-events-none w-0 h-0"
        tabIndex={-1}
      />
    </div>
  );
}

/** 内部値 "YYYY-MM-DDTHH:mm" → 表示用 "YYYY-MM-DD HH:mm" */
function displayOf(v: string): string {
  return v ? v.replace("T", " ") : "";
}

/**
 * ゆるい手入力を "YYYY-MM-DDTHH:mm" に正規化する。
 * 空文字は "" を返し、解釈できない場合は null（＝入力を破棄して元に戻す）。
 */
function normalize(s: string): string | null {
  const t = s.trim().replace(/[T\s]+/g, " ").replaceAll("/", "-").replaceAll(".", "-");
  if (t === "") return "";

  const [datePart, timePart = ""] = t.split(" ");

  let date: string | null = null;
  if (/^\d{8}$/.test(datePart)) {
    date = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  } else {
    const m = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  }
  if (!date) return null;

  let time = "00:00";
  if (timePart !== "") {
    if (/^\d{4}$/.test(timePart)) {
      time = `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}`;
    } else {
      // "14:00" / "14:00:00" / "9:5" などを許容（秒は捨てる）
      const tm = timePart.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/);
      if (!tm) return null;
      time = `${tm[1].padStart(2, "0")}:${tm[2].padStart(2, "0")}`;
    }
  }

  const [hh, mm] = time.split(":").map(Number);
  if (hh > 23 || mm > 59) return null;

  // 実在日チェック（2026-02-31 のような入力を弾く）
  const [y, mo, d] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }

  return `${date}T${time}`;
}
