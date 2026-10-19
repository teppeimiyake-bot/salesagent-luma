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
    proposedAmount: number;
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
      label: "提案金額合計",
      value: formatJPY(kpi.proposedAmount),
      sub: "進行中商談の提案金額合計",
      icon: TrendingUp,
      color: "text-sky-600 bg-sky-50",
    },
    {
      label: "受注金額",
      value: formatJPY(kpi.wonAmount),
      // 契約総額の累計（SNSは6ヶ月分の契約総額）。月次の「売上」は KPI階層ビュー側で
      // 契約期間に按分した金額を見る（社長判断 2026-08）。
      sub: "累計・契約総額ベース",
      icon: DollarSign,
      color: "text-pink-600 bg-pink-50",
    },
  ];
  // 列数は固定せず、カードの幅（12rem 以上）から決める。xl で6列に固定すると、右に AI チャットが出る 1280〜1535px では
  // カードが 95〜113px しかなく、金額が桁の途中で3〜4行に折れていた（UI確認 2026-10-01）。スマホ幅は2列。
  return (
    <div className="grid grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <Card key={it.label}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                {/* 8桁の金額（¥44,830,000）が1行に収まるよう、スマホ幅だけ一段小さくする。それでも収まらない幅では切らずに折り返す。 */}
                <div className="min-w-0">
                  <p className="text-xs text-zinc-500">{it.label}</p>
                  <p className="text-base sm:text-xl font-semibold mt-1 tracking-tight tabular-nums [overflow-wrap:anywhere]">{it.value}</p>
                </div>
                <div className={`shrink-0 rounded-md p-1.5 ${it.color}`}>
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
