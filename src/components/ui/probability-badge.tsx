import { cn } from "@/lib/utils";

/** 受注確度% を大きく色付きで表示。受注ファネルの最重要情報 */
export function ProbabilityBadge({
  value,
  size = "md",
  showBar = true,
  className,
}: {
  value: number;
  size?: "sm" | "md" | "lg" | "xl";
  showBar?: boolean;
  className?: string;
}) {
  const tone = toneFor(value);
  const sizes = {
    sm: { num: "text-base", unit: "text-xs", pad: "px-2 py-1", bar: "h-1" },
    md: { num: "text-2xl", unit: "text-sm", pad: "px-3 py-1.5", bar: "h-1.5" },
    lg: { num: "text-3xl", unit: "text-base", pad: "px-4 py-2", bar: "h-2" },
    xl: { num: "text-5xl", unit: "text-xl", pad: "px-5 py-3", bar: "h-2.5" },
  }[size];

  return (
    <div
      className={cn(
        "inline-flex flex-col items-center gap-1 rounded-xl font-bold",
        tone.bg,
        tone.text,
        sizes.pad,
        className,
      )}
    >
      <div className="flex items-baseline gap-0.5 leading-none tabular-nums">
        <span className={sizes.num}>{value}</span>
        <span className={cn(sizes.unit, "font-semibold opacity-80")}>%</span>
      </div>
      {showBar && (
        <div className={cn("w-full bg-white/40 rounded-full overflow-hidden", sizes.bar)}>
          <div
            className={cn("h-full rounded-full transition-all", tone.bar)}
            style={{ width: `${value}%` }}
          />
        </div>
      )}
    </div>
  );
}

function toneFor(value: number) {
  if (value >= 80) return { bg: "bg-emerald-100", text: "text-emerald-700", bar: "bg-emerald-500" };
  if (value >= 60) return { bg: "bg-sky-100", text: "text-sky-700", bar: "bg-sky-500" };
  if (value >= 40) return { bg: "bg-amber-100", text: "text-amber-700", bar: "bg-amber-500" };
  if (value >= 20) return { bg: "bg-orange-100", text: "text-orange-700", bar: "bg-orange-500" };
  return { bg: "bg-red-100", text: "text-red-700", bar: "bg-red-500" };
}
