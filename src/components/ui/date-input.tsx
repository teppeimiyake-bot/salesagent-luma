"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 日付入力：手入力（YYYY-MM-DD / YYYY/MM/DD / 8桁数字）+ カレンダー両対応
 * value: "YYYY-MM-DD" 形式の文字列、または ""
 * onChange: 確定時に "YYYY-MM-DD" or "" を渡す（blur / カレンダーの日付クリック / クリア）
 *
 * カレンダーはブラウザ標準の <input type="date"> のピッカーを使わず自前で描画する。
 * Chrome 標準ピッカーは「次の月」へ移動しただけで選択日が動いて change が飛び、
 * 日付を選ぶ前に勝手に保存されてしまうため（2026-09 社長報告）。
 * 自前カレンダーでは月送りは表示を変えるだけで、onChange は日付セルを
 * クリックした時（と「今日」「クリア」）だけ発火する。
 */
export function DateInput({
  value,
  onChange,
  disabled,
  className,
  placeholder = "YYYY-MM-DD",
  size = "md",
  invalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** sm: 一覧の行内などの省スペース用 */
  size?: "sm" | "md";
  /** 期限超過などの警告表示（枠を赤くする） */
  invalid?: boolean;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

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

  function commit(v: string) {
    setText(v);
    setOpen(false);
    if (v !== value) onChange(v);
  }

  const sm = size === "sm";

  return (
    <div ref={wrapRef} className={cn("relative inline-flex items-center", className)}>
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
        className={cn(
          "rounded-md border bg-white tabular-nums shadow-sm focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 focus:outline-none disabled:opacity-60",
          sm ? "h-7 w-[112px] px-2 text-[11px]" : "h-9 w-[150px] px-3 text-sm",
          invalid ? "border-red-300 text-red-700 font-semibold" : "border-zinc-300",
        )}
      />
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "ml-1 inline-flex items-center justify-center rounded-md text-zinc-500 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-50",
          sm ? "h-7 w-7" : "h-9 w-9",
          open && "bg-orange-50 text-orange-600",
        )}
        title="カレンダーから選択"
        aria-label="カレンダーから選択"
      >
        <Calendar className={sm ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </button>

      {open && (
        <CalendarPopover
          value={value}
          anchorRef={btnRef}
          wrapRef={wrapRef}
          onPick={commit}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 自前カレンダー                                                       */
/* ------------------------------------------------------------------ */

const WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(v: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * body に portal で出す月カレンダー。
 * ・‹ › の月送り・年送りは「表示中の月」を変えるだけで値には触れない
 * ・値が確定するのは日付セル / 今日 / クリア を押した時だけ
 * 行内に置いても一覧のカードに切られないよう position: fixed + portal で描画する。
 */
function CalendarPopover({
  value,
  anchorRef,
  wrapRef,
  onPick,
  onClose,
}: {
  value: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  wrapRef: React.RefObject<HTMLElement | null>;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const selected = parseYmd(value);
  const today = new Date();
  const base = selected ?? today;
  const [view, setView] = useState({ y: base.getFullYear(), m: base.getMonth() });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // アンカー（カレンダーボタン）の下に配置。画面下に収まらなければ上に出す。
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = 268;
    const H = 300;
    const left = Math.min(Math.max(8, r.left - W + r.width), window.innerWidth - W - 8);
    const below = r.bottom + 6;
    const top = below + H > window.innerHeight ? Math.max(8, r.top - H - 6) : below;
    setPos({ top, left });
  }, [anchorRef, view]);

  // 外側クリック / Esc / スクロールで閉じる
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (wrapRef.current?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, wrapRef]);

  // pos は useLayoutEffect（クライアント）で入るので、SSR 時はここで抜ける
  if (!pos) return null;

  const first = new Date(view.y, view.m, 1);
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const lead = first.getDay(); // 日曜始まり
  const cells: (Date | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.y, view.m, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const todayYmd = toYmd(today);

  function shiftMonth(delta: number) {
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  return createPortal(
    <div
      ref={popRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: 268 }}
      className="z-[100] rounded-xl border border-zinc-200 bg-white p-2 shadow-2xl"
      // 一覧の行リンクへクリックが抜けないように止める
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ヘッダー：月送りは表示だけ動かす（値は変えない） */}
      <div className="flex items-center justify-between px-1 pb-1.5">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-orange-50 hover:text-orange-600"
          aria-label="前の月"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-bold text-zinc-800 tabular-nums">
          {view.y}年{view.m + 1}月
        </span>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-orange-50 hover:text-orange-600"
          aria-label="次の月"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-0.5">
        {WEEK_LABELS.map((w, i) => (
          <div
            key={w}
            className={cn(
              "py-1 text-center text-[10px] font-bold",
              i === 0 ? "text-red-500" : i === 6 ? "text-blue-500" : "text-zinc-400",
            )}
          >
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          if (!d) return <div key={`e${i}`} />;
          const s = toYmd(d);
          const isSelected = s === value;
          const isToday = s === todayYmd;
          const dow = d.getDay();
          return (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className={cn(
                "h-8 rounded-md text-[12px] tabular-nums transition-colors",
                isSelected
                  ? "bg-orange-500 font-bold text-white"
                  : cn(
                      "hover:bg-orange-50",
                      dow === 0 ? "text-red-600" : dow === 6 ? "text-blue-600" : "text-zinc-700",
                      isToday && "ring-1 ring-inset ring-orange-400 font-bold",
                    ),
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <div className="mt-1.5 flex items-center justify-between border-t border-zinc-100 px-1 pt-1.5">
        <button
          type="button"
          onClick={() => onPick(todayYmd)}
          className="rounded px-2 py-1 text-[11px] font-semibold text-orange-700 hover:bg-orange-50"
        >
          今日
        </button>
        <button
          type="button"
          onClick={() => onPick("")}
          className="rounded px-2 py-1 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-rose-600"
        >
          クリア
        </button>
      </div>
    </div>,
    document.body,
  );
}
