import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Layers, FileSignature, Calendar, Sparkle, ArrowRight, AlertTriangle } from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { DueBadge } from "@/components/ui/due-badge";
import { CompanyLogo } from "@/components/ui/company-logo";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { DeleteButton } from "@/components/shared/delete-button";
import {
  totalProposedAmount,
  topProductLabels,
  representativeYomi,
  yomiColor,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { leadSourceColor } from "@/lib/lead-source";
import { DealInlineEdit, DealNextActionEdit } from "@/components/deals/deal-inline-edit";
import { dueState } from "@/lib/due-date";
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
  editable = false,
  linkQuery,
}: {
  deals: DealRow[];
  title?: string;
  showAllLink?: boolean;
  canDelete?: boolean;
  /** true の場合、各行でヨミ・提案金額・ネクストアクション(テキスト/期日)をインライン編集できる */
  editable?: boolean;
  /**
   * 商談詳細リンクに付与するクエリ文字列（`from` 用、`?` は含めない）。
   * 商談一覧から詳細に遷移する際に、戻りボタン用のフィルタ状態を引き継ぐためのもの。
   * 未指定の場合は通常のリンク（`/deals/{id}`）になる。
   */
  linkQuery?: string;
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
            const repYomi = representativeYomi(d.products);
            const repYomiColor = yomiColor(repYomi);
            const { primary, rest } = topProductLabels(d.products, 2);
            return (
              <div
                key={d.id}
                className="relative grid grid-cols-12 gap-x-4 gap-y-2 items-center px-5 py-3 hover:bg-emerald-50/30 transition-colors group"
              >
                {/* 行全体を覆う遷移用リンク。入力欄（relative z-10）はこの上に出る */}
                <Link
                  href={
                    linkQuery
                      ? `/deals/${d.id}?from=${encodeURIComponent(linkQuery)}`
                      : `/deals/${d.id}`
                  }
                  aria-label={`${d.company.name} の商談を開く`}
                  className="absolute inset-0"
                />
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
                    {editable && (
                      <DealInlineEdit
                        dealId={d.id}
                        products={d.products.map((p) => ({
                          id: p.id,
                          productName: p.productName,
                          yomiStatus: p.yomiStatus,
                          amount: p.amount,
                        }))}
                      />
                    )}
                  </div>
                </div>

                {/* 中央：提案金額＋ヨミ */}
                <div className="col-span-6 md:col-span-3 text-right md:text-left">
                  <p className="text-xs text-zinc-500 mb-0.5">提案金額</p>
                  <p className="font-bold text-lg tabular-nums text-emerald-700">
                    {formatJPY(totalAmt)}
                  </p>
                  <div className="mt-1 flex justify-end md:justify-start">
                    {repYomi ? (
                      <span
                        className={`inline-flex items-center text-[11px] font-semibold border rounded-full px-2 py-0.5 ${repYomiColor.bg} ${repYomiColor.text} ${repYomiColor.border}`}
                      >
                        {repYomi}
                      </span>
                    ) : (
                      <span className="text-[11px] text-zinc-400">ヨミ未設定</span>
                    )}
                  </div>
                </div>

                {/* 右側：ネクストアクション＋期日（編集可ユーザーはインライン編集、それ以外は表示専用コンパクト版） */}
                <div className="col-span-12 md:col-span-3 min-w-0">
                  {editable ? (
                    <DealNextActionEdit
                      dealId={d.id}
                      nextAction={d.nextAction}
                      nextActionAt={d.nextActionAt}
                    />
                  ) : (
                    (() => {
                      const state = dueState(d.nextActionAt);
                      const overdue = state === "overdue";
                      const today = state === "today";
                      return (
                        <>
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <p className="text-xs text-zinc-500">ネクストアクション</p>
                            {overdue && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 bg-red-100 border border-red-300 rounded px-1.5 py-0.5">
                                <AlertTriangle className="h-3 w-3" />
                                期限超過
                              </span>
                            )}
                            {today && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
                                <AlertTriangle className="h-3 w-3" />
                                本日期日
                              </span>
                            )}
                          </div>
                          {d.nextAction ? (
                            <p
                              className={`text-sm font-medium flex items-start gap-1 rounded px-1.5 py-1 ${
                                overdue
                                  ? "text-zinc-800 bg-red-50 border border-red-200"
                                  : "text-zinc-800"
                              }`}
                            >
                              <ArrowRight
                                className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${
                                  overdue ? "text-red-500" : "text-amber-500"
                                }`}
                              />
                              <span className="line-clamp-3">{d.nextAction}</span>
                            </p>
                          ) : (
                            <p className="text-sm text-zinc-400">未設定</p>
                          )}
                          <div className="mt-1">
                            <DueBadge date={d.nextActionAt} size="sm" />
                          </div>
                        </>
                      );
                    })()
                  )}
                </div>

                {/* 担当者 + 削除 + chevron */}
                <div className="hidden md:flex md:col-span-2 items-center justify-end gap-1 min-w-0">
                  <div className="min-w-0 flex-1 flex justify-end">
                    <OwnerBadge owner={d.owner} size="sm" />
                  </div>
                  {canDelete && (
                    <span className="relative z-10">
                      <DeleteButton
                        endpoint={`/api/deals/${d.id}`}
                        targetLabel={d.company.name}
                      />
                    </span>
                  )}
                  <ChevronRight className="h-4 w-4 text-zinc-300 group-hover:text-emerald-500 transition-colors shrink-0" />
                </div>
              </div>
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
