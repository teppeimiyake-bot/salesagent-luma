"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Sparkles, ArrowUpRight, Building2, Target } from "lucide-react";
import { DueBadge } from "@/components/ui/due-badge";

type TodoTask = {
  id: string;
  title: string;
  reason: string | null;
  priority: string | null;
  impact: string | null;
  isAiGenerated: boolean;
  isDealNextAction?: boolean;
  dueDate: Date | string | null;
  deal: {
    id: string;
    title: string;
    productName?: string;
    company: { name: string };
  };
};

export function AiTodoList({ tasks }: { tasks: TodoTask[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  async function complete(id: string) {
    start(async () => {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "DONE" }),
      });
      router.refresh();
    });
  }

  const list = tasks;

  return (
    <Card className="border-orange-200 bg-gradient-to-br from-orange-50/60 via-white to-amber-50/40 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
            <Sparkles className="h-4 w-4" />
          </div>
          <span>今日やるべき一手</span>
          <Badge variant="info" className="ml-auto">
            {list.length} 件
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {list.length === 0 ? (
          <div className="text-base text-zinc-500 py-10 text-center">
            あなたのToDoはありません。商談に録画/議事録をアップロードして、AIにNext Actionを生成させましょう。
          </div>
        ) : (
          <ul className="space-y-2.5">
            {list.map((t) => (
              <li
                key={t.id}
                className={`rounded-lg border p-4 flex items-start gap-3 hover:shadow-sm transition-all ${
                  t.isDealNextAction
                    ? "border-orange-200 bg-orange-50/40 hover:border-orange-300"
                    : "border-zinc-200 bg-white hover:border-orange-300"
                }`}
              >
                {t.isDealNextAction ? (
                  <Link
                    href={`/deals/${t.deal.id}`}
                    className="mt-0.5 text-orange-400 hover:text-orange-600 transition-colors"
                    title="商談へ移動"
                  >
                    <Target className="h-7 w-7" />
                  </Link>
                ) : (
                  <button
                    onClick={() => complete(t.id)}
                    disabled={pending}
                    className="mt-0.5 text-zinc-300 hover:text-orange-500 transition-colors"
                    title="完了にする"
                  >
                    <CheckCircle2 className="h-7 w-7" />
                  </button>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {t.isDealNextAction && (
                      <Badge className="bg-orange-100 text-orange-700 border-orange-200">
                        商談アクション
                      </Badge>
                    )}
                    {t.priority === "high" && <Badge variant="danger">最優先</Badge>}
                    {t.priority === "medium" && <Badge variant="warning">優先</Badge>}
                    {t.priority === "low" && <Badge variant="secondary">通常</Badge>}
                    {t.isAiGenerated && (
                      <span className="inline-flex items-center gap-1 text-xs text-orange-600 font-semibold">
                        <Sparkles className="h-3 w-3" />
                        AI
                      </span>
                    )}
                    <Link
                      href={`/deals/${t.deal.id}`}
                      className="text-xs text-zinc-500 hover:text-orange-600 inline-flex items-center gap-1 ml-auto"
                    >
                      <Building2 className="h-3 w-3" />
                      {t.deal.company.name} / {t.deal.productName ?? t.deal.title}
                      <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  </div>
                  <p className="font-semibold text-base text-zinc-900 leading-snug">{t.title}</p>
                  {t.reason && <p className="text-sm text-zinc-500 mt-1.5">理由: {t.reason}</p>}
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <DueBadge date={t.dueDate} size="md" />
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/deals/${t.deal.id}`}>商談へ</Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
