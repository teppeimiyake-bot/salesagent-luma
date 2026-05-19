import { cn } from "@/lib/utils";
import { Calendar, AlertTriangle, CheckCircle2 } from "lucide-react";
import { daysUntil } from "@/lib/due-date";

/** 期日バッジ。今日／期限超過／明日／今週／その先 で色分け */
export function DueBadge({
  date,
  size = "md",
  done = false,
  className,
}: {
  date: Date | string | null | undefined;
  size?: "sm" | "md" | "lg";
  done?: boolean;
  className?: string;
}) {
  if (!date) {
    return <span className={cn("text-zinc-400 inline-flex items-center gap-1", className)}>期日未設定</span>;
  }
  const d = new Date(date);
  // 期日判定（超過/今日/未来までの日数）は純粋ユーティリティに集約
  const diffDays = daysUntil(date) ?? 0;

  const sizes = {
    sm: { text: "text-xs", icon: "h-3 w-3", pad: "px-2 py-0.5", main: "text-xs" },
    md: { text: "text-sm", icon: "h-4 w-4", pad: "px-2.5 py-1", main: "text-base font-semibold" },
    lg: { text: "text-base", icon: "h-5 w-5", pad: "px-3 py-1.5", main: "text-xl font-bold" },
  }[size];

  const tone = done
    ? { bg: "bg-emerald-50", text: "text-emerald-600", border: "border-emerald-200" }
    : diffDays < 0
      ? { bg: "bg-red-100", text: "text-red-700", border: "border-red-300" }
      : diffDays === 0
        ? { bg: "bg-red-50", text: "text-red-600", border: "border-red-200" }
        : diffDays === 1
          ? { bg: "bg-orange-50", text: "text-orange-600", border: "border-orange-200" }
          : diffDays <= 3
            ? { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" }
            : diffDays <= 7
              ? { bg: "bg-yellow-50", text: "text-yellow-700", border: "border-yellow-200" }
              : { bg: "bg-zinc-50", text: "text-zinc-600", border: "border-zinc-200" };

  const label = done
    ? "完了"
    : diffDays < 0
      ? `${Math.abs(diffDays)}日 超過`
      : diffDays === 0
        ? "今日"
        : diffDays === 1
          ? "明日"
          : diffDays <= 7
            ? `${diffDays}日後`
            : `${Math.floor(diffDays / 7)}週間後`;

  const sub = `${d.getMonth() + 1}/${d.getDate()}`;

  const Icon = done ? CheckCircle2 : diffDays <= 1 ? AlertTriangle : Calendar;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border",
        tone.bg,
        tone.text,
        tone.border,
        sizes.pad,
        className,
      )}
    >
      <Icon className={sizes.icon} />
      <div className="flex items-baseline gap-1.5">
        <span className={sizes.main}>{label}</span>
        <span className={cn("opacity-70", sizes.text)}>{sub}</span>
      </div>
    </div>
  );
}
