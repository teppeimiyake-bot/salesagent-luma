"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { STATUS_LABEL, statusColor } from "@/lib/deal-status";
import { DueBadge } from "@/components/ui/due-badge";
import { Sparkles, FileSignature, Target, Sparkle, Calendar, NotebookPen } from "lucide-react";
import type { DealStatus } from "@prisma/client";
import {
  STAGE_GROUP_LABEL,
  findStageFromRows,
  rowToStageDef,
  type PipelineStageRow,
  type StageGroup,
} from "@/lib/pipeline-stage";
import { DateInput } from "@/components/ui/date-input";
import { leadSourceColor } from "@/lib/lead-source";

type LeadSource = { id: string; name: string; active: boolean };

const STATUSES: DealStatus[] = ["LEAD", "HEARING", "PROPOSAL", "NEGOTIATION", "CLOSING", "WON", "LOST"];

type SalesUser = { id: string; name: string; avatarColor: string | null };

/**
 * Deal本体の状態（フェーズ／プロセスステージ／担当／次回アクション）を編集するバー。
 * プロダクト固有の値（金額・確度・プラン）は DealProductsPanel 側で管理。
 */
export function DealStatusBar({
  deal,
  users,
  canEdit = true,
}: {
  deal: {
    id: string;
    status: DealStatus;
    pipelineStage: string | null;
    nextAction: string | null;
    nextActionAt: Date | string | null;
    appointmentDate: Date | string | null;
    contractDate: Date | string | null;
    expectedCloseDate: Date | string | null;
    leadSourceId: string | null;
    leadSource: { id: string; name: string } | null;
    leadSourceMemo: string | null;
    owner: SalesUser | null;
  };
  users: SalesUser[];
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [nextAction, setNextAction] = useState(deal.nextAction ?? "");
  const [nextDate, setNextDate] = useState(
    deal.nextActionAt ? new Date(deal.nextActionAt).toISOString().slice(0, 10) : "",
  );
  const [appointmentDate, setAppointmentDate] = useState(
    deal.appointmentDate ? new Date(deal.appointmentDate).toISOString().slice(0, 10) : "",
  );
  // 直近の Notion 同期失敗を一時的に表示するフラグ（成功 or 別フィールド更新でクリア）
  const [notionSyncFailed, setNotionSyncFailed] = useState(false);
  const [contractDate, setContractDate] = useState(
    deal.contractDate ? new Date(deal.contractDate).toISOString().slice(0, 10) : "",
  );
  const [expectedCloseDate, setExpectedCloseDate] = useState(
    deal.expectedCloseDate ? new Date(deal.expectedCloseDate).toISOString().slice(0, 10) : "",
  );
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [leadSources, setLeadSources] = useState<LeadSource[]>([]);
  const [stages, setStages] = useState<PipelineStageRow[]>([]);
  const [leadSourceMemo, setLeadSourceMemo] = useState(deal.leadSourceMemo ?? "");

  useEffect(() => {
    fetch("/api/pipeline-stages?includeInactive=true")
      .then((r) => r.json())
      .then((j) => setStages(j.stages ?? []));
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    fetch("/api/lead-sources?includeInactive=true")
      .then((r) => r.json())
      .then((j) => setLeadSources(j.leadSources ?? []));
  }, [canEdit]);

  async function suggestNext() {
    setSuggestLoading(true);
    const r = await fetch(`/api/deals/${deal.id}/suggest-next-action`, { method: "POST" });
    const j = await r.json();
    setSuggestLoading(false);
    if (j.suggestion) {
      setNextAction(j.suggestion.next_action);
      setNextDate(j.suggestion.next_action_at);
      patch({
        nextAction: j.suggestion.next_action,
        nextActionAt: new Date(j.suggestion.next_action_at).toISOString(),
      });
    }
  }

  function patch(payload: Record<string, unknown>) {
    start(async () => {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // 初回商談日(appointmentDate)を編集した時のみ Notion同期結果を見る
      if ("appointmentDate" in payload) {
        try {
          const j = await res.clone().json();
          setNotionSyncFailed(j?.notionSync === "failed");
        } catch {
          // パース失敗時は失敗扱いにせずスルー
        }
      } else {
        // 別フィールド編集時は失敗フラグをクリア
        setNotionSyncFailed(false);
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        {/* 上段：ステージとフェーズ */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-zinc-500">商談プロセスステージ（リージー運用）</Label>
            <Select
              value={deal.pipelineStage ?? "__none__"}
              onValueChange={(v) => patch({ pipelineStage: v === "__none__" ? null : v })}
            >
              <SelectTrigger className="h-9">
                <SelectValue>
                  {(() => {
                    const s = findStageFromRows(deal.pipelineStage, stages);
                    if (!s) return <span className="text-xs text-zinc-400">未設定</span>;
                    return (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${s.bg} ${s.text}`}>
                        {s.label}
                      </span>
                    );
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  <span className="text-xs text-zinc-500">未設定</span>
                </SelectItem>
                {(["before", "after", "contract"] as const).map((g: StageGroup) => {
                  const rows = stages.filter((s) => s.group === g && s.active);
                  if (rows.length === 0) return null;
                  return (
                    <div key={g}>
                      <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                        {STAGE_GROUP_LABEL[g]}
                      </div>
                      {rows.map((row) => {
                        const s = rowToStageDef(row);
                        return (
                          <SelectItem key={row.id} value={s.value}>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${s.bg} ${s.text}`}>
                              {s.label}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </div>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-zinc-500">フェーズ（自動連動なし）</Label>
            <Select value={deal.status} onValueChange={(v) => patch({ status: v })}>
              <SelectTrigger className="h-9">
                <SelectValue>
                  <Badge variant={statusColor(deal.status)}>{STATUS_LABEL[deal.status]}</Badge>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* 下段：担当者と次回アクション */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-3 border-t border-zinc-100">
          <div className="space-y-1">
            <Label className="text-xs text-zinc-500">商談主担当（Deal全体）</Label>
            <Select
              value={deal.owner?.id ?? ""}
              onValueChange={(v) => patch({ ownerUserId: v || null })}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="未割当">
                  {deal.owner && (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
                        style={{ background: deal.owner.avatarColor ?? "#6366f1" }}
                      >
                        {deal.owner.name.charAt(0)}
                      </span>
                      {deal.owner.name}
                    </span>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 md:col-span-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-zinc-500">次回アクション</Label>
              <DueBadge date={deal.nextActionAt} size="sm" />
            </div>
            <div className="flex gap-2">
              <Input
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                onBlur={(e) => patch({ nextAction: e.target.value || null })}
                placeholder="次回やること（AI提案 or 手打ち）"
                className="h-9 flex-1"
                disabled={pending}
              />
              <DateInput
                value={nextDate}
                onChange={(v) => {
                  setNextDate(v);
                  patch({ nextActionAt: v ? new Date(v).toISOString() : null });
                }}
                disabled={pending}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={suggestNext}
                disabled={suggestLoading}
                className="h-9 text-xs px-2 text-green-600 hover:bg-green-50"
                title="AIに次の一手を提案させる"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {suggestLoading ? "生成中…" : "AI提案"}
              </Button>
            </div>
          </div>
        </div>

        {/* リード獲得経由 ＋ 真横に初回商談日 */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            {/* リード獲得経由（伸縮） */}
            <div className="space-y-1 flex-1 min-w-0">
              <Label className="text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5">
                <Sparkle className="h-3.5 w-3.5 text-fuchsia-500" />
                リード獲得経由
              </Label>
              {canEdit ? (
                <Select
                  value={deal.leadSourceId ?? "__none__"}
                  onValueChange={(v) => patch({ leadSourceId: v === "__none__" ? null : v })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="未設定">
                      {(() => {
                        if (!deal.leadSource) {
                          return <span className="text-xs text-zinc-400">未設定</span>;
                        }
                        const c = leadSourceColor(deal.leadSource.name);
                        return (
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${c.bg} ${c.text} ${c.border}`}
                          >
                            {deal.leadSource.name}
                          </span>
                        );
                      })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-xs text-zinc-500">未設定</span>
                    </SelectItem>
                    {leadSources.map((ls) => {
                      const c = leadSourceColor(ls.name);
                      return (
                        <SelectItem key={ls.id} value={ls.id}>
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${c.bg} ${c.text} ${c.border} ${!ls.active ? "opacity-50" : ""}`}
                          >
                            {ls.name} {!ls.active && <span className="ml-1">(無効)</span>}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : deal.leadSource ? (
                (() => {
                  const c = leadSourceColor(deal.leadSource.name);
                  return (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold border ${c.bg} ${c.text} ${c.border}`}
                    >
                      {deal.leadSource.name}
                    </span>
                  );
                })()
              ) : (
                <span className="text-xs text-zinc-400">未設定</span>
              )}
            </div>
            {/* 初回商談日（真横・固定幅） */}
            <div className="space-y-1 md:w-[200px] shrink-0">
              <Label className="text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-emerald-500" />
                初回商談日
                {notionSyncFailed && (
                  <span
                    className="text-[10px] font-bold text-rose-600"
                    title="Notion『商談日』プロパティへの同期に失敗しました。サーバーログを確認してください。"
                  >
                    Notion同期失敗
                  </span>
                )}
              </Label>
              {canEdit ? (
                <DateInput
                  value={appointmentDate}
                  onChange={(v) => {
                    setAppointmentDate(v);
                    patch({ appointmentDate: v ? new Date(v).toISOString() : null });
                  }}
                  disabled={pending}
                />
              ) : (
                <span className="text-sm font-semibold tabular-nums text-emerald-700 block">
                  {appointmentDate || <span className="text-zinc-400 font-normal">未設定</span>}
                </span>
              )}
            </div>
          </div>

          {/* リード獲得メモ（リード獲得経由の補足） */}
          <div className="mt-3 space-y-1">
            <Label className="text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5">
              <NotebookPen className="h-3.5 w-3.5 text-fuchsia-500" />
              リード獲得メモ
              <span className="text-[10px] font-normal text-zinc-400">
                どう取得したか／きっかけ／紹介者など
              </span>
            </Label>
            {canEdit ? (
              <textarea
                value={leadSourceMemo}
                onChange={(e) => setLeadSourceMemo(e.target.value)}
                onBlur={(e) => patch({ leadSourceMemo: e.target.value || null })}
                placeholder="例：交流会で名刺交換 → 翌日HPフォーム経由でアポ依頼／〇〇株式会社の田中さんからご紹介"
                className="w-full min-h-[60px] rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-300 focus:border-fuchsia-300 resize-y"
                disabled={pending}
              />
            ) : (
              <p className="text-sm text-zinc-700 whitespace-pre-wrap rounded-md bg-zinc-50 px-3 py-2 min-h-[40px]">
                {leadSourceMemo || <span className="text-zinc-400">未記入</span>}
              </p>
            )}
          </div>
        </div>

        {/* 受注見込み日（着地予定。営業計画用、KPIには影響しない） */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-gradient-to-br from-orange-400 to-amber-400 text-white p-1.5 shadow-sm">
                <Target className="h-3.5 w-3.5" />
              </div>
              <Label className="text-xs font-semibold text-zinc-700">受注見込み日</Label>
              <span className="text-[10px] text-zinc-400">着地予定（KPIには未反映）</span>
            </div>
            {canEdit ? (
              <>
                <DateInput
                  value={expectedCloseDate}
                  onChange={(v) => {
                    setExpectedCloseDate(v);
                    patch({ expectedCloseDate: v ? new Date(v).toISOString() : null });
                  }}
                  disabled={pending}
                />
                {expectedCloseDate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setExpectedCloseDate("");
                      patch({ expectedCloseDate: null });
                    }}
                    className="h-8 text-xs text-zinc-500 hover:text-rose-600"
                  >
                    クリア
                  </Button>
                )}
              </>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-sky-700">
                {expectedCloseDate || <span className="text-zinc-400 font-normal">未設定</span>}
              </span>
            )}
          </div>
        </div>

        {/* 受注計上日（KPI実績の集計基準。受注になった瞬間に自動で本日付がセット、ここで上書き編集可） */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
                <FileSignature className="h-3.5 w-3.5" />
              </div>
              <Label className="text-xs font-semibold text-zinc-700">受注計上日</Label>
              <span className="text-[10px] text-zinc-400">KPI実績はこの日付で集計</span>
            </div>
            {canEdit ? (
              <>
                <DateInput
                  value={contractDate}
                  onChange={(v) => {
                    setContractDate(v);
                    patch({ contractDate: v ? new Date(v).toISOString() : null });
                  }}
                  disabled={pending}
                />
                {contractDate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setContractDate("");
                      patch({ contractDate: null });
                    }}
                    className="h-8 text-xs text-zinc-500 hover:text-rose-600"
                  >
                    クリア
                  </Button>
                )}
                {!contractDate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const today = new Date().toISOString().slice(0, 10);
                      setContractDate(today);
                      patch({ contractDate: new Date(today).toISOString() });
                    }}
                    className="h-8 text-xs text-emerald-600 hover:bg-emerald-50"
                  >
                    本日でセット
                  </Button>
                )}
              </>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-emerald-700">
                {contractDate || <span className="text-zinc-400 font-normal">未設定</span>}
              </span>
            )}
            {contractDate && (
              <Badge
                variant="success"
                className="ml-auto text-[10px]"
              >
                受注計上済 {contractDate}
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
