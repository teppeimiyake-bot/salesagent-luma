import { cn } from "@/lib/utils";

/**
 * 入金管理の各 enum 値を色分けバッジで表示する共通コンポーネント。
 * tone は payments-ui.ts の *_BADGE マップ（Tailwindクラス文字列）を渡す。
 */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}
