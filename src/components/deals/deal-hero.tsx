"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check, Copy, CornerDownRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CompanyLogo } from "@/components/ui/company-logo";
import { OwnerBadge } from "@/components/ui/owner-badge";
import { DueBadge } from "@/components/ui/due-badge";
import { cn } from "@/lib/utils";
import { DEAL_NAVIGATE_EVENT } from "@/components/deals/deal-detail-tabs";
import {
  DEAL_MEET_ATTENTION_ACTION,
  DEAL_MEET_ATTENTION_CAPTION,
  DEAL_MEET_ATTENTION_LABEL,
  DEAL_PHASE_CAPTION,
  DEAL_PHASE_LABEL,
  DEAL_PHASE_STEPS,
  dealPhaseStepIndex,
  deriveDealPrimaryAction,
  type DealPrimaryAction,
  type DealPhase,
} from "@/lib/deal-phase";
import { STATUS_LABEL, statusColor, type DealStatusValue } from "@/lib/deal-status";
import type { RecordingRoutePresentation } from "@/lib/meetings/recording-route";

/**
 * 商談ページの先頭に置く要約と主操作（T15）。
 *
 * ここだけ読めば「どの会社の・どの商談が・いまどの場面で・次に何を押すか」が分かる、
 * という一点に絞る。項目を増やすほど読む時間が延びるので、
 * 詳細は下のセクションに任せ、ここには判断に要る最小限だけを置く。
 */

export type DealHeroProps = {
  dealId: string;
  companyId: string;
  companyName: string;
  companyLogoUrl?: string | null;
  companyLogoColor?: string | null;
  dealTitle: string;
  status: DealStatusValue;
  phase: DealPhase;
  owner?: { id: string; name: string; avatarColor: string | null } | null;
  /** 表示用に整形済みの商談日時（JST）。未設定なら null。 */
  meetingRangeLabel: string | null;
  /** 自社発行MeetのURL（deals.meet_url）。自社Meetの記録ルート（recordingRoute.ownMeet）以外では表示しない。 */
  meetUrl: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  industryLabel: string | null;
  fiscalMonth: string | null;
  hasMinutes: boolean;
  recordingRoute: RecordingRoutePresentation;
  /**
   * T16：商談後に自社Meetの記録を自動で取り込めず、確認が必要（dealMeetNeedsAttention）。
   * true のとき「終了直後／商談の記録を取り込んでいます」のままにせず、要対応として出す。
   */
  meetNeedsAttention?: boolean;
  backHref: string;
  /**
   * ToDo追加・削除などの補助操作。主操作ボタンと視覚的に喧嘩しないよう、
   * 要約カード本体ではなく最上段（戻るリンクの対角）にまとめて置く。
   */
  actions?: React.ReactNode;
};

export function DealHero(props: DealHeroProps) {
  const [copied, setCopied] = useState(false);
  // T21/T24：会議種別を自社Meet以外へ変えても meet_url は残る（Calendar予定も消さない）。
  // 残った自社MeetのURLを先方会議・対面の参加先として見せないよう、自社Meetの商談のときだけ使う
  // （自動記録フラグOFFの自社Meetも、参加先は同じ自社Meet）。
  const meetUrl = props.recordingRoute.ownMeet ? props.meetUrl : null;
  const meetAttention = props.meetNeedsAttention === true;
  const primary = meetAttention
    ? DEAL_MEET_ATTENTION_ACTION
    : routeAwarePrimaryAction(
        deriveDealPrimaryAction(props.phase, {
          meetUrl,
          hasSchedule: props.meetingRangeLabel != null,
          hasMinutes: props.hasMinutes,
        }),
        props.phase,
        props.recordingRoute,
      );
  const phaseLabel = meetAttention ? DEAL_MEET_ATTENTION_LABEL : DEAL_PHASE_LABEL[props.phase];
  const phaseCaption = meetAttention
    ? DEAL_MEET_ATTENTION_CAPTION
    : routeAwarePhaseCaption(props.phase, props.recordingRoute);
  const stepIndex = dealPhaseStepIndex(props.phase);

  // 遷移先セクションが別タブにある場合もあるため、直接スクロールせず
  // DealDetailTabs に「このセクションへ」とだけ伝える（タブ切替→スクロールは向こうの仕事）。
  const scrollTo = useCallback((sectionId: string) => {
    window.dispatchEvent(new CustomEvent(DEAL_NAVIGATE_EVENT, { detail: { sectionId } }));
  }, []);

  const copyMeetUrl = useCallback(async () => {
    if (!meetUrl) return;
    try {
      await navigator.clipboard.writeText(meetUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // クリップボードが使えない環境では黙って何もしない（URLは下に表示済み）
    }
  }, [meetUrl]);

  return (
    <div className="border-b border-zinc-200 bg-white">
      <div className="px-6 pt-4 pb-5 sm:px-8">
        {/* 最上段：左に戻り導線、右に補助操作。
            主操作（右カードの1ボタン）から離すことで、ボタン同士の密集を避ける */}
        <div className="flex min-h-8 items-center justify-between gap-4">
          <Link
            href={props.backHref}
            className="inline-flex items-center gap-1.5 text-[13px] text-zinc-500 hover:text-zinc-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            商談一覧に戻る
          </Link>
          {props.actions && (
            <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
          {/* 左：だれの・どの商談か */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <CompanyLogo
                name={props.companyName}
                logoUrl={props.companyLogoUrl ?? null}
                logoColor={props.companyLogoColor ?? null}
                size="md"
              />
              <div className="min-w-0">
                <Link
                  href={`/companies/${props.companyId}`}
                  className="block truncate text-[13px] text-zinc-500 hover:text-zinc-800"
                >
                  {props.companyName}
                </Link>
                <h1 className="truncate text-[21px] font-semibold leading-tight tracking-tight text-zinc-900">
                  {props.dealTitle}
                </h1>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <Badge variant={statusColor(props.status)}>{STATUS_LABEL[props.status]}</Badge>
              {props.owner && <OwnerBadge owner={props.owner} size="sm" />}
              {props.meetingRangeLabel && (
                <span className="text-[13px] tabular-nums text-zinc-600">
                  {props.meetingRangeLabel}
                </span>
              )}
              {props.industryLabel && (
                <span className="text-[13px] text-zinc-500">{props.industryLabel}</span>
              )}
              {props.fiscalMonth && (
                <span className="text-[13px] text-zinc-500">決算月 {props.fiscalMonth}</span>
              )}
            </div>

            <div
              data-testid="hero-recording-route"
              className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[12px] font-medium text-zinc-500">記録ルート</span>
                <span className="text-[13px] font-semibold text-zinc-900">
                  {props.recordingRoute.ownerLabel}・{props.recordingRoute.routeLabel}
                </span>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-zinc-600">
                <span className="font-medium text-zinc-700">次にすること：</span>
                {props.recordingRoute.heroAction}
              </p>
            </div>

            {/* 次の一手：商談後にいちばん効く情報なので要約に常設する */}
            {props.nextAction && (
              <div className="mt-3 flex items-start gap-2 text-[14px] text-zinc-700">
                <CornerDownRight className="mt-1 h-3.5 w-3.5 shrink-0 text-zinc-400" />
                <span className="min-w-0">
                  <span className="text-zinc-500">次の一手 </span>
                  {props.nextAction}
                </span>
                {props.nextActionAt && (
                  <DueBadge date={props.nextActionAt} size="sm" className="mt-0.5 shrink-0" />
                )}
              </div>
            )}
          </div>

          {/* 右：いまの場面と、いま押すべき操作を1つだけ */}
          <div className="w-full shrink-0 lg:w-[320px]">
            <div className="rounded-2xl border border-zinc-200/90 bg-zinc-50/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <span
                  data-testid="hero-phase-label"
                  className={cn(
                    "text-[13px] font-medium",
                    meetAttention ? "text-amber-700" : "text-zinc-800",
                  )}
                >
                  {phaseLabel}
                </span>
                <PhaseSteps current={stepIndex} />
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
                {phaseCaption}
              </p>

              <div className="mt-3">
                {primary.href ? (
                  <Button asChild variant="primary" className="w-full justify-center">
                    <a href={primary.href} target="_blank" rel="noopener noreferrer">
                      {primary.label}
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="w-full justify-center"
                    onClick={() => primary.targetSectionId && scrollTo(primary.targetSectionId)}
                  >
                    {primary.label}
                  </Button>
                )}
                <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-500">{primary.hint}</p>
              </div>

              {/* Meet URL は「参加」と別に、共有のためのコピーだけ添える */}
              {meetUrl && (
                <div className="mt-3 flex items-center gap-2 border-t border-zinc-200/80 pt-3">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-500">
                    {meetUrl.replace(/^https?:\/\//, "")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={copyMeetUrl}
                    title="Meet URLをコピー"
                    aria-label="Meet URLをコピー"
                    className="shrink-0 text-zinc-500"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5" />
                        コピー済み
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        コピー
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function routeAwarePrimaryAction(
  primary: DealPrimaryAction,
  phase: DealPhase,
  route: RecordingRoutePresentation,
): DealPrimaryAction {
  if (route.kind === "undecided") {
    return {
      kind: "collect_artifacts",
      label: "会議種別を選ぶ",
      targetSectionId: "group-record",
      href: null,
      hint: "商談記録で主催者・形式を選ぶと、正しい記録ルートが表示されます",
    };
  }

  // 日時の保存でMeetまで発行されるのは自社Meetだけ。先方会議・対面ではMeet発行を案内しない。
  if (primary.kind === "set_schedule" && !route.ownMeet) {
    return { ...primary, hint: "商談予定の管理と記録に使います。この会議種別ではMeetを発行しません" };
  }

  // 自動記録フラグOFF（切り戻し時）の自社Meetは、Meet側で何も記録されない。
  // 「Luma側の録音操作は不要」とは言わず、商談記録のタブ音声録音へ案内する（T16：OFFは現行と同じ画面）。
  if (primary.kind === "join_meet" && route.kind === "browser") {
    return {
      ...primary,
      hint: "新しいタブで開きます。録音は商談記録の「ライブ商談録音」で「タブ音声」を選んで開始します",
    };
  }

  if (primary.kind === "issue_meet" && route.kind === "microphone") {
    if (phase === "scheduled") {
      return {
        kind: "set_next_action",
        label: "事前準備を確認する",
        targetSectionId: "section-preparation",
        href: null,
        hint: "対面商談のブリーフと過去のBANTを確認します",
      };
    }
    return {
      kind: "collect_artifacts",
      label: "マイク録音を開く",
      targetSectionId: "section-record",
      href: null,
      hint: "ライブ商談録音の「マイクのみ」を使用します",
    };
  }

  // 先方会議のURLを保存する項目は無い（meet_url は自社発行Meet専用）。参加は先方の招待から行う。
  if (primary.kind === "issue_meet" && route.kind === "manual") {
    return {
      kind: "set_next_action",
      label: "会議情報を確認する",
      targetSectionId: "section-deal-status",
      href: null,
      hint:
        phase === "scheduled"
          ? "先方から共有された会議URLと日時を確認します"
          : "先方から共有された会議URLで参加します。自動記録は行わず、終了後に受領した成果物を手動添付します",
    };
  }

  return primary;
}

function routeAwarePhaseCaption(
  phase: DealPhase,
  route: RecordingRoutePresentation,
): string {
  if (route.kind === "undecided") {
    return "会議種別を選択して、記録方法を確定してください";
  }
  if (phase === "imminent" || phase === "live") {
    if (route.kind === "manual") {
      return "会議に参加し、終了後に受領した成果物を手動添付します";
    }
    if (route.kind === "microphone") {
      return "商談記録の「マイクのみ」で録音します";
    }
    if (route.kind === "browser") {
      return "Meetに参加し、商談記録の「タブ音声」で録音します";
    }
  }
  if (phase === "wrapup") {
    if (route.kind === "manual") {
      return "受領した議事録・文字起こし・録画を手動添付します";
    }
    if (route.kind === "microphone") {
      return "マイク録音の保存・解析結果を確認します";
    }
    if (route.kind === "browser") {
      return "ブラウザ録音の保存・解析結果を確認します";
    }
  }
  return DEAL_PHASE_CAPTION[phase];
}

/** 準備→商談→記録→推進 の4点。線1本と点だけで現在地を示す。 */
function PhaseSteps({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {DEAL_PHASE_STEPS.map((step, i) => (
        <span
          key={step.id}
          title={step.label}
          className={cn(
            "h-1.5 rounded-full transition-all",
            i === current ? "w-5 bg-orange-500" : "w-1.5 bg-zinc-300",
          )}
        />
      ))}
    </div>
  );
}
