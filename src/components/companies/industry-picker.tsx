"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";
import { industryMultiOptions, parseIndustries } from "@/lib/industry";

/**
 * 業種 複数選択ピッカー（チップ式トグル）。
 *
 * - value/onChange は Company.industry の「,」区切り文字列で受け渡しする
 *   （DBスキーマ String? のまま、保存形式は既存の「,」区切りを継続）。
 * - マスタ(INDUSTRY_OPTIONS)に無い既存値もチップとして表示し、
 *   選択肢から欠落しない（データ消失防止）。
 * - 複数該当しうる業種をトグルで複数選択できる。
 */
export function IndustryPicker({
  value,
  onChange,
  variant = "light",
}: {
  /** Company.industry の「,」区切り文字列（null/空可） */
  value: string | null | undefined;
  /** 変更後の「,」区切り文字列（未選択なら ""）を返す */
  onChange: (next: string) => void;
  /** 背景色に応じた配色。ダーク背景(company-hero編集)用に "onDark" を指定 */
  variant?: "light" | "onDark";
}) {
  const selected = useMemo(() => parseIndustries(value), [value]);
  const options = useMemo(() => industryMultiOptions(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (opt: string) => {
    const next = selectedSet.has(opt)
      ? selected.filter((s) => s !== opt)
      : [...selected, opt];
    onChange(next.join(", "));
  };

  const onDark = variant === "onDark";

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => {
        const active = selectedSet.has(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => toggle(opt)}
            aria-pressed={active}
            className={[
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors",
              active
                ? "bg-emerald-600 text-white border-emerald-600"
                : onDark
                  ? "bg-white/15 text-white/90 border-white/25 hover:bg-white/25"
                  : "bg-white text-zinc-600 border-zinc-200 hover:bg-emerald-50 hover:border-emerald-200",
            ].join(" ")}
          >
            {active && <Check className="h-3 w-3" />}
            {opt}
          </button>
        );
      })}
    </div>
  );
}
