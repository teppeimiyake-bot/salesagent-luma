"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 会計年度セレクタ（KPI画面）。
 * Lumaは6月始まり（5月決算）。FY2026 = 2026年6月〜2027年5月。
 *
 * 現在の会計年度を中心に、過去 `back` 年・未来 `forward` 年を並べる。
 * year を URL の ?year= に載せて切り替える（他のクエリパラメータは保持）。
 */
export function YearTabs({
  currentFy,
  selectedYear,
  back = 2,
  forward = 1,
}: {
  /** 現在（本日基準）の会計年度 */
  currentFy: number;
  /** いま表示中の会計年度 */
  selectedYear: number;
  back?: number;
  forward?: number;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(fy: number) {
    const params = new URLSearchParams(search);
    params.set("year", String(fy));
    return `${pathname}?${params.toString()}`;
  }

  const years: number[] = [];
  for (let y = currentFy - back; y <= currentFy + forward; y++) years.push(y);
  // 選択中の年度がレンジ外（古い/先の年度）でも必ず出す
  if (!years.includes(selectedYear)) {
    years.push(selectedYear);
    years.sort((a, b) => a - b);
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 whitespace-nowrap pr-1">
        <CalendarRange className="h-3.5 w-3.5" />
        会計年度
      </span>
      {years.map((fy) => {
        const active = fy === selectedYear;
        const isCurrent = fy === currentFy;
        return (
          <Link
            key={fy}
            href={buildHref(fy)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-zinc-900 text-white"
                : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
            )}
            title={`FY${fy}（${fy}年6月〜${fy + 1}年5月）`}
          >
            FY{fy}
            <span className={cn("text-[10px]", active ? "text-zinc-300" : "text-zinc-400")}>
              {fy}/6〜{fy + 1}/5
            </span>
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
