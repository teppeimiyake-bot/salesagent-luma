"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NextActionInput } from "@/components/deals/next-action-input";
import { NextActionDateInput } from "@/components/deals/next-action-date-input";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, History, Target, Sparkles, AlertTriangle, Trophy } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { DueBadge } from "@/components/ui/due-badge";
import type { NextAction } from "@/lib/ai/pipeline";
import { toReadableText } from "@/lib/text-format";

type Json = Record<string, unknown> | null | unknown;

// AI生成物の表示防御（ai-panel.tsx と同じ意図、循環依存を避けてローカル定義）
function asText(v: unknown): string {
  if (v == null) return "";
  // AIが文字列内でMarkdown記法（**強調**・- 箇条書き）を使うことがあるため、
  // 表示直前に日本語の体裁（・／①）へ整形する（社長判断 2026-08）。
  if (typeof v === "string") return toReadableText(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

type MeetingItem = {
  id: string;
  title: string | null;
  meetingDate: Date | string;
  summary: string | null;
  bantBudget: string | null;
  bantAuthority: string | null;
  bantNeed: string | null;
  bantTimeline: string | null;
  topSales: Json;
  nextActions: Json;
};

export function DealOverviewPanel({
  dealId,
  deal,
  meetings,
  canEdit = false,
}: {
  dealId: string;
  deal: {
    nextAction: string | null;
    nextActionAt: Date | string | null;
  };
  meetings: MeetingItem[];
  /** admin / user のみ編集可。viewer は従来どおり表示専用 */
  canEdit?: boolean;
}) {
  // 古→新でラベル付け、表示は新→古
  const ordered = [...meetings].sort(
    (a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime(),
  );
  const labelById = new Map<string, string>();
  ordered.forEach((m, idx) => {
    labelById.set(m.id, m.title ?? `第${idx + 1}回`);
  });
  const sortedDesc = [...meetings].sort(
    (a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime(),
  );
  const latest = sortedDesc[0] ?? null;

  // 最新MeetingのAI Next Actionから上位2件
  const rawLatestNext = (latest?.nextActions as { next_actions?: unknown } | null)?.next_actions;
  let latestNext: NextAction[] = [];
  if (Array.isArray(rawLatestNext)) {
    latestNext = (rawLatestNext as NextAction[]).slice(0, 2);
  }
  const latestTop = latest?.topSales as
    | { winning_scenario?: unknown; risks?: unknown }
    | null
    | undefined;
  const latestTopRisks: unknown[] = Array.isArray(latestTop?.risks)
    ? (latestTop!.risks as unknown[])
    : [];

  return (
    <div className="space-y-3">
      {/* 次の一手（商談本体のNext Action）大表示 */}
      <Card className="border-amber-300 bg-gradient-to-br from-amber-50 via-white to-orange-50/40 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white p-1.5 shadow-sm">
              <Target className="h-4 w-4" />
            </div>
            次の一手
            {deal.nextActionAt && (
              <span className="ml-auto">
                <DueBadge date={deal.nextActionAt} />
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {canEdit ? (
            /* 商談を開いてすぐ書き換えられるように、表示ではなく入力欄を置く。
               テキストはフォーカスを外すと保存、期日は選んだ時点で保存される。 */
            <div className="space-y-2">
              <NextActionInput
                dealId={dealId}
                value={deal.nextAction}
                rows={3}
                placeholder="次にやることを入力（例: 見積を再提示して決裁者面談を打診）"
                className="w-full resize-y rounded-md border border-amber-200 bg-white px-2.5 py-2 text-base font-semibold leading-relaxed text-zinc-900 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-wait disabled:bg-zinc-50"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 shrink-0">期日</span>
                <NextActionDateInput dealId={dealId} value={deal.nextActionAt} />
              </div>
              <p className="text-[10px] text-zinc-400">
                入力欄からフォーカスを外すと保存されます（Ctrl/⌘+Enter でも保存）。
              </p>
            </div>
          ) : deal.nextAction ? (
            <p className="text-base font-semibold text-zinc-900 leading-relaxed">
              {deal.nextAction}
            </p>
          ) : (
            <p className="text-sm text-zinc-500 italic">
              Next Action 未設定。商談ステータス上の「AI提案」ボタン、または下のAI Next Action から1ボタンで設定できます。
            </p>
          )}

          {/* 最新MTGから上がってきたAIのNext Action候補 */}
          {latestNext.length > 0 && (
            <div className="pt-3 border-t border-amber-200">
              <p className="text-xs text-amber-800 font-semibold mb-2 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> AIが推奨する次の一手（{labelById.get(latest!.id)}）
              </p>
              <ul className="space-y-1.5">
                {latestNext.map((a, i) => (
                  <li
                    key={i}
                    className="text-sm text-zinc-800 bg-white/70 border border-amber-200 rounded-md px-2.5 py-2"
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Badge
                        variant={
                          a.priority === "high"
                            ? "danger"
                            : a.priority === "medium"
                              ? "warning"
                              : "secondary"
                        }
                        className="text-[10px]"
                      >
                        優先 {a.priority}
                      </Badge>
                    </div>
                    <p className="font-medium leading-snug whitespace-pre-wrap">{asText(a.action)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 勝ち筋 / リスク（要約） */}
          {asText(latestTop?.winning_scenario) && (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 p-2.5">
              <p className="text-xs text-emerald-800 font-semibold mb-1 flex items-center gap-1">
                <Trophy className="h-3 w-3" /> 勝ち筋
              </p>
              <p className="text-sm text-emerald-900 leading-snug whitespace-pre-wrap">
                {asText(latestTop?.winning_scenario)}
              </p>
            </div>
          )}
          {latestTopRisks.length > 0 && (
            <div className="rounded-md bg-red-50 border border-red-200 p-2.5">
              <p className="text-xs text-red-800 font-semibold mb-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> 失注リスク
              </p>
              <ul className="space-y-0.5">
                {latestTopRisks.slice(0, 2).map((r, i) => (
                  <li key={i} className="text-sm text-red-900 leading-snug flex gap-1.5">
                    <span>•</span>
                    <span className="whitespace-pre-wrap">{asText(r)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 商談タイムライン（過去の流れ） */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <History className="h-4 w-4" />
            </div>
            これまでの商談の流れ
            <Badge variant="secondary" className="ml-auto">
              {meetings.length}回
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {meetings.length === 0 ? (
            <p className="text-sm text-zinc-500 text-center py-3">
              まだ商談記録がありません
            </p>
          ) : (
            <ol className="relative border-l-2 border-orange-200 ml-2 space-y-3">
              {sortedDesc.map((m, idx) => {
                const isLatest = idx === 0;
                return (
                  <li key={m.id} className="ml-4 pl-1">
                    <span
                      className={`absolute -left-[7px] mt-1 w-3 h-3 rounded-full border-2 border-white shadow ${
                        isLatest
                          ? "bg-gradient-to-br from-orange-500 to-amber-500"
                          : "bg-orange-300"
                      }`}
                    />
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-semibold text-zinc-800">
                        {labelById.get(m.id)}
                      </span>
                      {isLatest && <Badge variant="info">最新</Badge>}
                      <span className="text-[11px] text-zinc-500">
                        {formatDate(m.meetingDate)}
                      </span>
                    </div>
                    {m.summary ? (
                      <p className="text-sm text-zinc-700 leading-snug mt-1 line-clamp-3">
                        {m.summary}
                      </p>
                    ) : (
                      <p className="text-xs text-zinc-400 italic mt-1">
                        AI分析未実施 / 議事録要約なし
                      </p>
                    )}
                    {/* BANTタグ */}
                    {(m.bantBudget || m.bantAuthority || m.bantNeed || m.bantTimeline) && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {m.bantBudget && (
                          <Badge variant="outline" className="text-[10px]">
                            B:あり
                          </Badge>
                        )}
                        {m.bantAuthority && (
                          <Badge variant="outline" className="text-[10px]">
                            A:あり
                          </Badge>
                        )}
                        {m.bantNeed && (
                          <Badge variant="outline" className="text-[10px]">
                            N:あり
                          </Badge>
                        )}
                        {m.bantTimeline && (
                          <Badge variant="outline" className="text-[10px]">
                            T:あり
                          </Badge>
                        )}
                      </div>
                    )}
                    {idx < sortedDesc.length - 1 && (
                      <div className="text-[10px] text-zinc-400 mt-2 inline-flex items-center gap-1">
                        <ChevronRight className="h-3 w-3" /> 次回へ
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
