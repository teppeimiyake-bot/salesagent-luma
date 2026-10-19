import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatJPY(n: number | null | undefined) {
  if (n == null) return "—";
  return `¥${n.toLocaleString("ja-JP")}`;
}

/**
 * 日付 → "YYYY/MM/DD"（JST の暦日）。
 * サーバー（UTC）とブラウザ（JST）で日付がズレると hydration mismatch になるため、
 * timeZone を Asia/Tokyo に固定する（src/lib/meeting-datetime.ts と同じ規約）。
 */
export function formatDate(d: Date | string | null | undefined) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  });
}
