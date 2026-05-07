"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Trash2, Sparkles } from "lucide-react";
import { formatDate } from "@/lib/utils";

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  impact: string | null;
  reason: string | null;
  expectedOutcome: string | null;
  isAiGenerated: boolean;
  dueDate: Date | string | null;
};

export function TasksList({ tasks }: { tasks: Task[] }) {
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

  function remove(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>ToDo</span>
          <Badge variant="secondary">{tasks.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {tasks.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-zinc-500">
            ToDoはまだありません。AIパネルから追加できます。
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {tasks.map((t) => (
              <li
                key={t.id}
                className={`px-5 py-3 flex items-start gap-3 ${
                  t.status === "DONE" ? "opacity-50" : ""
                }`}
              >
                <button
                  onClick={() => complete(t.id)}
                  disabled={pending || t.status === "DONE"}
                  className={`mt-0.5 ${t.status === "DONE" ? "text-emerald-500" : "text-zinc-300 hover:text-emerald-500"}`}
                >
                  <CheckCircle2 className="h-5 w-5" />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {t.isAiGenerated && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
                        <Sparkles className="h-3 w-3" /> AI生成
                      </span>
                    )}
                    {t.priority === "high" && <Badge variant="danger">最優先</Badge>}
                    {t.priority === "medium" && <Badge variant="warning">優先</Badge>}
                    {t.dueDate && (
                      <span className="text-[10px] text-zinc-400">期限 {formatDate(t.dueDate)}</span>
                    )}
                  </div>
                  <p className={`text-sm mt-1 ${t.status === "DONE" ? "line-through" : ""}`}>
                    {t.title}
                  </p>
                  {t.reason && <p className="text-xs text-zinc-500 mt-0.5">理由: {t.reason}</p>}
                </div>
                <button
                  onClick={() => remove(t.id)}
                  disabled={pending}
                  className="text-zinc-300 hover:text-red-500"
                  title="削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
