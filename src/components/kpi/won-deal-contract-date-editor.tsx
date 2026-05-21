"use client";

/**
 * 受注企業カード（KPI月次ドリルダウン）上での「受注計上日」インライン編集UI。
 *
 * 受注計上日 = Deal.contractDate。
 * KPIの月次/四半期/年間集計は contractDate を最優先で月度へ振り分けるため
 * （未設定時のみ appointmentDate→bantUpdatedAt にフォールバック）、
 * ここで contractDate を書き換えると、その案件が別の月へ移動し KPI 数値が再計算される。
 *
 *   - 保存: PATCH /api/deals/[id]  body: { contractDate: ISO文字列 | null }
 *   - 保存後 router.refresh() で KPI 集計（月次セル/カード一覧/年間KGI）をサーバー再取得して即反映する。
 *
 * 注意：保存に成功すると、計上月が変わった場合この案件は今開いている月のカードから消える
 *       （別月へ移動する）。これは仕様どおりの挙動。
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { CalendarCheck2, Check, X, Pencil, Loader2, AlertTriangle } from "lucide-react";

const SOURCE_LABEL: Record<string, string> = {
  appointmentDate: "商談日",
  bantUpdatedAt: "BANT更新日",
};

export function WonDealContractDateEditor({
  dealId,
  contractDate,
  bookedDate,
  bookedDateSource,
  canEdit,
}: {
  dealId: string;
  /** Deal.contractDate（"YYYY-MM-DD" or null） */
  contractDate: string | null;
  /** 実際に月度振り分けに使われた計上日（"YYYY-MM-DD" or null） */
  bookedDate: string | null;
  /** bookedDate の由来フィールド */
  bookedDateSource: "contractDate" | "appointmentDate" | "bantUpdatedAt" | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 編集中の入力値（空 = 未設定にする）。初期は contractDate、無ければフォールバック計上日を初期値に。
  const [draft, setDraft] = useState<string>(contractDate ?? bookedDate ?? "");
  const lastSaved = useRef(contractDate);

  // サーバー再取得で contractDate が変わったら同期
  useEffect(() => {
    if (!editing) setDraft(contractDate ?? bookedDate ?? "");
    lastSaved.current = contractDate;
  }, [contractDate, bookedDate, editing]);

  // contractDate 未設定でフォールバック（商談日など）で月度に乗っている状態か
  const usingFallback = !contractDate && bookedDateSource && bookedDateSource !== "contractDate";

  function save() {
    setError(null);
    // 空 → null（未設定に戻す）。値あり → JST 0時の ISO に変換（他の日付編集と同じ流儀）
    const iso = draft.trim()
      ? new Date(`${draft.trim()}T00:00:00+09:00`).toISOString()
      : null;
    start(async () => {
      try {
        const res = await fetch(`/api/deals/${dealId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contractDate: iso }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? "保存に失敗しました");
          return;
        }
        setEditing(false);
        // KPI集計（月次セル/カード一覧/KGI）をサーバー再取得して再計算
        router.refresh();
      } catch {
        setError("通信エラーで保存できませんでした");
      }
    });
  }

  if (!canEdit) {
    // 閲覧のみ：計上日の表示だけ
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
        <CalendarCheck2 className="h-3.5 w-3.5 text-emerald-500" />
        受注計上日：
        <span className="font-semibold text-zinc-700 tabular-nums">
          {contractDate ?? bookedDate ?? "未設定"}
        </span>
        {usingFallback && bookedDateSource && (
          <span className="text-amber-600">
            （{SOURCE_LABEL[bookedDateSource] ?? bookedDateSource}で計上中）
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-emerald-100 bg-emerald-50/40 px-2 py-1.5">
      {!editing ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <CalendarCheck2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          <span className="text-zinc-500">受注計上日</span>
          <span className="font-bold text-zinc-800 tabular-nums">
            {contractDate ?? bookedDate ?? "未設定"}
          </span>
          {usingFallback && bookedDateSource && (
            <span className="inline-flex items-center gap-0.5 text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {SOURCE_LABEL[bookedDateSource] ?? bookedDateSource}で暫定計上
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 ml-auto text-[11px] text-emerald-700 hover:bg-emerald-100"
            onClick={() => {
              setDraft(contractDate ?? bookedDate ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="h-3 w-3" />
            変更
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-zinc-600">受注計上日</span>
            <DateInput value={draft} onChange={setDraft} disabled={pending} />
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="h-7 px-2 text-xs"
              onClick={save}
              disabled={pending}
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              保存
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setEditing(false);
                setDraft(contractDate ?? bookedDate ?? "");
                setError(null);
              }}
              disabled={pending}
            >
              <X className="h-3.5 w-3.5" />
              キャンセル
            </Button>
          </div>
          <p className="text-[10px] text-zinc-500">
            空にして保存すると未設定（受注計上日なし）に戻せます。計上月が変わると、この案件は該当月へ移動します。
          </p>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
