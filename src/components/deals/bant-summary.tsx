"use client";
import { type MouseEvent, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
  BadgeCheck,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Crown,
  Link as LinkIcon,
  Pencil,
  RefreshCw,
  Save,
  Sparkles,
  Target,
  Wallet,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { toReadableText } from "@/lib/text-format";
import { DEAL_NAVIGATE_EVENT } from "@/components/deals/deal-navigation";
import {
  bantText,
  countBantCardStatuses,
  cleanText,
  repairUtf8Mojibake,
  resolveBantCardView,
  resolveUpdateMode,
  type BantKey,
  type BantMeetingRef,
  type BantCardStatus,
  type BantValue,
} from "@/components/deals/bant-summary-utils";

function statusBadge(status: BantCardStatus) {
  if (status === "unreviewed") {
    return { label: "未判定", variant: "outline" as const, className: "text-zinc-600" };
  }
  if (status === "confirmed") {
    return { label: "確定", variant: "success" as const, className: "" };
  }
  if (status === "estimated") {
    return { label: "推定", variant: "warning" as const, className: "" };
  }
  return { label: "未確定", variant: "danger" as const, className: "" };
}

const fields = [
  {
    key: "budget",
    title: "Budget",
    label: "予算",
    icon: Wallet,
    iconClass: "bg-orange-50 text-orange-700",
    borderClass: "border-l-orange-400",
  },
  {
    key: "authority",
    title: "Authority",
    label: "決裁者",
    icon: Crown,
    iconClass: "bg-amber-50 text-amber-700",
    borderClass: "border-l-amber-400",
  },
  {
    key: "need",
    title: "Need",
    label: "課題",
    icon: AlertCircle,
    iconClass: "bg-rose-50 text-rose-700",
    borderClass: "border-l-rose-400",
  },
  {
    key: "timeline",
    title: "Timeline",
    label: "時期",
    icon: CalendarClock,
    // Authority と同色にならないよう、同系統内の無彩色で区別する
    iconClass: "bg-zinc-100 text-zinc-700",
    borderClass: "border-l-zinc-400",
  },
] as const satisfies ReadonlyArray<{
  key: BantKey;
  title: string;
  label: string;
  icon: typeof Wallet;
  iconClass: string;
  borderClass: string;
}>;

type BantSummaryProps = {
  dealId: string;
  initial: BantValue | null;
  bantUpdatedAt: Date | string | null;
  meetingsCount: number;
  canEdit: boolean;
  meetings?: BantMeetingRef[];
};

type BantDraft = Record<BantKey, string> & { summary: string };

function BantFieldText({ text, label }: { text: string; label: string }) {
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      // 展開中も、元の6行を超えるかどうかでボタンの必要性を判断する。
      setOverflows(Number.isFinite(lineHeight) && element.scrollHeight > lineHeight * 6 + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-w-0">
      <p
        ref={textRef}
        id={textId}
        data-bant-text
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 [overflow-wrap:anywhere]",
          !expanded && "line-clamp-6",
        )}
      >
        {/* 表示は読みやすい体裁（■ 見出し／・箇条書き／①）に整形。保存データは元のまま。 */}
        {toReadableText(text)}
      </p>
      {overflows && (
        <button
          type="button"
          className="mt-2 inline-flex items-center gap-1 rounded px-1 py-1 text-[13px] font-medium text-orange-700 hover:bg-orange-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500"
          aria-controls={textId}
          aria-expanded={expanded}
          aria-label={expanded ? `${label}を折りたたむ` : `${label}の全文を表示`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "折りたたむ" : "全文を表示"}
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

/**
 * 出典の商談記録は「商談記録」タブにあり、BANTの「準備・BANT」タブからは非表示のパネル内になる。
 * 素のページ内リンクでは移動できないため、商談詳細のタブ切替（DealDetailTabs）へ移動を依頼する。
 * タブの無い画面では通常のリンクとして動かす。
 */
function openSourceMeeting(event: MouseEvent<HTMLAnchorElement>, href: string | undefined) {
  if (!href?.startsWith("#") || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const sectionId = href.slice(1);
  if (!document.getElementById(sectionId)?.closest("[data-deal-tab]")) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent(DEAL_NAVIGATE_EVENT, { detail: { sectionId } }));
}

/** 商談保存・分析後の自動集約が失敗した記録。次に集約が成功すると消える。 */
function readAutoAggregationFailure(bant: BantValue): { message: string; at: string } | null {
  const raw: Record<string, unknown> = bant;
  const failure = raw.lastError;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const { message, at } = failure as Record<string, unknown>;
  if (typeof message !== "string" || !message.trim() || typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return { message: message.trim(), at };
}

export function BantSummary(props: BantSummaryProps) {
  // 別の商談へ移動した場合は、編集中の入力や通信結果を引き継がない。
  return <BantSummaryContent key={props.dealId} {...props} />;
}

function BantSummaryContent({
  dealId,
  initial,
  bantUpdatedAt,
  meetingsCount,
  canEdit,
  meetings = [],
}: BantSummaryProps) {
  const router = useRouter();
  const editId = useId();
  const confirmationId = useId();
  const [mutationResult, setMutationResult] = useState<{
    baseInitial: BantValue | null;
    bant: BantValue;
  } | null>(null);
  // 成功レスポンスは refresh まで表示し、新しいサーバーpropsが届いたらそちらを使う。
  const activeResult = mutationResult?.baseInitial === initial ? mutationResult : null;
  const current = activeResult?.bant ?? initial;
  const v = useMemo(() => {
    const next = current ?? {};
    const summary = typeof next.summary === "string" ? repairUtf8Mojibake(next.summary) : next.summary;
    return summary === next.summary ? next : { ...next, summary };
  }, [current]);
  const [editState, setEditState] = useState<{ baseline: BantDraft; draft: BantDraft } | null>(null);
  const draft = editState?.draft ?? null;
  const editing = draft !== null;
  const [pending, start] = useTransition();
  const [generating, setGenerating] = useState(false);
  // 同じイベント内の2回目のクリックは、再描画前で disabled がまだ効かない。Meet発行（meetInFlight）と同じく ref で止める。
  const regenerateInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);

  const cards = useMemo(
    () => fields.map((f) => ({ ...f, view: resolveBantCardView(v, f.key, meetings) })),
    [meetings, v],
  );
  const statusCounts = countBantCardStatuses(cards.map((card) => card.view));
  const autoFailure = readAutoAggregationFailure(v);
  const mode = resolveUpdateMode(v);
  const isEmpty =
    cards.every((card) => !card.view.value) &&
    !cleanText(v.summary);

  function setField(key: keyof BantDraft, value: string) {
    setEditState((current) => current ? {
      ...current,
      draft: { ...current.draft, [key]: value },
    } : current);
  }

  function toggleEditing() {
    setError(null);
    if (editing) {
      setEditState(null);
      return;
    }
    const nextDraft = {
      budget: bantText(v, "budget"),
      authority: bantText(v, "authority"),
      need: bantText(v, "need"),
      timeline: bantText(v, "timeline"),
      summary: v.summary ?? "",
    };
    setEditState({ baseline: nextDraft, draft: nextDraft });
  }

  function regenerate() {
    if (regenerateInFlight.current) return;
    regenerateInFlight.current = true;
    setError(null);
    setGenerating(true);
    start(async () => {
      try {
        const r = await fetch(`/api/deals/${dealId}/summarize-bant`, { method: "POST" });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          throw new Error(typeof j?.error === "string" ? j.error : `AI再集約に失敗しました（HTTP ${r.status}）。`);
        }
        if (!j?.bant || typeof j.bant !== "object" || Array.isArray(j.bant)) {
          throw new Error("AI再集約の結果を確認できませんでした。もう一度お試しください。");
        }
        setMutationResult({ baseInitial: initial, bant: j.bant });
        setUsedFallback(!!j.fallback);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "AI再集約に失敗しました。もう一度お試しください。");
      } finally {
        regenerateInFlight.current = false;
        setGenerating(false);
      }
    });
  }

  function save() {
    if (!editState) return;
    setError(null);
    // 閲覧用の補完値や編集中に更新された項目まで、手動編集として送信しない。
    const changes = Object.fromEntries(
      Object.entries(editState.draft).filter(
        ([key, value]) => value !== editState.baseline[key as keyof BantDraft],
      ),
    );
    if (Object.keys(changes).length === 0) {
      setEditState(null);
      return;
    }
    start(async () => {
      try {
        const r = await fetch(`/api/deals/${dealId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bant: changes }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          throw new Error(typeof j?.error === "string" ? j.error : `BANTを保存できませんでした（HTTP ${r.status}）。`);
        }
        const saved = j?.deal?.bant;
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
          throw new Error("BANTの保存結果を確認できませんでした。入力内容を確認して、もう一度お試しください。");
        }
        setMutationResult({ baseInitial: initial, bant: saved });
        setUsedFallback(false);
        setEditState(null);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "BANTを保存できませんでした。もう一度お試しください。");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
            <Target className="h-4 w-4" />
          </div>
          <span>BANT情報</span>
          {mode && (
            <Badge
              variant={mode === "auto" ? "success" : "outline"}
              className={cn("gap-1", mode === "manual" && "border-orange-200 bg-orange-50 text-orange-700")}
            >
              {mode === "auto" ? <BadgeCheck className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
              {mode === "auto" ? "自動更新" : "手動編集"}
            </Badge>
          )}
          {bantUpdatedAt && (
            <span className="inline-flex items-center gap-1 text-[13px] font-normal text-zinc-500">
              <RefreshCw className="h-3 w-3" />
              {formatDate(bantUpdatedAt)} 更新
            </span>
          )}
          <span className="ml-auto inline-flex flex-wrap items-center gap-1.5">
            {canEdit && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={regenerate}
                  disabled={generating || pending || meetingsCount === 0}
                  title={meetingsCount === 0 ? "商談記録がまだありません" : "全商談記録からAIで再集約"}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {generating ? "AI集約中..." : "AI再集約"}
                </Button>
                <Button
                  size="sm"
                  variant={editing ? "outline" : "ghost"}
                  onClick={toggleEditing}
                  disabled={pending || generating}
                >
                  {editing ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" /> 閉じる
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" /> 手動編集
                    </>
                  )}
                </Button>
              </>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </p>
        )}
        {usedFallback && (
          <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
            <AlertCircle className="h-3 w-3" />
            AIキー未設定のため簡易集約で表示しています。必要な項目は手動編集から登録してください。
          </p>
        )}
        {autoFailure && (
          <p role="status" className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              BANTの自動集約に失敗しました（{formatDate(autoFailure.at)}）。{autoFailure.message}
              {canEdit && "「AI再集約」で再実行できます。"}
            </span>
          </p>
        )}

        {isEmpty ? (
          <div className="rounded-lg border-2 border-dashed border-orange-200 bg-white/70 px-4 py-6 text-center">
            <Target className="mx-auto mb-2 h-8 w-8 text-orange-300" />
            <p className="text-sm text-zinc-600">まだBANT情報が登録されていません。</p>
            <p className="mt-1 text-[13px] text-zinc-500">
              まずは手動編集から登録できます。商談履歴がある場合だけ、必要に応じてAI再集約を使ってください。
            </p>
          </div>
        ) : (
          <>
            <section aria-labelledby={confirmationId} className="rounded-lg border border-orange-100 bg-white/75 px-3 py-2">
              <h3 id={confirmationId} className="mb-2 text-[13px] font-medium text-zinc-700">BANT確認状況</h3>
              <ul className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-live="polite" aria-atomic="true">
                {(["confirmed", "estimated", "unknown", "unreviewed"] as const).map((status) => {
                  const badge = statusBadge(status);
                  return (
                    <li key={status}>
                      <Badge variant={badge.variant} className={cn("whitespace-nowrap", badge.className)}>
                        {status === "unreviewed" ? "手動未判定" : badge.label} {statusCounts[status]}項目
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </section>

            {cleanText(v.summary) && (
              <div className="min-w-0 rounded-lg bg-gradient-to-br from-orange-500/95 to-amber-500/95 p-4 text-white shadow-sm">
                <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-wide text-white/80">
                  <Sparkles className="h-3 w-3" />
                  総合所感
                </p>
                <p data-bant-summary className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{v.summary}</p>
              </div>
            )}

            <div className="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-2">
              {cards.map((card) => {
                const Icon = card.icon;
                const badge = statusBadge(card.view.status);
                return (
                  <section
                    key={card.key}
                    aria-label={`${card.title} ${card.label}`}
                    className={cn(
                      "min-h-[150px] min-w-0 rounded-lg border border-zinc-200 border-l-4 bg-white p-4 shadow-sm [overflow-wrap:anywhere]",
                      card.borderClass,
                    )}
                  >
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className={cn("rounded-md p-1.5", card.iconClass)}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-semibold uppercase tracking-wide text-zinc-500">
                            {card.title}
                          </p>
                          <p className="text-sm font-semibold text-zinc-900">{card.label}</p>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <Badge
                          variant={badge.variant}
                          className={badge.className}
                          title={card.view.status === "unreviewed" ? "手動入力のため、内容の確実性は判定していません。" : undefined}
                        >
                          {badge.label}
                        </Badge>
                        {card.view.isManual && (
                          <Badge variant="outline" className="border-orange-200 bg-orange-50 text-orange-700">
                            手動
                          </Badge>
                        )}
                      </div>
                    </div>

                    {card.view.value ? (
                      <BantFieldText key={card.view.value} text={card.view.value} label={card.label} />
                    ) : (
                      <p className="text-sm italic text-zinc-400">未確認</p>
                    )}

                    {card.view.source && (
                      <div className="mt-3 text-[13px] leading-relaxed text-zinc-500">
                        {card.view.source.href ? (
                          <a
                            // 新しいタブで開く・リンクをコピーした場合も商談記録タブ（id: record）で開く。
                            href={card.view.source.href.startsWith("#meeting-") ? `?tab=record${card.view.source.href}` : card.view.source.href}
                            onClick={(event) => openSourceMeeting(event, card.view.source?.href)}
                            className="inline-flex items-center gap-1 font-medium text-amber-700 hover:text-amber-800 hover:underline"
                          >
                            <LinkIcon className="h-3 w-3" />
                            {card.view.source.label}
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <LinkIcon className="h-3 w-3" />
                            {card.view.source.label}
                          </span>
                        )}
                        {card.view.source.quote && (
                          <span className="mt-1 block whitespace-pre-wrap text-zinc-600">
                            「{card.view.source.quote}」
                          </span>
                        )}
                      </div>
                    )}

                    {card.view.aiSuggestion && (
                      <div className="mt-3 rounded-md border border-amber-100 bg-amber-50/70 px-3 py-2">
                        <p className="mb-1 text-[12.5px] font-semibold text-amber-700">AI提案（未反映）</p>
                        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-amber-900">
                          {card.view.aiSuggestion}
                        </p>
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}

        {draft && canEdit && (
          <div className="space-y-3 border-t border-orange-100 pt-3">
            <p className="inline-flex items-center gap-1 text-[13px] text-zinc-500">
              <Pencil className="h-3 w-3 text-orange-500" />
              手動編集した項目は自動更新で上書きされません。
            </p>
            <p className="text-[13px] text-zinc-500">段落ごとに改行すると、表示にも反映されます。</p>
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`${editId}-${f.key}`} className="text-[13px] text-zinc-600">
                  {f.title} {f.label}
                </Label>
                <Textarea
                  id={`${editId}-${f.key}`}
                  value={draft[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                  disabled={pending || generating}
                  rows={2}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor={`${editId}-summary`} className="text-[13px] text-zinc-600">総合所感</Label>
              <Textarea
                id={`${editId}-summary`}
                value={draft.summary}
                onChange={(e) => setField("summary", e.target.value)}
                disabled={pending || generating}
                rows={3}
                placeholder="案件全体のBANT総合所感と次に取りに行くべき情報"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={toggleEditing} disabled={pending || generating}>
                キャンセル
              </Button>
              <Button size="sm" variant="primary" onClick={save} disabled={pending}>
                <Save className="h-3.5 w-3.5" />
                {pending ? "保存中..." : "BANTを保存"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
