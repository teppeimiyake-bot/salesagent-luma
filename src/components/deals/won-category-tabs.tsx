"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Layers, Film, Share2, Tv, Handshake } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 受注後タブ専用：受注プロダクト（映像/SNS/CATV/アライアンス）のサブタブ。
 * PMボード（pm-board.tsx）の SUBTABS と同じ粒度・見た目で統一する。
 * URLクエリ `?cat=映像|SNS|CATV|アライアンス`。未指定 = 「すべて」。
 * 複数プロダクト受注企業は各該当サブタブに出る（サーバ側で振り分け）。
 */
const SUBTABS = [
  { value: "all", label: "すべて", icon: Layers },
  { value: "映像", label: "映像", icon: Film },
  { value: "SNS", label: "SNS", icon: Share2 },
  { value: "CATV", label: "CATV", icon: Tv },
  { value: "アライアンス", label: "アライアンス", icon: Handshake },
] as const;

export function WonCategoryTabs({
  selected,
  counts,
}: {
  /** "all" | "映像" | "SNS" | "CATV" | "アライアンス" */
  selected: string;
  counts: Record<string, number>;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string) {
    const params = new URLSearchParams(search);
    params.delete("from");
    if (value === "all") params.delete("cat");
    else params.set("cat", value);
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 px-1 shrink-0">
        受注商材:
      </span>
      {SUBTABS.map((s) => {
        const active = s.value === selected;
        const Icon = s.icon;
        const n = counts[s.value] ?? 0;
        return (
          <Link
            key={s.value}
            href={buildHref(s.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
              active
                ? "bg-zinc-900 text-white border-zinc-900"
                : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {s.label}
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                active ? "bg-white/20" : "bg-zinc-100 text-zinc-500",
              )}
            >
              {n}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
