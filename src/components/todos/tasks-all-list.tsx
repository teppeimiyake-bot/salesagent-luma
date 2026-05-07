"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Sparkles,
  Trash2,
  RotateCcw,
  Building2,
  Target,
  ArrowRight,
} from "lucide-react";
import { DueBadge } from "@/components/ui/due-badge";

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  reason: string | null;
  isAiGenerated: boolean;
  dueDate: Date | string | null;
  /** Deal由来の「次回アクション」項目はこのフラグをtrueに */
  isDealNextAction?: boolean;
  deal: {
    id: string;
    title: string;
    /** 主要プロダクト名（カンマ区切り、最大3件 + "他N件"）。省略時は表示なし */
    productSummary?: string | null;
    company: { name: string };
    owner: { id: string; name: string; avatarColor: string | null } | null;
  };
};

export function TasksAllList({ tasks }: { tasks: Task[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function complete(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      });
      router.refresh();
    });
  }

  function reopen(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "OPEN" }),
      });
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm("削除しますか？")) return;
    start(async () => {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  if (tasks.length === 0) {
    return <p className="px-5 py-12 text-center text-base text-zinc-500">該当するToDoはありません</p>;
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {tasks.map((t) => {
        const done = t.status === "DONE";
        const isDealNA = !!t.isDealNextAction;
        return (
          <li
            key={t.id}
            className={`px-5 py-4 flex items-start gap-4 transition-colors ${
              done ? "bg-zinc-50/40" : isDealNA ? "bg-green-50/20 hover:bg-green-50/40" : "hover:bg-zinc-50"
            }`}
          >
            {isDealNA ? (
              // Deal由来は商談画面で完了するため、チェックボタンの代わりにアイコン
              <Link
                href={`/deals/${t.deal.id}`}
                className="text-green-500 hover:text-green-700 transition-colors mt-1"
                title="商談詳細を開く（次回アクションは商談画面で更新）"
              >
                <Target className="h-7 w-7" />
              </Link>
            ) : (
              <button
                onClick={() => (done ? reopen(t.id) : complete(t.id))}
                disabled={pending}
                className={
                  done
                    ? "text-emerald-500 hover:text-zinc-400 transition-colors mt-1"
                    : "text-zinc-300 hover:text-emerald-500 transition-colors mt-1"
                }
                title={done ? "未完了に戻す" : "完了にする"}
              >
                <CheckCircle2 className="h-7 w-7" />
              </button>
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {isDealNA && (
                  <Badge
                    variant="info"
                    className="text-xs px-2 py-0.5 inline-flex items-center gap-1 bg-green-100 text-green-700 border-green-200"
                  >
                    <Target className="h-3 w-3" />
                    商談アクション
                  </Badge>
                )}
                {t.isAiGenerated && (
                  <span className="inline-flex items-center gap-1 text-xs text-green-600 font-semibold">
                    <Sparkles className="h-3.5 w-3.5" /> AI生成
                  </span>
                )}
                {t.priority === "high" && (
                  <Badge variant="danger" className="text-xs px-2 py-0.5">最優先</Badge>
                )}
                {t.priority === "medium" && (
                  <Badge variant="warning" className="text-xs px-2 py-0.5">優先</Badge>
                )}
                {t.priority === "low" && (
                  <Badge variant="secondary" className="text-xs px-2 py-0.5">通常</Badge>
                )}
                <Link
                  href={isDealNA ? `/deals/${t.deal.id}` : `/companies/${t.deal.id}`}
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-600"
                >
                  <Building2 className="h-3 w-3" />
                  {t.deal.company.name}
                  {t.deal.productSummary && ` / ${t.deal.productSummary}`}
                </Link>
              </div>

              {isDealNA ? (
                <Link
                  href={`/deals/${t.deal.id}`}
                  className="block group"
                >
                  <p
                    className={`text-base font-medium leading-snug text-zinc-900 group-hover:text-green-700 inline-flex items-center gap-1.5`}
                  >
                    {t.title}
                    <ArrowRight className="h-3.5 w-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </p>
                </Link>
              ) : (
                <p className={`text-base font-medium leading-snug ${done ? "line-through text-zinc-500" : "text-zinc-900"}`}>
                  {t.title}
                </p>
              )}
              {t.reason && (
                <p className="text-sm text-zinc-500 mt-1.5">理由: {t.reason}</p>
              )}
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0">
              <DueBadge date={t.dueDate} size="md" done={done} />
              <div className="flex items-center gap-2">
                {t.deal.owner && (
                  <div
                    className="w-7 h-7 rounded-full text-white text-xs font-semibold flex items-center justify-center"
                    style={{ background: t.deal.owner.avatarColor ?? "#6366f1" }}
                    title={t.deal.owner.name}
                  >
                    {t.deal.owner.name.charAt(0)}
                  </div>
                )}
                {!isDealNA && done && (
                  <button
                    onClick={() => reopen(t.id)}
                    disabled={pending}
                    className="text-zinc-400 hover:text-emerald-600 inline-flex items-center gap-1 text-xs"
                    title="未完了に戻す"
                  >
                    <RotateCcw className="h-4 w-4" />
                    戻す
                  </button>
                )}
                {!isDealNA && (
                  <button
                    onClick={() => remove(t.id)}
                    disabled={pending}
                    className="text-zinc-300 hover:text-red-500"
                    title="削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
