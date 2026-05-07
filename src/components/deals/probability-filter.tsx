"use client";
import Link from "next/link";
import { useSearchParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Percent } from "lucide-react";
import {
  PROBABILITY_BUCKETS,
  type ProbabilityBucketValue,
} from "./probability-filter-config";

export {
  PROBABILITY_BUCKETS,
  isProbabilityBucketValue,
  expandProbabilityBuckets,
} from "./probability-filter-config";
export type { ProbabilityBucketValue } from "./probability-filter-config";

const TONE: Record<ProbabilityBucketValue, { active: string; idle: string }> = {
  "0-19": {
    active: "bg-zinc-700 text-white border-zinc-700",
    idle: "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50",
  },
  "20-39": {
    active: "bg-orange-600 text-white border-orange-600",
    idle: "bg-white text-orange-700 border-orange-200 hover:bg-orange-50",
  },
  "40-59": {
    active: "bg-amber-600 text-white border-amber-600",
    idle: "bg-white text-amber-700 border-amber-200 hover:bg-amber-50",
  },
  "60-79": {
    active: "bg-sky-600 text-white border-sky-600",
    idle: "bg-white text-sky-700 border-sky-200 hover:bg-sky-50",
  },
  "80-100": {
    active: "bg-emerald-600 text-white border-emerald-600",
    idle: "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50",
  },
};

export function ProbabilityFilter({
  selected,
}: {
  selected: ProbabilityBucketValue[];
}) {
  const pathname = usePathname();
  const search = useSearchParams();

  function buildHref(next: ProbabilityBucketValue[]) {
    const params = new URLSearchParams(search);
    if (next.length === 0) params.delete("probability");
    else params.set("probability", next.join(","));
    const q = params.toString();
    return `${pathname}${q ? "?" + q : ""}`;
  }

  function toggle(v: ProbabilityBucketValue): ProbabilityBucketValue[] {
    if (selected.includes(v)) return selected.filter((x) => x !== v);
    return [...selected, v];
  }

  const allOff = selected.length === 0;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto py-1">
      <span className="inline-flex items-center gap-1 text-xs text-zinc-500 px-1 shrink-0">
        <Percent className="h-3 w-3" /> 確度:
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
      {PROBABILITY_BUCKETS.map((b) => {
        const active = selected.includes(b.value);
        const tone = TONE[b.value];
        return (
          <Link
            key={b.value}
            href={buildHref(toggle(b.value))}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors border",
              active ? tone.active : tone.idle,
            )}
          >
            {b.label}
          </Link>
        );
      })}
    </div>
  );
}
