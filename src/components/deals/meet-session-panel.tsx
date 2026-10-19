"use client";

/**
 * Meetセッションパネル（T16）
 *
 * 商談「前・中・後」の進行状態を1枚にまとめて表示する。
 * このパネルはMeet側の自動記録の状態表示と、手動トリガーの導線だけを持つ。
 * 自社発行Meetの画面にはブラウザ録音（開始・停止・送信）を置かず、取得できなかった成果物は
 * 手動添付（UploadRecording）で補う（T16 AC8）。
 * enabled=false のときは何も描画しないので、フラグOFFの画面は現行のまま。
 */

import * as React from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { toJstDateTimeInput } from "@/lib/meeting-datetime";

export type MeetSessionStatus = {
  meetUrl: string | null;
  meetSpaceName: string | null;
  configStatus: string | null;
  configError: string | null;
  artifactStatus: string | null;
  artifactError: string | null;
  attempts: number;
  checkedAt: string | null;
  conferenceRecordId: string | null;
  latestMeetingId: string | null;
  phase: string;
};

type Props = {
  dealId: string;
  enabled: boolean;
  initial: MeetSessionStatus;
  canEdit: boolean;
};

/** 4ステップの進行。フェーズごとに「今どこか」を1つだけ指す。 */
const STEPS = ["日時設定", "Meet発行・自動設定", "商談・自動記録", "成果物取得・AI分析"] as const;

const PHASE_STEP: Record<string, number> = {
  no_schedule: 0,
  scheduled_unissued: 1,
  scheduled: 1,
  configured: 1,
  config_failed: 1,
  in_progress: 2,
  waiting_artifacts: 3,
  fetching: 3,
  analyzing: 3,
  recorded: 3,
  completed: 3,
  needs_attention: 3,
};

const PHASE_LABEL: Record<string, string> = {
  no_schedule: "商談日時が未設定です",
  scheduled_unissued: "商談前（Meet未発行）",
  scheduled: "商談前（Meet発行済み）",
  configured: "商談前（自動記録の準備完了）",
  config_failed: "商談前（自動記録の設定に失敗）",
  in_progress: "商談中",
  waiting_artifacts: "商談後（成果物待ち）",
  fetching: "成果物を取得中",
  analyzing: "AI分析中",
  // 別経路（手入力のテキスト記録など）で記録は残せたが、AI分析はまだ（商談履歴の「分析を実行」待ち）。
  recorded: "記録あり（AI分析は未実施）",
  completed: "AI分析まで完了",
  needs_attention: "確認が必要です",
};

/** ポーリングを回すのは進行中のフェーズだけ。落ち着いたら止める。 */
const POLLING_PHASES = new Set(["waiting_artifacts", "fetching", "analyzing"]);
const POLL_INTERVAL_MS = 15_000;

/**
 * サーバーから届いた状態（props の initial）の中身を表すキー。
 * 商談ページは全タブを mount したまま hidden で切り替えるので、このパネルは作り直されない。
 * Meet の発行・再発行や日時変更の後の router.refresh() で新しい initial が届いたとき、
 * キーが変わったら表示中の状態をサーバーの値に置き換える（変わらなければポーリング結果を保つ）。
 */
export function meetSessionStatusKey(status: MeetSessionStatus): string {
  return JSON.stringify([
    status.meetUrl,
    status.meetSpaceName,
    status.configStatus,
    status.configError,
    status.artifactStatus,
    status.artifactError,
    status.attempts,
    status.checkedAt,
    status.conferenceRecordId,
    status.latestMeetingId,
    status.phase,
  ]);
}

export function MeetSessionPanel({ dealId, enabled, initial, canEdit }: Props) {
  const [status, setStatus] = React.useState<MeetSessionStatus>(initial);
  const [pending, setPending] = React.useState<null | "configure" | "artifacts">(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  // サーバーの新しい状態に追従する（描画中に前回の initial と比べて差し替える React の定石）。
  // 実行中の操作（pending）と案内（notice）はそのまま残す。URL が変わったときだけ「コピーしました」を消し、
  // 古い URL をコピーしたように見せない。
  const initialKey = meetSessionStatusKey(initial);
  const [syncedKey, setSyncedKey] = React.useState(initialKey);
  if (syncedKey !== initialKey) {
    setSyncedKey(initialKey);
    if (initial.meetUrl !== status.meetUrl) setCopied(false);
    setStatus(initial);
  }

  const phase = status.phase;
  const shouldPoll = enabled && POLLING_PHASES.has(phase);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/deals/${dealId}/meet/status`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { status?: MeetSessionStatus };
      if (json.status) setStatus(json.status);
    } catch {
      // 一時的な通信失敗でパネルを壊さない（次のポーリングで拾い直す）
    }
  }, [dealId]);

  React.useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, refresh]);

  if (!enabled) return null;

  const post = async (kind: "configure" | "artifacts") => {
    setPending(kind);
    setNotice(null);
    try {
      const path = kind === "configure" ? "configure" : "artifacts";
      const res = await fetch(`/api/deals/${dealId}/meet/${path}`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      setNotice(json.message ?? json.error ?? (res.ok ? "実行しました。" : "実行に失敗しました。"));
      await refresh();
    } catch {
      setNotice("通信に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setPending(null);
    }
  };

  const copyUrl = async () => {
    if (!status.meetUrl) return;
    try {
      await navigator.clipboard.writeText(status.meetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice("URLをコピーできませんでした。手動で選択してコピーしてください。");
    }
  };

  const currentStep = PHASE_STEP[phase] ?? 0;
  const busy = pending !== null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Video className="h-4 w-4 text-orange-500" />
            Meetセッション
          </CardTitle>
          <Badge variant={phaseBadgeVariant(phase)}>{PHASE_LABEL[phase] ?? phase}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* 進行（細い線と小さい文字だけの控えめなステッパー） */}
        <div>
          <div className="flex gap-1">
            {STEPS.map((step, index) => (
              <div key={step} className="flex-1">
                <div
                  className={cn(
                    "h-px w-full",
                    index <= currentStep ? "bg-orange-400" : "bg-zinc-200",
                  )}
                />
                <div
                  className={cn(
                    "mt-1.5 text-[12.5px] leading-tight",
                    index === currentStep ? "font-medium text-zinc-900" : "text-zinc-400",
                  )}
                >
                  {step}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Meet URL */}
        <div className="space-y-2">
          {status.meetUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="primary" size="sm">
                <a href={status.meetUrl} target="_blank" rel="noopener noreferrer">
                  Meetに参加
                </a>
              </Button>
              <Button variant="outline" size="sm" onClick={copyUrl}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? "コピーしました" : "URLをコピー"}
              </Button>
              <span className="truncate text-[13px] text-zinc-500">{status.meetUrl}</span>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              Meet URLがまだ発行されていません。商談日時を設定してMeetを発行してください。
            </p>
          )}
        </div>

        {/* 自動録画・自動文字起こしの設定状態 */}
        <div className="space-y-2 border-t border-zinc-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="text-zinc-500">自動録画・自動文字起こし：</span>
              <span className={cn("font-medium", configTextClass(status.configStatus))}>
                {configLabel(status.configStatus)}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canEdit || !status.meetUrl}
              onClick={() => void post("configure")}
            >
              {pending === "configure" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              設定を再試行
            </Button>
          </div>
          {status.configError ? (
            <p className="flex items-start gap-1.5 text-[13px] text-red-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{status.configError}</span>
            </p>
          ) : null}
        </div>

        {/* 成果物の取得状態 */}
        <div className="space-y-2 border-t border-zinc-100 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm">
              <span className="text-zinc-500">成果物（文字起こし）：</span>
              <span className={cn("font-medium", artifactTextClass(status.artifactStatus))}>
                {artifactLabel(status.artifactStatus)}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canEdit || !status.meetUrl}
              onClick={() => void post("artifacts")}
            >
              {pending === "artifacts" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              成果物を取得
            </Button>
          </div>
          {status.artifactError ? (
            <p className="flex items-start gap-1.5 text-[13px] text-red-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{status.artifactError}</span>
            </p>
          ) : null}
          <p className="text-[13px] text-zinc-500">
            自動記録は、主催者または共同主催者がWeb版のMeetに参加した時点で開始されます。
            スマートフォンアプリのみの参加では開始されないためご注意ください。
          </p>
          {status.checkedAt ? (
            <p className="text-[13px] text-zinc-400">
              最終確認: {toJstDateTimeInput(status.checkedAt).replace("T", " ")}（試行 {status.attempts} 回）
            </p>
          ) : null}
        </div>

        {notice ? (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-[13px] text-zinc-600">{notice}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function phaseBadgeVariant(phase: string): "success" | "warning" | "danger" | "secondary" {
  if (phase === "completed") return "success";
  if (phase === "needs_attention" || phase === "config_failed") return "danger";
  if (phase === "in_progress" || phase === "fetching" || phase === "analyzing") return "warning";
  return "secondary";
}

function configLabel(status: string | null): string {
  if (status === "configured") return "設定済み";
  if (status === "configuring") return "設定中";
  if (status === "failed") return "設定失敗";
  return "未設定";
}

function configTextClass(status: string | null): string {
  if (status === "configured") return "text-orange-600";
  if (status === "failed") return "text-red-600";
  return "text-zinc-600";
}

function artifactLabel(status: string | null): string {
  if (status === "fetched") return "取得済み";
  if (status === "fetching") return "取得中";
  if (status === "waiting") return "成果物待ち";
  if (status === "failed") return "取得失敗";
  return "未取得";
}

function artifactTextClass(status: string | null): string {
  if (status === "fetched") return "text-orange-600";
  if (status === "fetching") return "text-amber-600";
  if (status === "failed") return "text-red-600";
  return "text-zinc-600";
}

export default MeetSessionPanel;
