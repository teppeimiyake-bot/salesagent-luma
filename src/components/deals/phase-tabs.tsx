"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { Hourglass, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 受注前 / 受注後 タブ。
 * 受注後 = その商談に isWonYomi の DealProduct が1件以上ある企業。
 * 受注前 = それ以外。
 * URLクエリ `?phase=pre|won` で制御（デフォルト = pre）。
 * 受注後に切り替わったときは、受注プロダクトのサブタブ（?cat=...）を別途出す。
 */
export function PhaseTabs({
  selected,
  preCount,
  wonCount,
}: {
  /** "pre" | "won"。未指定は "pre" 扱い */
  selected: string;
  preCount: number;
  wonCount: number;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string) {
    const params = new URLSearchParams(search);
    params.delete("from");
    if (value === "pre") {
      params.delete("phase");
      // 受注後専用のサブタブ選択は受注前では無意味なので落とす
      params.delete("cat");
    } else {
      params.set("phase", value);
    }
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  const tabs = [
    { value: "pre", label: "受注前", icon: Hourglass, count: preCount },
    { value: "won", label: "受注後", icon: CheckCircle2, count: wonCount },
  ];

  return (
    <div className="flex items-center gap-1.5 py-1">
      {tabs.map((t) => {
        const active = t.value === selected;
        const Icon = t.icon;
        return (
          <Link
            key={t.value}
            href={buildHref(t.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
              active
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                active ? "bg-white/20" : "bg-zinc-100 text-zinc-500",
              )}
            >
              {t.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
