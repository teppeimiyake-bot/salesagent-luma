import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Layers, FileSignature, Calendar, Sparkle } from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { ProbabilityBadge } from "@/components/ui/probability-badge";
import { DueBadge } from "@/components/ui/due-badge";
import { CompanyLogo } from "@/components/ui/company-logo";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { DeleteButton } from "@/components/shared/delete-button";
import {
  pipelineAmount,
  totalProposedAmount,
  topProductLabels,
  weightedProbability,
  yomiColor,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { leadSourceColor } from "@/lib/lead-source";
import type { DealStatus } from "@prisma/client";

type DealRow = {
  id: string;
  title: string;
  status: DealStatus;
  nextAction: string | null;
  nextActionAt: Date | string | null;
  appointmentDate?: Date | string | null;
  expectedCloseDate?: Date | string | null;
  contractDate?: Date | string | null;
  leadSourceId?: string | null;
  leadSource?: { id: string; name: string } | null;
  company: { id: string; name: string; industry: string | null; logoUrl?: string | null; logoColor?: string | null };
  owner: { id: string; name: string; avatarColor: string | null } | null;
  products: Array<DealProductLite & { id: string; yomiStatus: string | null }>;
  _count?: { tasks: number };
};

function formatYmd(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}`;
}

export function DealsTable({
  deals,
  title = "進行中の商談",
  showAllLink = true,
  canDelete = false,
}: {
  deals: DealRow[];
  title?: string;
  showAllLink?: boolean;
  canDelete?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-lg">
          <span>{title}</span>
          {showAllLink && (
            <Link href="/deals" className="text-sm text-emerald-600 hover:underline font-normal">
              すべて見る
            </Link>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="divide-y divide-zinc-100">
          {deals.map((d) => {
            const totalAmt = totalProposedAmount(d.products);
            const pipeline = pipelineAmount(d.products);
            const probability = weightedProbability(d.products);
            const { primary, rest } = topProductLabels(d.products, 2);
            return (
              <Link
                key={d.id}
                href={`/deals/${d.id}`}
                className="grid grid-cols-12 gap-4 items-center px-5 py-4 hover:bg-emerald-50/30 transition-colors group"
              >
                {/* 左：企業ロゴ＋名＋プロダクト構成 */}
                <div className="col-span-12 md:col-span-4 min-w-0 flex items-start gap-3">
                  <CompanyLogo
                    name={d.company.name}
                    logoUrl={d.company.logoUrl}
                    logoColor={d.company.logoColor}
                    size="md"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-base truncate group-hover:text-emerald-700">
                        {d.company.name}
                      </span>
                      <Badge variant={statusColor(d.status)} className="shrink-0">
                        {STATUS_LABEL[d.status]}
                      </Badge>
                      {d.contractDate && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold border border-emerald-300 bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5 shrink-0">
                          <FileSignature className="h-3 w-3" />
                          受注計上{formatYmd(d.contractDate)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      <Layers className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      <Badge variant="info" className="text-[10px]">
                        {d.products.length}件
                      </Badge>
                      {primary.map((p, idx) => {
                        const c = yomiColor(p.yomiStatus);
                        return (
                          <span
                            key={idx}
                            className={`inline-flex items-center gap-1 text-xs font-semibold border rounded px-1.5 py-0.5 ${c.bg} ${c.text} ${c.border}`}
                          >
                            {p.productName}
                          </span>
                        );
                      })}
                      {rest > 0 && (
                        <span className="text-[11px] text-zinc-500 font-medium">+{rest}</span>
                      )}
                    </div>
                    {(d.appointmentDate || d.leadSource) && (
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        {d.appointmentDate && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5"
                            title="初回商談日"
                          >
                            <Calendar className="h-2.5 w-2.5" />
                            初回 {formatYmd(d.appointmentDate)}
                          </span>
                        )}
                        {d.leadSource && (() => {
                          const c = leadSourceColor(d.leadSource.name);
                          return (
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-bold rounded-full px-1.5 py-0.5 border ${c.bg} ${c.text} ${c.border}`}
                            >
                              <Sparkle className="h-2.5 w-2.5" />
                              {d.leadSource.name}
                            </span>
                          );
                        })()}
                      </div>
                    )}
                    {d.nextAction && (
                      <p className="text-xs text-zinc-600 mt-1.5 truncate">
                        <span className="text-zinc-400">Next: </span>
                        {d.nextAction}
                      </p>
                    )}
                  </div>
                </div>

                {/* 中央：見込み金額＋提案合計 */}
                <div className="col-span-4 md:col-span-2 text-right md:text-left">
                  <p className="text-xs text-zinc-500 mb-0.5">見込み金額</p>
                  <p className="font-bold text-lg tabular-nums text-emerald-700">
                    {formatJPY(pipeline)}
                  </p>
                  <p className="text-[10px] text-zinc-500 tabular-nums">
                    提案計 {formatJPY(totalAmt)}
                  </p>
                </div>

                {/* 代表確度（加重平均・強調） */}
                <div className="col-span-4 md:col-span-2 flex justify-center">
                  <ProbabilityBadge value={probability} size="md" />
                </div>

                {/* 期日 */}
                <div className="col-span-4 md:col-span-2 flex justify-end md:justify-start">
                  <DueBadge date={d.nextActionAt} size="sm" />
                </div>

                {/* 担当者 + 削除 + chevron */}
                <div className="hidden md:flex md:col-span-2 items-center justify-end gap-1 min-w-0">
                  <div className="min-w-0 flex-1 flex justify-end">
                    <OwnerBadge owner={d.owner} size="sm" />
                  </div>
                  {canDelete && (
                    <DeleteButton
                      endpoint={`/api/deals/${d.id}`}
                      targetLabel={d.company.name}
                    />
                  )}
                  <ChevronRight className="h-4 w-4 text-zinc-300 group-hover:text-emerald-500 transition-colors shrink-0" />
                </div>
              </Link>
            );
          })}
          {deals.length === 0 && (
            <div className="px-5 py-12 text-center text-base text-zinc-500">
              該当する商談はありません。
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
