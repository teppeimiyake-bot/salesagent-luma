import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Trophy, Building2 } from "lucide-react";
import { formatJPY } from "@/lib/utils";

export function GoalProgress({
  personal,
  team,
}: {
  personal: { targetAmount: number; wonAmount: number; rate: number; period: string };
  team: { targetAmount: number; wonAmount: number; rate: number; period: string };
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <Card className="border-orange-200 bg-gradient-to-br from-orange-50/50 to-white">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-xs text-orange-700 font-medium mb-1">
            <Trophy className="h-3.5 w-3.5" /> 自分の目標 ({personal.period})
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums">{formatJPY(personal.wonAmount)}</span>
            <span className="text-xs text-zinc-500">/ {formatJPY(personal.targetAmount)}</span>
          </div>
          <Progress value={Math.min(100, personal.rate * 100)} className="mt-2" />
          <p className="text-[10px] text-zinc-500 mt-1.5">
            達成率 {(personal.rate * 100).toFixed(1)}%
            <span className="ml-1 text-emerald-600">／売上計上ベース</span>
          </p>
        </CardContent>
      </Card>
      <Card className="border-zinc-200">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 text-xs text-zinc-600 font-medium mb-1">
            <Building2 className="h-3.5 w-3.5" /> 組織目標 ({team.period})
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums">{formatJPY(team.wonAmount)}</span>
            <span className="text-xs text-zinc-500">/ {formatJPY(team.targetAmount)}</span>
          </div>
          <Progress value={Math.min(100, team.rate * 100)} className="mt-2" />
          <p className="text-[10px] text-zinc-500 mt-1.5">
            達成率 {(team.rate * 100).toFixed(1)}%
            <span className="ml-1 text-emerald-600">／売上計上ベース</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
