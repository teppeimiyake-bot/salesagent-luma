"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { DueBadge } from "@/components/ui/due-badge";
import { dueState } from "@/lib/due-date";

/**
 * ネクストアクションの期日（Deal.nextActionAt）をその場で変更する入力欄。
 * 日付を選んだ時点で PATCH /api/deals/[id] → router.refresh()。
 *
 * 商談一覧の行内と商談詳細の「次の一手」カードの両方から使う。
 * 期限超過・本日期日は入力欄自体を赤くして気づけるようにする。
 */
export function NextActionDateInput({
  dealId,
  value,
  showBadge = true,
}: {
  dealId: string;
  value: Date | string | null;
  /** 右側に残日数バッジを出すか */
  showBadge?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const state = dueState(value);
  const overdue = state === "overdue";

  function save(next: string | null) {
    start(async () => {
      await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextActionAt: next }),
      });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input
        type="date"
        value={toDateInputValue(value)}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value; // "YYYY-MM-DD" or ""
          if (v === "") {
            save(null);
            return;
          }
          const dt = new Date(`${v}T00:00:00`);
          if (!Number.isNaN(dt.getTime())) save(dt.toISOString());
        }}
        className={
          "shrink-0 rounded border bg-white px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:cursor-wait disabled:bg-zinc-50 " +
          (overdue ? "border-red-300 text-red-700 font-semibold" : "border-zinc-200")
        }
        title="ネクストアクションの期日を変更"
      />
      {showBadge && value && <DueBadge date={value} size="sm" />}
    </div>
  );
}

/**
 * Date | string | null → <input type="date"> 用の "YYYY-MM-DD"
 * 商談一覧のインライン編集（deal-inline-edit.tsx）と同じ変換にしてある。
 * ここを変えると同じ日付が一覧と詳細で1日ずれて見えるので揃えること。
 */
function toDateInputValue(v: Date | string | null): string {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
