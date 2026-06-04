"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 四半期セレクタ（MS送付状況画面）。1Q〜4Q を URL の ?q= で切り替える。
 * 会計年度（?year=）など他のクエリパラメータは保持。
 */
export function QuarterTabs({
  selectedQuarter,
  currentQuarter,
}: {
  /** いま表示中の四半期（1〜4） */
  selectedQuarter: number;
  /** 本日基準の会計四半期（1〜4）。今期バッジ用。 */
  currentQuarter?: number;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(q: number) {
    const params = new URLSearchParams(search);
    params.set("q", String(q));
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 whitespace-nowrap pr-1">
        <LayoutGrid className="h-3.5 w-3.5" />
        四半期
      </span>
      {[1, 2, 3, 4].map((q) => {
        const active = q === selectedQuarter;
        const isCurrent = q === currentQuarter;
        return (
          <Link
            key={q}
            href={buildHref(q)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
            )}
          >
            {q}Q
            {isCurrent && (
              <span
                className={cn(
                  "text-[9px] font-semibold rounded px-1 py-0.5",
                  active ? "bg-emerald-400 text-emerald-950" : "bg-emerald-100 text-emerald-700",
                )}
              >
                今期
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
