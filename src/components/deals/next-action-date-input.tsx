"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { DueBadge } from "@/components/ui/due-badge";
import { DateInput } from "@/components/ui/date-input";
import { dueState, jstDateInputToIso } from "@/lib/due-date";
import { toJstDateStr } from "@/lib/meeting-datetime";

/**
 * ネクストアクションの期日（Deal.nextActionAt）をその場で変更する入力欄。
 * 日付を選んだ時点で PATCH /api/deals/[id] → router.refresh()。
 *
 * 商談一覧の行内と商談詳細の「次の一手」カードの両方から使う。
 * 期限超過・本日期日は入力欄自体を赤くして気づけるようにする。
 *
 * 入力欄は自前カレンダーの DateInput（@/components/ui/date-input）。
 * ブラウザ標準の <input type="date"> は月送りしただけで change が飛び、
 * 日付を選ぶ前に保存されてしまうため使わないこと（2026-09 社長報告）。
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
      <DateInput
        value={toDateInputValue(value)}
        disabled={pending}
        invalid={overdue}
        onChange={(v) => {
          if (v === "") {
            save(null);
            return;
          }
          // 選んだ日の JST 0:00 として保存（ブラウザのTZに依存させない）
          const iso = jstDateInputToIso(v);
          if (iso) save(iso);
        }}
      />
      {showBadge && value && <DueBadge date={value} size="sm" />}
    </div>
  );
}

/**
 * Date | string | null → "YYYY-MM-DD"（JST の暦日）
 * 商談一覧のインライン編集（deal-inline-edit.tsx）と同じ変換にしてある。
 * ここを変えると同じ日付が一覧と詳細で1日ずれて見えるので揃えること。
 * サーバー（UTC）描画とブラウザ描画で値がズレないよう、ローカルTZではなく JST 固定で変換する。
 */
function toDateInputValue(v: Date | string | null): string {
  return toJstDateStr(v);
}
