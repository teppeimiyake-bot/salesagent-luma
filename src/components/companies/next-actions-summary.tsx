import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Zap, ArrowRight } from "lucide-react";
import { DueBadge } from "@/components/ui/due-badge";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import {
  representativeYomi,
  yomiColor,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { isExcludedFromNextAction } from "@/lib/deal-status";
import type { DealStatus } from "@prisma/client";

type Deal = {
  id: string;
  title: string;
  status: DealStatus;
  nextAction: string | null;
  nextActionAt: Date | string | null;
  pipelineStage: string | null;
  bant: unknown;
  owner: { id: string; name: string; avatarColor: string | null } | null;
  products: DealProductLite[];
};

export function NextActionsSummary({ deals }: { deals: Deal[] }) {
  const withNext = deals.filter(
    (d) =>
      d.nextAction &&
      d.status !== "WON" &&
      d.status !== "LOST" &&
      // NG / 日程調整不可 / 完全失注は除外（社長判断 2026-05）
      // products が既にprops経由で渡っているため、products基準のfallback判定でOK
      !isExcludedFromNextAction(d),
  );
  if (withNext.length === 0) return null;

  return (
    <Card className="border-amber-200 bg-gradient-to-br from-amber-50 to-white">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <div className="rounded-lg bg-amber-500 text-white p-1.5">
            <Zap className="h-4 w-4" />
          </div>
          この企業で取るべき次の一手
          <Badge variant="warning" className="ml-1">
            {withNext.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {withNext.map((d) => {
          const repYomi = representativeYomi(d.products);
          const repYomiC = yomiColor(repYomi);
          const productNames = d.products.slice(0, 3).map((p) => p.productName);
          const restCount = Math.max(0, d.products.length - 3);
          return (
            <Link
              key={d.id}
              href={`/deals/${d.id}`}
              className="block rounded-lg border border-zinc-200 bg-white p-4 hover:border-amber-300 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <Badge variant={statusColor(d.status)}>{STATUS_LABEL[d.status]}</Badge>
                    {repYomi && (
                      <span
                        className={`inline-flex items-center text-[11px] font-semibold border rounded-full px-2 py-0.5 ${repYomiC.bg} ${repYomiC.text} ${repYomiC.border}`}
                      >
                        {repYomi}
                      </span>
                    )}
                    <span className="font-bold text-base text-zinc-900 truncate">{d.title}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap mb-1">
                    {productNames.map((name, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">
                        {name}
                      </Badge>
                    ))}
                    {restCount > 0 && (
                      <Badge variant="secondary" className="text-[10px]">
                        +{restCount}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium text-zinc-800 mt-1">{d.nextAction}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <DueBadge date={d.nextActionAt} size="sm" />
                  {d.owner && (
                    <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                      <span
                        className="w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
                        style={{ background: d.owner.avatarColor ?? "#6366f1" }}
                      >
                        {d.owner.name.charAt(0)}
                      </span>
                      {d.owner.name}
                    </div>
                  )}
                </div>
                <ArrowRight className="h-4 w-4 text-zinc-300 group-hover:text-amber-500 transition-colors mt-1" />
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
