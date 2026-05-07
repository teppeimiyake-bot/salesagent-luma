"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ArrowUpDown, TrendingUp, Calendar, Clock, FileSignature } from "lucide-react";

const SORTS = [
  { value: "next", label: "次回アクション順", icon: Clock },
  { value: "probability_desc", label: "確度の高い順", icon: TrendingUp },
  { value: "probability_asc", label: "確度の低い順", icon: TrendingUp },
  { value: "close_asc", label: "契約想定日順", icon: FileSignature },
  { value: "amount_desc", label: "見込み金額順", icon: TrendingUp },
  { value: "total_desc", label: "提案金額合計順", icon: TrendingUp },
  { value: "updated_desc", label: "更新日（新しい順）", icon: Calendar },
];

export function SortFilter({ selected }: { selected: string }) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string) {
    const params = new URLSearchParams(search);
    if (value === "next") params.delete("sort");
    else params.set("sort", value);
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 px-1 shrink-0">
        <ArrowUpDown className="h-3 w-3" /> 並び替え:
      </span>
      {SORTS.map((s) => {
        const active = selected === s.value;
        const Icon = s.icon;
        return (
          <Link
            key={s.value}
            href={buildHref(s.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-emerald-600 text-white"
                : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
            )}
          >
            <Icon className="h-3 w-3" />
            {s.label}
          </Link>
        );
      })}
    </div>
  );
}
