"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Target } from "lucide-react";
import {
  YOMI_FILTER_VALUES,
  type YomiFilterValue,
} from "./yomi-filter-config";

export { YOMI_FILTER_VALUES, expandYomiValues } from "./yomi-filter-config";
export type { YomiFilterValue } from "./yomi-filter-config";

const YOMI_TONE: Record<YomiFilterValue, { active: string; idle: string }> = {
  NG: {
    active: "bg-red-600 text-white border-red-600",
    idle: "bg-white text-red-700 border-red-200 hover:bg-red-50",
  },
  ネタ: {
    active: "bg-zinc-700 text-white border-zinc-700",
    idle: "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
  },
  Cヨミ: {
    active: "bg-orange-600 text-white border-orange-600",
    idle: "bg-white text-orange-700 border-orange-200 hover:bg-orange-50",
  },
  Bヨミ: {
    active: "bg-amber-600 text-white border-amber-600",
    idle: "bg-white text-amber-700 border-amber-200 hover:bg-amber-50",
  },
  Aヨミ: {
    active: "bg-sky-600 text-white border-sky-600",
    idle: "bg-white text-sky-700 border-sky-200 hover:bg-sky-50",
  },
  受注: {
    active: "bg-emerald-600 text-white border-emerald-600",
    idle: "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50",
  },
};

export function YomiFilter({ selected }: { selected: YomiFilterValue[] }) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(next: YomiFilterValue[]) {
    const params = new URLSearchParams(search);
    if (next.length === 0) params.delete("yomi");
    else params.set("yomi", next.join(","));
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  function toggle(v: YomiFilterValue): YomiFilterValue[] {
    if (selected.includes(v)) return selected.filter((x) => x !== v);
    return [...selected, v];
  }

  const allOff = selected.length === 0;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 px-1 shrink-0">
        <Target className="h-3 w-3" /> ヨミ:
      </span>
      <Link
        href={buildHref([])}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
          allOff
            ? "bg-zinc-900 text-white border-zinc-900"
            : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
        )}
      >
        すべて
      </Link>
      {YOMI_FILTER_VALUES.map((v) => {
        const active = selected.includes(v);
        const tone = YOMI_TONE[v];
        return (
          <Link
            key={v}
            href={buildHref(toggle(v))}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
              active ? tone.active : tone.idle,
            )}
          >
            {v}
          </Link>
        );
      })}
    </div>
  );
}
