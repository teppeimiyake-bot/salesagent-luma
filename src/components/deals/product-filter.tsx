"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Package } from "lucide-react";

export function ProductFilter({
  products,
  selected,
}: {
  products: { name: string; count: number }[];
  selected: string | null;
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(value: string | null) {
    const params = new URLSearchParams(search);
    if (value === null) params.delete("product");
    else params.set("product", value);
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      <Link
        href={buildHref(null)}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors",
          selected === null
            ? "bg-green-600 text-white"
            : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
        )}
      >
        <Package className="h-3 w-3" />
        全プロダクト
      </Link>
      {products.map((p) => {
        const active = selected === p.name;
        return (
          <Link
            key={p.name}
            href={buildHref(p.name)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors",
              active
                ? "bg-green-600 text-white"
                : "bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50",
            )}
          >
            {p.name}
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-bold",
                active ? "bg-white/20" : "bg-zinc-100 text-zinc-500",
              )}
            >
              {p.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
