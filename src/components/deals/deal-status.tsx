"use client";
import { useEffect, useRef, useState, useTransition } from "react";
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
import {
  Sparkles,
  FileSignature,
  Target,
  Sparkle,
  Calendar,
  NotebookPen,
  CalendarClock,
  Video,
  Copy,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import type { DealStatus } from "@prisma/client";
import {
  STAGE_GROUP_LABEL,
  findStageFromRows,
  rowToStageDef,
  type PipelineStageRow,
  type StageGroup,
} from "@/lib/pipeline-stage";
import { DateInput } from "@/components/ui/date-input";
import { MeetingDateTimeEditor } from "@/components/deals/meeting-datetime-editor";
import {
  toJstDateTimeInput,
  jstDateTimeInputToIso,
  toJstDateStr,
} from "@/lib/meeting-datetime";
import { jstDateInputToIso } from "@/lib/due-date";
import { leadSourceColor } from "@/lib/lead-source";

type LeadSource = { id: string; name: string; active: boolean };

/**
 * DateInput の "YYYY-MM-DD" → PATCH に載せる値。"" はクリア（null）、存在しない日付（2026-02-30 等）は
 * undefined を返し、保存しない。
 * - 次回アクション期日は JST 0:00 で保存する（期日バッジ・一覧の期日入力と同じ規約）。
 * - 初回商談日・受注見込み日・受注計上日は日付だけの値として UTC 0:00 で保存する（受注時の自動設定・KPI 画面の編集欄も同じ）。
 *   KPI の集計と Notion 同期は日本時間の暦日で読むので、この形なら入力した日のまま扱われる（src/lib/calendar-date.ts）。
 */
function dateInputToPatchValue(v: string, jstMidnight: boolean): string | null | undefined {
  if (!v) return null;
  const jstIso = jstDateInputToIso(v);
  if (!jstIso) return undefined;
  return jstMidnight ? jstIso : new Date(v).toISOString();
}

/**
 * Meet の発行・同期が成功したときの案内。
 * 「同期」なのに URL が変わった＝Google カレンダー側で予定が削除されていて、新しい予定・Meet を作り直した（T02）。
 * 送付済みの古い URL はもう使えないので、黙って差し替えずにそのことを伝える。
 */
export function meetSyncSuccessMessage({
  forceRecreate,
  previousUrl,
  nextUrl,
}: {
  forceRecreate: boolean;
  previousUrl: string | null | undefined;
  nextUrl: string | null | undefined;
}): string {
  if (forceRecreate) return "Meetを再発行しました。";
  if (previousUrl && nextUrl && nextUrl !== previousUrl) {
    return "Google カレンダーの予定が見つからなかったため、新しいMeetを発行しました。URLが変わったので、送付済みの場合は新しいURLを送り直してください。";
  }
  return "Meetを同期しました。";
}

/** 保存（PATCH）に失敗したときに画面に出す理由。英語の「Forbidden」などはそのまま出さない。 */
async function saveErrorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  const reason = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  // 日本語の理由が返ってきていればそれを使う
  if (/[ぁ-んァ-ヶ一-龠]/.test(reason)) return reason;
  if (res.status === 403) return "閲覧のみの権限では、この操作はできません。全社統合ビューの場合は、会社を切り替えてから操作してください。";
  if (res.status === 401) return "ログインの有効期限が切れました。再度ログインしてください。";
  return `保存できませんでした（HTTP ${res.status}）。再読み込みしてからもう一度お試しください。`;
}

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
  showMeetingDateTime = false,
  allowMeetIssuance = true,
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
    // 商談日時（T01）。FEATURE_MEET が OFF のときは未使用
    meetingStartAt?: Date | string | null;
    meetingEndAt?: Date | string | null;
    meetUrl?: string | null;
    meetEventId?: string | null;
    leadSourceId: string | null;
    leadSource: { id: string; name: string } | null;
    leadSourceMemo: string | null;
    owner: SalesUser | null;
  };
  users: SalesUser[];
  canEdit?: boolean;
  /** FEATURE_MEET。OFF（既定）のときは「商談日時」欄を出さず、従来の画面のまま */
  showMeetingDateTime?: boolean;
  /** 自社Meetの商談だけ発行・同期する。日時の入力は全形式で利用可能。 */
  allowMeetIssuance?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [nextAction, setNextAction] = useState(deal.nextAction ?? "");
  // 日付欄は JST の暦日で表示する（UTC 0:00・JST 0:00 のどちらで保存された値も同じ日になり、
  // サーバー描画とブラウザ描画でも一致する）
  const [nextDate, setNextDate] = useState(() => toJstDateStr(deal.nextActionAt));
  const [appointmentDate, setAppointmentDate] = useState(() => toJstDateStr(deal.appointmentDate));
  // 直近の Notion 同期失敗を一時的に表示するフラグ（成功 or 別フィールド更新でクリア）
  const [notionSyncFailed, setNotionSyncFailed] = useState(false);
  // 保存（PATCH）に失敗したときの理由。403 は英語の「Forbidden」ではなく日本語の理由を出す。
  const [saveError, setSaveError] = useState<string | null>(null);
  const [contractDate, setContractDate] = useState(() => toJstDateStr(deal.contractDate));
  const [expectedCloseDate, setExpectedCloseDate] = useState(() => toJstDateStr(deal.expectedCloseDate));
  // 商談日時（T01）。JST固定の "YYYY-MM-DDTHH:mm"（未入力は ""）
  const [meetingStartAt, setMeetingStartAt] = useState(() => toJstDateTimeInput(deal.meetingStartAt));
  const [meetingEndAt, setMeetingEndAt] = useState(() => toJstDateTimeInput(deal.meetingEndAt));
  const meetKey = `${deal.id}:${deal.meetEventId ?? ""}:${deal.meetUrl ?? ""}`;
  const [meetResult, setMeetResult] = useState<{ key: string; url: string; eventId: string | null } | null>(null);
  const meetUrl = meetResult?.key === meetKey ? meetResult.url : deal.meetUrl ?? "";
  const meetEventId = meetResult?.key === meetKey ? meetResult.eventId : deal.meetEventId ?? null;
  const meetInFlight = useRef(false);
  const [meetRetry, setMeetRetry] = useState({ force: false, expected: null as string | null });
  const [meetLoading, setMeetLoading] = useState(false);
  const [meetMessage, setMeetMessage] = useState<string | null>(null);
  const [meetError, setMeetError] = useState<string | null>(null);
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
      // 提案の期日は JST の暦日。存在しない日付なら期日は変えずにアクションだけ保存する
      const nextActionAt = jstDateInputToIso(j.suggestion.next_action_at ?? "");
      if (nextActionAt) setNextDate(j.suggestion.next_action_at);
      patch({
        nextAction: j.suggestion.next_action,
        ...(nextActionAt ? { nextActionAt } : {}),
      });
    }
  }

  async function syncMeet(forceRecreate = false, expectedEventId = meetEventId) {
    if (meetInFlight.current || !canEdit || !allowMeetIssuance) return;
    meetInFlight.current = true;
    setMeetLoading(true);
    setMeetMessage(null);
    setMeetError(null);
    setMeetRetry({ force: forceRecreate, expected: expectedEventId });
    try {
      // Calendar conference generation is asynchronous. Limit automatic checks;
      // the same stored event is reused by the manual retry after this bound.
      let recreate = forceRecreate;
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`/api/deals/${deal.id}/meet`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceRecreate: recreate, ...(recreate ? { expectedEventId } : {}) }),
        });
        const j = await res.json().catch(() => null);
        if (j?.deal) {
          setMeetResult({ key: meetKey, url: j.deal.meetUrl ?? "", eventId: j.deal.meetEventId ?? null });
          setMeetRetry({ force: false, expected: j.deal.meetEventId ?? null });
        }
        if (!res.ok) {
          setMeetError(j?.message ?? "Meet発行に失敗しました。再試行してください。");
          if (j?.deal || res.status === 409) router.refresh();
          return;
        }
        if (res.status === 202 || j?.status === "pending") {
          setMeetMessage(attempt < 3 ? "Meetを発行中です…" : "Meetの発行処理が続いています。しばらくしてから発行状況を確認してください。");
          recreate = false;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000));
          else router.refresh();
          continue;
        }
        if (!j?.deal?.meetUrl) {
          setMeetError("Meet URLを取得できませんでした。再試行してください。");
          return;
        }
        setMeetMessage(meetSyncSuccessMessage({ forceRecreate, previousUrl: meetUrl, nextUrl: j.deal.meetUrl }));
        // 商談ページの他のタブ（商談記録の Meetセッション欄など）も、この後に届くサーバーの状態に追従する。
        router.refresh();
        return;
      }
    } catch {
      setMeetError("Meet連携で通信に失敗しました。保存済みの商談日時は保持されています。再試行してください。");
    } finally {
      meetInFlight.current = false;
      setMeetLoading(false);
    }
  }

  async function copyMeetUrl() {
    if (!meetUrl) return;
    try {
      await navigator.clipboard.writeText(meetUrl);
      setMeetMessage("Meet URLをコピーしました。");
      setMeetError(null);
    } catch {
      setMeetError("URLをコピーできませんでした。Meetリンクを右クリックしてコピーしてください。");
    }
  }

  function canSyncMeet(startIso: string | null, endIso: string | null) {
    return Boolean(startIso && endIso && Date.parse(endIso) > Date.parse(startIso));
  }

  function patch(payload: Record<string, unknown>) {
    start(async () => {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // 保存できなかった入力は、保存されたように残さず元の値に戻す
        if ("nextAction" in payload) setNextAction(deal.nextAction ?? "");
        if ("nextActionAt" in payload) setNextDate(toJstDateStr(deal.nextActionAt));
        if ("appointmentDate" in payload) setAppointmentDate(toJstDateStr(deal.appointmentDate));
        if ("contractDate" in payload) setContractDate(toJstDateStr(deal.contractDate));
        if ("expectedCloseDate" in payload) setExpectedCloseDate(toJstDateStr(deal.expectedCloseDate));
        setSaveError(await saveErrorMessage(res));
        router.refresh();
        return;
      }
      setSaveError(null);
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
        {saveError && (
          <p role="alert" className="text-[13px] text-rose-600 bg-rose-50 border border-rose-200 rounded px-3 py-2">
            {saveError}
          </p>
        )}
        {/* 上段：ステージとフェーズ */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[13px] text-zinc-500">商談プロセスステージ（リージー運用）</Label>
            <Select
              value={deal.pipelineStage ?? "__none__"}
              onValueChange={(v) => patch({ pipelineStage: v === "__none__" ? null : v })}
              disabled={!canEdit}
            >
              <SelectTrigger className="h-9">
                <SelectValue>
                  {(() => {
                    const s = findStageFromRows(deal.pipelineStage, stages);
                    if (!s) return <span className="text-[13px] text-zinc-400">未設定</span>;
                    return (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[13px] font-semibold ${s.bg} ${s.text}`}>
                        {s.label}
                      </span>
                    );
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  <span className="text-[13px] text-zinc-500">未設定</span>
                </SelectItem>
                {(["before", "after", "contract"] as const).map((g: StageGroup) => {
                  const rows = stages.filter((s) => s.group === g && s.active);
                  if (rows.length === 0) return null;
                  return (
                    <div key={g}>
                      <div className="px-2 py-1 text-[12px] font-bold text-zinc-400 uppercase tracking-wider">
                        {STAGE_GROUP_LABEL[g]}
                      </div>
                      {rows.map((row) => {
                        const s = rowToStageDef(row);
                        return (
                          <SelectItem key={row.id} value={s.value}>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[13px] ${s.bg} ${s.text}`}>
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
            <Label className="text-[13px] text-zinc-500">フェーズ（自動連動なし）</Label>
            <Select value={deal.status} onValueChange={(v) => patch({ status: v })} disabled={!canEdit}>
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
            <Label className="text-[13px] text-zinc-500">商談主担当（Deal全体）</Label>
            <Select
              value={deal.owner?.id ?? ""}
              onValueChange={(v) => patch({ ownerUserId: v || null })}
              disabled={!canEdit}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="未割当">
                  {deal.owner && (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="w-5 h-5 rounded-full text-white text-[12px] font-bold flex items-center justify-center"
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
          <div className="@container space-y-1 md:col-span-2">
            <div className="flex items-center justify-between">
              <Label className="text-[13px] text-zinc-500">次回アクション</Label>
              <DueBadge date={deal.nextActionAt} size="sm" />
            </div>
            {/* この欄の幅（画面幅ではない）が 36rem 未満なら、入力を1行使い、期日と「AI提案」は次の行に回す。
                390px のスマホでも、1440px で左カラムの 2/3 しかない PC でも、入力が潰れず文言が読める。
                期日（約190px）と「AI提案」を並べても入力に 15rem 以上残る幅からだけ1行にする。 */}
            <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center">
              <Input
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                onBlur={(e) => patch({ nextAction: e.target.value || null })}
                placeholder="次回やること（AI提案 or 手打ち）"
                className="h-9 w-full min-w-0 @xl:flex-1"
                disabled={pending || !canEdit}
              />
              <div className="flex shrink-0 items-center gap-2">
                <DateInput
                  value={nextDate}
                  onChange={(v) => {
                    const iso = dateInputToPatchValue(v, true);
                    if (iso === undefined) return;
                    setNextDate(v);
                    patch({ nextActionAt: iso });
                  }}
                  disabled={pending || !canEdit}
                />
                {/* 閲覧のみ（操作中の会社での権限）では、AI を呼ぶ「AI提案」を出さない（API も 403 で止める） */}
                {canEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={suggestNext}
                  disabled={suggestLoading}
                  className="h-9 text-[13px] px-2 text-orange-600 hover:bg-orange-50"
                  title="AIに次の一手を提案させる"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {suggestLoading ? "生成中…" : "AI提案"}
                </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* リード獲得経由 ＋ 真横に初回商談日 */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            {/* リード獲得経由（伸縮） */}
            <div className="space-y-1 flex-1 min-w-0">
              <Label className="text-[13px] font-semibold text-zinc-700 inline-flex items-center gap-1.5">
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
                          return <span className="text-[13px] text-zinc-400">未設定</span>;
                        }
                        const c = leadSourceColor(deal.leadSource.name);
                        return (
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[13px] font-bold border ${c.bg} ${c.text} ${c.border}`}
                          >
                            {deal.leadSource.name}
                          </span>
                        );
                      })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      <span className="text-[13px] text-zinc-500">未設定</span>
                    </SelectItem>
                    {leadSources.map((ls) => {
                      const c = leadSourceColor(ls.name);
                      return (
                        <SelectItem key={ls.id} value={ls.id}>
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[13px] font-bold border ${c.bg} ${c.text} ${c.border} ${!ls.active ? "opacity-50" : ""}`}
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
                      className={`inline-block px-2 py-0.5 rounded-full text-[13px] font-bold border ${c.bg} ${c.text} ${c.border}`}
                    >
                      {deal.leadSource.name}
                    </span>
                  );
                })()
              ) : (
                <span className="text-[13px] text-zinc-400">未設定</span>
              )}
            </div>
            {/* 初回商談日（真横・固定幅） */}
            <div className="space-y-1 md:w-[200px] shrink-0">
              <Label className="text-[13px] font-semibold text-zinc-700 inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-orange-500" />
                初回商談日
                {notionSyncFailed && (
                  <span
                    className="text-[12px] font-bold text-rose-600"
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
                    const iso = dateInputToPatchValue(v, false);
                    if (iso === undefined) return;
                    setAppointmentDate(v);
                    patch({ appointmentDate: iso });
                  }}
                  disabled={pending}
                />
              ) : (
                <span className="text-sm font-semibold tabular-nums text-orange-700 block">
                  {appointmentDate || <span className="text-zinc-400 font-normal">未設定</span>}
                </span>
              )}
            </div>
          </div>

          {/* リード獲得メモ（リード獲得経由の補足） */}
          <div className="mt-3 space-y-1">
            <Label className="text-[13px] font-semibold text-zinc-700 inline-flex items-center gap-1.5">
              <NotebookPen className="h-3.5 w-3.5 text-fuchsia-500" />
              リード獲得メモ
              <span className="text-[12px] font-normal text-zinc-400">
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

        {/* 商談日時（開始〜終了）。T01：Meet自動発行・録音準備の起点になる時刻情報。
            FEATURE_MEET が OFF の間は描画しない＝従来どおりの画面。 */}
        {showMeetingDateTime && (
          <div className="pt-3 border-t border-zinc-100">
            <div className="flex items-center gap-2 mb-2">
              <div className="rounded-md bg-zinc-100 p-1.5 text-zinc-500">
                <CalendarClock className="h-3.5 w-3.5" />
              </div>
              <Label className="text-[13px] font-semibold text-zinc-700">商談日時（開始〜終了）</Label>
              <span className="text-[12px] text-zinc-400">
                日本時間。商談予定の管理と記録に使用します
              </span>
            </div>
            <MeetingDateTimeEditor
              dealId={deal.id}
              startAt={deal.meetingStartAt}
              endAt={deal.meetingEndAt}
              canEdit={canEdit}
              disabled={pending || meetLoading}
              onSaved={(startIso, endIso) => {
                setMeetingStartAt(toJstDateTimeInput(startIso));
                setMeetingEndAt(toJstDateTimeInput(endIso));
                if (canSyncMeet(startIso, endIso)) void syncMeet(false);
              }}
            />
            {canEdit && allowMeetIssuance && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {meetUrl ? (
                  <>
                    <Button asChild size="sm" variant="outline" className="h-8">
                      <a href={meetUrl} target="_blank" rel="noreferrer">
                        <Video className="h-3.5 w-3.5" />
                        Meet
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={copyMeetUrl} disabled={meetLoading} aria-label="Meet URLをコピー" className="h-8">
                      <Copy className="h-3.5 w-3.5" />
                      URL
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => syncMeet(false)}
                      disabled={
                        pending ||
                        meetLoading ||
                        !canSyncMeet(jstDateTimeInputToIso(meetingStartAt), jstDateTimeInputToIso(meetingEndAt))
                      }
                      className="h-8"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${meetLoading ? "animate-spin" : ""}`} />
                      同期
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => syncMeet(true)}
                      disabled={
                        pending ||
                        meetLoading ||
                        !canSyncMeet(jstDateTimeInputToIso(meetingStartAt), jstDateTimeInputToIso(meetingEndAt))
                      }
                      className="h-8 text-zinc-500 hover:text-amber-700"
                    >
                      再発行
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => syncMeet(false)}
                    disabled={
                      pending ||
                      meetLoading ||
                      !canSyncMeet(jstDateTimeInputToIso(meetingStartAt), jstDateTimeInputToIso(meetingEndAt))
                    }
                    className="h-8"
                  >
                    <Video className="h-3.5 w-3.5" />
                    {meetLoading ? "発行中..." : meetEventId ? "発行状況を確認" : "Meet発行"}
                  </Button>
                )}
                {allowMeetIssuance && meetMessage && <span role="status" className="text-[12.5px] font-semibold text-orange-700">{meetMessage}</span>}
                {allowMeetIssuance && meetError && <div role="alert" className="text-[12.5px] font-semibold text-rose-600">
                  {meetError}
                  <Button type="button" size="sm" variant="outline" className="ml-2"
                    disabled={meetLoading || !canSyncMeet(jstDateTimeInputToIso(meetingStartAt), jstDateTimeInputToIso(meetingEndAt))}
                    onClick={() => void syncMeet(meetRetry.force, meetRetry.expected)}>Meet連携を再試行</Button>
                </div>}
              </div>
            )}
            {!canEdit && meetUrl && (
              <div className="mt-3">
                <Button asChild size="sm" variant="outline" className="h-8">
                  <a href={meetUrl} target="_blank" rel="noreferrer">
                    <Video className="h-3.5 w-3.5" />
                    Meet
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 受注見込み日（着地予定。営業計画用、KPIには影響しない） */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-zinc-100 p-1.5 text-zinc-500">
                <Target className="h-3.5 w-3.5" />
              </div>
              <Label className="text-[13px] font-semibold text-zinc-700">受注見込み日</Label>
              <span className="text-[12px] text-zinc-400">着地予定（KPIには未反映）</span>
            </div>
            {canEdit ? (
              <>
                <DateInput
                  value={expectedCloseDate}
                  onChange={(v) => {
                    const iso = dateInputToPatchValue(v, false);
                    if (iso === undefined) return;
                    setExpectedCloseDate(v);
                    patch({ expectedCloseDate: iso });
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
                    className="h-8 text-[13px] text-zinc-500 hover:text-rose-600"
                  >
                    クリア
                  </Button>
                )}
              </>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-amber-700">
                {expectedCloseDate || <span className="text-zinc-400 font-normal">未設定</span>}
              </span>
            )}
          </div>
        </div>

        {/* 受注計上日（KPI実績の集計基準。受注になった瞬間に自動で本日付がセット、ここで上書き編集可） */}
        <div className="pt-3 border-t border-zinc-100">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="rounded-md bg-zinc-100 p-1.5 text-zinc-500">
                <FileSignature className="h-3.5 w-3.5" />
              </div>
              <Label className="text-[13px] font-semibold text-zinc-700">受注計上日</Label>
              <span className="text-[12px] text-zinc-400">KPI実績はこの日付で集計</span>
            </div>
            {canEdit ? (
              <>
                <DateInput
                  value={contractDate}
                  onChange={(v) => {
                    const iso = dateInputToPatchValue(v, false);
                    if (iso === undefined) return;
                    setContractDate(v);
                    patch({ contractDate: iso });
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
                    className="h-8 text-[13px] text-zinc-500 hover:text-rose-600"
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
                      // 今日は JST の暦日（JST 0:00〜8:59 に UTC の日付で前日にならないように）
                      const today = toJstDateStr(new Date());
                      setContractDate(today);
                      patch({ contractDate: new Date(today).toISOString() });
                    }}
                    className="h-8 text-[13px] text-orange-600 hover:bg-orange-50"
                  >
                    本日でセット
                  </Button>
                )}
              </>
            ) : (
              <span className="text-sm font-semibold tabular-nums text-orange-700">
                {contractDate || <span className="text-zinc-400 font-normal">未設定</span>}
              </span>
            )}
            {contractDate && (
              <Badge
                variant="success"
                className="ml-auto text-[12px]"
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
