"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Circle, CheckCircle2, List } from "lucide-react";

export function TodoStatusTabs({
  current,
  counts,
}: {
  current: "open" | "done" | "all";
  counts: { open: number; done: number; all: number };
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string) {
    const params = new URLSearchParams(search);
    if (value === "open") params.delete("status");
    else params.set("status", value);
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  const tabs = [
    { value: "open", label: "未完了", icon: Circle, count: counts.open, color: "text-amber-600" },
    { value: "done", label: "完了済み", icon: CheckCircle2, count: counts.done, color: "text-emerald-600" },
    { value: "all", label: "全て", icon: List, count: counts.all, color: "text-zinc-600" },
  ];

  return (
    <div className="flex items-center gap-1">
      {tabs.map((t) => {
        const active = current === t.value;
        const Icon = t.icon;
        return (
          <Link
            key={t.value}
            href={buildHref(t.value)}
            className={cn(
              "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              active
                ? "bg-emerald-600 text-white shadow"
                : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
            )}
          >
            <Icon className={cn("h-4 w-4", active ? "" : t.color)} />
            {t.label}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-bold",
                active ? "bg-white/20" : "bg-white text-zinc-600",
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
