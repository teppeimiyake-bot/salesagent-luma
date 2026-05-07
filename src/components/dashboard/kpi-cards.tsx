import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, CheckCircle2, Sparkles, Target, DollarSign, Trophy } from "lucide-react";
import { formatJPY } from "@/lib/utils";

export function KpiCards({
  kpi,
}: {
  kpi: {
    winRate: number;
    todoCompletionRate: number;
    nextActionRate: number;
    aiTaskRatio: number;
    pipelineAmount: number;
    wonAmount: number;
    totalDeals: number;
    wonDeals: number;
  };
}) {
  const items = [
    {
      label: "受注率",
      value: `${(kpi.winRate * 100).toFixed(0)}%`,
      sub: `${kpi.wonDeals} / ${kpi.totalDeals} 件`,
      icon: Trophy,
      color: "text-emerald-600 bg-emerald-50",
    },
    {
      label: "ToDo消化率",
      value: `${(kpi.todoCompletionRate * 100).toFixed(0)}%`,
      sub: "全タスクのDONE比率",
      icon: CheckCircle2,
      color: "text-emerald-600 bg-emerald-50",
    },
    {
      label: "Next Action率",
      value: `${(kpi.nextActionRate * 100).toFixed(0)}%`,
      sub: "次の一手が定義された商談",
      icon: Target,
      color: "text-amber-600 bg-amber-50",
    },
    {
      label: "AI活用率",
      value: `${(kpi.aiTaskRatio * 100).toFixed(0)}%`,
      sub: "AI生成ToDoの比率",
      icon: Sparkles,
      color: "text-green-600 bg-green-50",
    },
    {
      label: "パイプライン",
      value: formatJPY(Math.round(kpi.pipelineAmount)),
      sub: "見込み金額（受注確度ベース）",
      icon: TrendingUp,
      color: "text-sky-600 bg-sky-50",
    },
    {
      label: "受注金額",
      value: formatJPY(kpi.wonAmount),
      sub: "累計（受注計上日ベース）",
      icon: DollarSign,
      color: "text-pink-600 bg-pink-50",
    },
  ];
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Card key={it.label}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-zinc-500">{it.label}</p>
                  <p className="text-xl font-semibold mt-1 tracking-tight">{it.value}</p>
                </div>
                <div className={`rounded-md p-1.5 ${it.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
              </div>
              <p className="text-xs text-zinc-400 mt-2">{it.sub}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
