"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MinutesEditor } from "./minutes-editor";
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  Trash2,
  Users,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toJstDateStr } from "@/lib/meeting-datetime";
import { DEAL_NAVIGATE_EVENT } from "./deal-navigation";
import { RecordingPlayer } from "./recording-player";
import { fmtBytes, fmtDuration, recordingFactsLabel } from "@/lib/meetings/recording-facts";

type MeetingItem = {
  id: string;
  title: string | null;
  meetingDate: Date | string;
  minutes: string | null;
  minutesJson: unknown;
  transcript: string | null;
  recordingUrl: string | null;
  processingStatus: string;
  processingError: string | null;
  durationSec: number | null;
  audioSizeBytes: number | null;
  processingStartedAt: Date | string | null;
  processingCompletedAt: Date | string | null;
  summary: string | null;
  bantBudget: string | null;
  bantAuthority: string | null;
  bantNeed: string | null;
  bantTimeline: string | null;
  /** 継続処理（T04）の状態を含む。自動分析待ちの判定にだけ使う。 */
  meta?: unknown;
};

type MeetingMinutesJson = {
  participants: string[];
  customer_issues: string[];
  proposals: string[];
  next_actions: Array<{ action: string; owner: string; due: string }>;
  decisions: string[];
  summary: string;
};

type MeetingStatusSnapshot = {
  id: string;
  processingStatus: string;
  processingError: string | null;
  durationSec: number | null;
  audioSizeBytes: number | null;
  processingStartedAt: string | null;
  processingCompletedAt: string | null;
  hasTranscript: boolean;
  hasMinutes: boolean;
  hasSummary: boolean;
  hasRecording: boolean;
  /** 分析が中断して長く「分析中」のまま（サーバー判定）。 */
  analysisStalled?: boolean;
  /** リクエスト内で処理する環境の文字起こしが中断して止まっている（サーバー判定）。 */
  transcriptionStalled?: boolean;
  /** 動画・分割アップロードの再生用音声ができているか（サーバー判定）。 */
  playbackReady?: boolean;
  /** 長い記録の分析（原文抜粋の抽出→分析）の進捗。 */
  analysis?: { mode: "long"; state: "extract" | "pipeline"; completed: number; total: number; waiting: boolean } | null;
  /** 抜粋で分析した記録の要約。 */
  analysisInput?: { originalChars: number; condensedChars: number; chunks: number; omitted?: number; mustKeepMissing?: number } | null;
  /** T04: Cloud Run の継続処理の進捗。ローカル開発では null。 */
  transcription?: {
    mode: "job";
    state: "prepare" | "transcribe" | "done" | null;
    completed: number;
    total: number;
    durationSec: number | null;
    waiting: boolean;
    autoAnalyzePending: boolean;
  } | null;
};

const ACTIVE_PROCESSING_STATUSES = new Set(["uploaded", "transcribing", "analyzing"]);

const STATUS_LABEL: Record<string, string> = {
  uploaded: "アップロード済み",
  transcribing: "文字起こし中",
  transcribed: "文字起こし済み",
  analyzing: "分析中",
  completed: "完了",
  error: "エラー",
};

function isProcessingActive(status: string | null | undefined) {
  return ACTIVE_PROCESSING_STATUSES.has(status ?? "");
}

/** 継続処理の記録で、この画面から続きを進めるべき状態か（文字起こし中・自動分析待ち・長い記録の分析中）。 */
function needsContinuation(snapshot: MeetingStatusSnapshot | undefined) {
  if (snapshot?.processingStatus === "analyzing" && snapshot.analysis?.mode === "long") return true;
  if (snapshot?.transcription?.mode !== "job") return false;
  return snapshot.processingStatus === "uploaded" || snapshot.processingStatus === "transcribing"
    || (snapshot.processingStatus === "transcribed" && snapshot.transcription.autoAnalyzePending);
}

/** 継続処理で文字起こしが完了し、最初の自動分析をまだ行っていない記録か（サーバーから渡された meta で判定）。 */
function autoAnalyzePendingFromMeta(meta: unknown) {
  const job = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as { transcriptionJob?: { state?: unknown; autoAnalyze?: unknown } }).transcriptionJob
    : undefined;
  return job?.state === "done" && job.autoAnalyze !== false;
}

function playbackFileFromMeta(meta: unknown) {
  const job = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as { transcriptionJob?: { playbackFile?: unknown } }).transcriptionJob
    : undefined;
  return typeof job?.playbackFile === "string" && job.playbackFile.length > 0;
}

/** 分割アップロードの録画は、正規化した音声ができるまで再生できない。 */
function isSplitUploadRecording(recordingUrl: string | null) {
  return !!recordingUrl && /^\/uploads\/recordings\/parts\/[0-9a-f-]{36}\/manifest\.json$/.test(recordingUrl);
}

/** 抜粋で分析した記録（サーバーから渡された meta）の要約。 */
function analysisInputFromMeta(meta: unknown) {
  const input = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as { analysisInput?: { mode?: unknown; originalChars?: unknown; condensedChars?: unknown; chunks?: unknown; selection?: { droppedForBudget?: unknown; skippedLongLines?: unknown; aiDropped?: unknown; mustKeepMissing?: unknown } } }).analysisInput
    : undefined;
  return input?.mode === "condensed" && typeof input.originalChars === "number" && typeof input.condensedChars === "number" && typeof input.chunks === "number"
    ? {
      originalChars: input.originalChars, condensedChars: input.condensedChars, chunks: input.chunks,
      omitted: typeof input.selection?.aiDropped === "number" ? input.selection.aiDropped
        : (typeof input.selection?.droppedForBudget === "number" ? input.selection.droppedForBudget : 0)
          + (typeof input.selection?.skippedLongLines === "number" ? input.selection.skippedLongLines : 0),
      mustKeepMissing: typeof input.selection?.mustKeepMissing === "number" ? input.selection.mustKeepMissing : 0,
    }
    : null;
}

function transcriptionProgressLabel(snapshot: MeetingStatusSnapshot | undefined) {
  const analysis = snapshot?.analysis;
  if (analysis?.mode === "long" && snapshot?.processingStatus === "analyzing") {
    return analysis.state === "extract"
      ? `長い記録のため、関係する発言を原文のまま抜粋しています（区間 ${Math.min(analysis.completed + 1, analysis.total)}/${analysis.total}）`
      : "抜粋した発言から議事録・BANTを生成中";
  }
  const job = snapshot?.transcription;
  if (!job || !["uploaded", "transcribing"].includes(snapshot?.processingStatus ?? "")) return null;
  if (job.state === "transcribe" && job.total > 1) return `区間 ${Math.min(job.completed + 1, job.total)}/${job.total} を文字起こし中（完了 ${job.completed}件）`;
  if (job.state === "prepare" || !job.state) return "音声を準備中";
  return null;
}

function statusSnapshot(meeting: MeetingItem): MeetingStatusSnapshot {
  const timestamp = (value: Date | string | null) => value instanceof Date ? value.toISOString() : value;
  return {
    id: meeting.id,
    processingStatus: meeting.processingStatus,
    processingError: meeting.processingError,
    durationSec: meeting.durationSec,
    audioSizeBytes: meeting.audioSizeBytes,
    processingStartedAt: timestamp(meeting.processingStartedAt),
    processingCompletedAt: timestamp(meeting.processingCompletedAt),
    hasTranscript: !!meeting.transcript?.trim(),
    hasMinutes: !!meeting.minutes?.trim(),
    hasSummary: !!meeting.summary,
    hasRecording: !!meeting.recordingUrl,
  };
}


function normalizeMinutesJson(value: unknown): MeetingMinutesJson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is string => typeof i === "string" && i.trim().length > 0) : []);
  const nextActions = Array.isArray(obj.next_actions)
    ? obj.next_actions
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null;
          const row = item as Record<string, unknown>;
          return {
            action: typeof row.action === "string" ? row.action : "",
            owner: typeof row.owner === "string" ? row.owner : "未確認",
            due: typeof row.due === "string" ? row.due : "未確認",
          };
        })
        .filter((item): item is { action: string; owner: string; due: string } => !!item?.action)
    : [];
  return {
    participants: strings(obj.participants),
    customer_issues: strings(obj.customer_issues),
    proposals: strings(obj.proposals),
    next_actions: nextActions,
    decisions: strings(obj.decisions),
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

function hasMinutesJsonContent(minutes: MeetingMinutesJson | null) {
  return !!(
    minutes &&
    (minutes.participants.length ||
      minutes.customer_issues.length ||
      minutes.proposals.length ||
      minutes.next_actions.length ||
      minutes.decisions.length ||
      minutes.summary)
  );
}

export function MeetingHistory({
  dealId,
  meetings,
  canEdit = true,
}: {
  dealId: string;
  meetings: MeetingItem[];
  /**
   * 操作中の会社で利用者以上か。閲覧のみなら、記録の追加・削除・文字起こし再実行・分析・ラベル保存・議事録の編集を
   * 出さない（API も 403 で止める）。
   */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [openIds, setOpenIds] = useState<Set<string>>(
    new Set(meetings[0] ? [meetings[0].id] : []),
  );
  // 画面を開いた後に追加された記録（録音・添付の受付、Meetの取込）は、処理中か最新なら開いて進捗を見せる。
  // 利用者が開いた・閉じたカードはそのまま（追加するだけ）。初期値は props だけで決まるので hydration に影響しない。
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set(meetings.map((meeting) => meeting.id)));
  const added = meetings.filter((meeting) => !knownIds.has(meeting.id));
  if (added.length) {
    const latestKnown = Math.max(0, ...meetings.filter((meeting) => knownIds.has(meeting.id)).map((meeting) => new Date(meeting.meetingDate).getTime()));
    const toOpen = added.filter((meeting) => isProcessingActive(meeting.processingStatus) || new Date(meeting.meetingDate).getTime() >= latestKnown);
    setKnownIds(new Set(meetings.map((meeting) => meeting.id)));
    if (toOpen.length) setOpenIds((current) => new Set([...current, ...toOpen.map((meeting) => meeting.id)]));
  }
  const [listError, setListError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  // 商談日の既定値は日本時間の今日（UTCの日付だと0〜9時は前日になる）。
  const [newDate, setNewDate] = useState(() => toJstDateStr(new Date()));
  const [adding, setAdding] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createInFlight = useRef(false);
  // A route refresh preserves client state. Only overlay snapshots from the
  // same server row, so new props can replace an older optimistic status.
  const [statusById, setStatusById] = useState<Record<string, { source: MeetingItem; snapshot: MeetingStatusSnapshot }>>({});
  const [statusPendingIds, setStatusPendingIds] = useState<Set<string>>(new Set());
  const statusRequestsInFlight = useRef(new Set<string>());
  const continuationsInFlight = useRef(new Set<string>());
  // 閲覧者（403）には継続を送らない。全社統合ビュー・会社の切替・一時的な拒否（その他の4xx）は
  // 1分おいてから送り直す（会社を切り替えた後に止まったままにならないように）。
  const continuationsRefused = useRef(new Map<string, number>());
  // 別の処理がリース中だった記録は次の1回だけ後回しにし、他の記録を先に進める。
  const lastLeasedId = useRef<string | null>(null);
  const pollingIds = JSON.stringify(meetings
    .filter((meeting) => {
      if (statusPendingIds.has(meeting.id)) return false;
      const live = statusById[meeting.id]?.source === meeting ? statusById[meeting.id].snapshot : undefined;
      if (isProcessingActive(live?.processingStatus ?? meeting.processingStatus)) return true;
      // 継続処理で文字起こしが終わり、自動分析を待っている録音も確認する。
      return (live?.processingStatus ?? meeting.processingStatus) === "transcribed" && !!meeting.recordingUrl
        && (live ? needsContinuation(live) : autoAnalyzePendingFromMeta(meeting.meta));
    })
    .map((meeting) => meeting.id));

  useEffect(() => {
    const idsToPoll: string[] = JSON.parse(pollingIds);
    if (idsToPoll.length === 0) return;

    let cancelled = false;
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      const results = await Promise.all(
        idsToPoll.map(async (id) => {
          try {
            const res = await fetch(`/api/meetings/${id}/status`, { cache: "no-store" });
            if (!res.ok) return null;
            const json = await res.json();
            return json.meeting?.id === id ? json.meeting as MeetingStatusSnapshot : null;
          } catch {
            // A failed read must not prevent the next poll from reconciling
            // the real processing outcome.
            return null;
          }
        }),
      );
      polling = false;
      if (cancelled) return;
      // T04: 継続処理の記録は、この画面から続きを進める（この画面から同時に1本まで）。
      // 別の画面・定期処理が進めている間はサーバーが leased を返すだけで二重に処理しない。
      const candidates = results.filter((result): result is MeetingStatusSnapshot => !!result && needsContinuation(result)
        && (continuationsRefused.current.get(result.id) ?? 0) <= Date.now());
      const nextCandidate = candidates.find((result) => result.id !== lastLeasedId.current) ?? candidates[0];
      for (const result of continuationsInFlight.current.size > 0 || !nextCandidate ? [] : [nextCandidate]) {
        continuationsInFlight.current.add(result.id);
        void fetch(`/api/meetings/${result.id}/transcription`, { method: "POST", cache: "no-store" })
          .then(async (res) => {
            const json = await res.json().catch(() => null);
            if (res.status >= 400 && res.status < 500) {
              const permanent = res.status === 403 || json?.code === "TRANSCRIPTION_JOB_DISABLED";
              continuationsRefused.current.set(result.id, permanent ? Number.POSITIVE_INFINITY : Date.now() + 60_000);
            }
            lastLeasedId.current = json?.outcome === "leased" ? result.id : null;
            const snapshot = res.ok && json?.meeting?.id === result.id ? json.meeting as MeetingStatusSnapshot : null;
            if (!snapshot || cancelled) return;
            const source = meetings.find((meeting) => meeting.id === result.id);
            if (source) setStatusById((current) => ({ ...current, [result.id]: { source, snapshot } }));
            if (!isProcessingActive(snapshot.processingStatus) && !needsContinuation(snapshot)) router.refresh();
          })
          .catch(() => {
            // 通信断・タイムアウト。保存済みの区間から次の確認で再開する。
          })
          .finally(() => continuationsInFlight.current.delete(result.id));
        break;
      }
      setStatusById((current) => {
        const next = { ...current };
        let changed = false;
        for (const result of results) {
          if (!result) continue;
          const source = meetings.find((meeting) => meeting.id === result.id);
          if (source && (current[result.id]?.source !== source || JSON.stringify(current[result.id].snapshot) !== JSON.stringify(result))) {
            next[result.id] = { source, snapshot: result };
            changed = true;
          }
        }
        return changed ? next : current;
      });
      if (results.some((result) => result && !isProcessingActive(result.processingStatus) && !needsContinuation(result)
        && meetings.find((meeting) => meeting.id === result.id)?.processingStatus !== result.processingStatus)) {
        router.refresh();
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [meetings, pollingIds, router]);

  // BANTの出典リンクなど、タブの外から特定の商談記録へ移動するときはカードを開く。
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const sectionId = (e as CustomEvent<{ sectionId?: string }>).detail?.sectionId;
      const id = sectionId?.startsWith("meeting-") ? sectionId.slice("meeting-".length) : null;
      if (!id || !meetings.some((meeting) => meeting.id === id)) return;
      setOpenIds((current) => current.has(id) ? current : new Set(current).add(id));
    };
    window.addEventListener(DEAL_NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(DEAL_NAVIGATE_EVENT, onNavigate);
  }, [meetings]);

  function updateStatus(meeting: MeetingItem, changes: Partial<MeetingStatusSnapshot>) {
    setStatusById((current) => ({
      ...current,
      [meeting.id]: {
        source: meeting,
        snapshot: {
          ...(current[meeting.id]?.source === meeting ? current[meeting.id].snapshot : statusSnapshot(meeting)),
          // 状態を画面側で進めたときは、以前の「停止中」の判定を持ち越さない。
          ...(changes.processingStatus ? { analysisStalled: false, transcriptionStalled: false } : {}),
          ...changes,
        },
      },
    }));
  }

  // タイトル：明示があれば優先、なければ「第N回 商談」（古→新で番号）
  const ordered = [...meetings].sort(
    (a, b) => new Date(a.meetingDate).getTime() - new Date(b.meetingDate).getTime(),
  );
  const labelById = new Map<string, string>();
  ordered.forEach((m, idx) => {
    labelById.set(m.id, m.title ?? `第${idx + 1}回 商談`);
  });

  function toggle(id: string) {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenIds(next);
  }

  async function createMeeting() {
    if (createInFlight.current) return;
    setCreateError(null);
    const meetingDate = new Date(newDate);
    if (!newDate || Number.isNaN(meetingDate.getTime())) {
      setCreateError("商談日を入力してください。");
      return;
    }
    createInFlight.current = true;
    setAdding(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId,
          meetingDate: meetingDate.toISOString(),
          title: newTitle.trim() || undefined,
          createDraft: true,
        }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || typeof j?.meeting?.id !== "string" || !j.meeting.id) {
        setCreateError(typeof j?.error === "string" ? j.error : "商談記録を追加できませんでした。入力内容を確認して再試行してください。");
        return;
      }
      setOpenIds((s) => new Set(s).add(j.meeting.id));
      setCreating(false);
      setNewTitle("");
      router.refresh();
    } catch {
      setCreateError("通信に失敗しました。入力内容は残っています。再試行してください。");
    } finally {
      createInFlight.current = false;
      setAdding(false);
    }
  }

  async function retryTranscription(id: string) {
    const meeting = meetings.find((item) => item.id === id);
    if (!meeting || statusRequestsInFlight.current.has(id)) return;
    statusRequestsInFlight.current.add(id);
    setStatusPendingIds((current) => new Set(current).add(id));
    try {
      const res = await fetch(`/api/meetings/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-transcription" }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.meeting) {
        updateStatus(meeting, { processingStatus: "error", processingError: typeof json?.error === "string" ? json.error : "文字起こしを開始できませんでした。再試行してください。" });
        return;
      }
      updateStatus(meeting, json.meeting);
    } catch {
      updateStatus(meeting, { processingStatus: "error", processingError: "通信に失敗しました。再試行してください。" });
    } finally {
      statusRequestsInFlight.current.delete(id);
      setStatusPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      router.refresh();
    }
  }

  async function runAnalysis(id: string) {
    const meeting = meetings.find((item) => item.id === id);
    if (!meeting || statusRequestsInFlight.current.has(id)) return;
    statusRequestsInFlight.current.add(id);
    setStatusPendingIds((current) => new Set(current).add(id));
    updateStatus(meeting, { processingStatus: "analyzing", processingError: null });
    try {
      const res = await fetch(`/api/meetings/${id}/analyze`, { method: "POST" });
      const json = await res.json().catch(() => null);
      if (res.status === 409 && isProcessingActive(json?.processingStatus)) {
        updateStatus(meeting, { processingStatus: json.processingStatus, processingError: null });
      } else if (res.status === 202 && json?.accepted) {
        // 長い記録は原文抜粋の抽出ジョブとして受け付けられた。この画面の継続処理が区間ごとに進める。
        updateStatus(meeting, {
          processingStatus: "analyzing", processingError: null,
          analysis: { mode: "long", state: "extract", completed: 0, total: typeof json.chunks === "number" ? json.chunks : 0, waiting: true },
        });
      } else if (!res.ok) {
        updateStatus(meeting, { processingStatus: "error", processingError: typeof json?.error === "string" ? json.error : "AI分析に失敗しました。再試行してください。" });
      } else {
        updateStatus(meeting, { processingStatus: "completed", processingError: null, hasMinutes: true, hasSummary: true });
      }
    } catch {
      updateStatus(meeting, { processingStatus: "error", processingError: "通信に失敗しました。保存済みの文字起こし・議事録から再試行できます。" });
    } finally {
      statusRequestsInFlight.current.delete(id);
      setStatusPendingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      router.refresh();
    }
  }

  function remove(id: string) {
    if (!confirm("この商談記録を削除しますか？（議事録・BANT・AI分析と、録音・録画ファイルもすべて削除され、元に戻せません）")) return;
    setListError(null);
    start(async () => {
      try {
        const res = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          setListError(typeof json?.error === "string" ? `削除できませんでした: ${json.error}` : `削除できませんでした（HTTP ${res.status}）。再読み込みして確認してください。`);
        }
      } catch {
        setListError("通信に失敗したため、削除できたか確認できません。再読み込みして確認してください。");
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
              <CalendarDays className="h-4 w-4" />
            </div>
            商談履歴
            <Badge variant="secondary">{meetings.length}回</Badge>
          </span>
          {canEdit && (
          <Button size="sm" variant="primary" disabled={adding || pending}
            onClick={() => { setCreating(!creating); setCreateError(null); }}>
            <Plus className="h-3.5 w-3.5" />
            新しい商談を記録
          </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {listError && <p role="alert" className="text-sm text-rose-600">{listError}</p>}
        {canEdit && creating && (
          <div className="rounded-lg border border-orange-200 bg-orange-50/40 p-4 space-y-3">
            <p className="text-sm font-medium text-orange-900 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> 新しい商談記録を追加
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2 space-y-1">
                <Label htmlFor={`meeting-title-${dealId}`} className="text-[13px]">商談ラベル（任意）</Label>
                <Input
                  id={`meeting-title-${dealId}`}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  maxLength={200}
                  disabled={adding}
                  placeholder="例: 第3回 役員レビュー"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`meeting-date-${dealId}`} className="text-[13px]">商談日</Label>
                <Input
                  id={`meeting-date-${dealId}`}
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  disabled={adding}
                />
              </div>
            </div>
            {createError && <p role="alert" className="text-sm text-rose-600">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)} disabled={adding}>
                キャンセル
              </Button>
              <Button size="sm" variant="primary" onClick={createMeeting} disabled={pending || adding}>
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {adding ? "追加中..." : "追加"}
              </Button>
            </div>
            <p className="text-[13px] text-zinc-500">
              追加後、各回ごとに議事録・録音・BANT・AI分析を独立して記録できます。
            </p>
          </div>
        )}

        {meetings.length === 0 ? (
          <div className="text-center py-8">
            <Mic className="h-10 w-10 text-orange-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500 mb-3">
              まだ商談記録がありません。録音 / 議事録アップロード / 「新しい商談を記録」のいずれかで開始してください。
            </p>
          </div>
        ) : (
          // 新しい順で表示
          [...meetings]
            .sort((a, b) => new Date(b.meetingDate).getTime() - new Date(a.meetingDate).getTime())
            .map((m, idx) => {
              const isOpen = openIds.has(m.id);
              const isLatest = idx === 0;
              const label = labelById.get(m.id) ?? "商談";
              const liveStatus = statusById[m.id]?.source === m ? statusById[m.id].snapshot : undefined;
              const processingStatus = liveStatus?.processingStatus ?? m.processingStatus;
              const processingError = liveStatus ? liveStatus.processingError : m.processingError;
              const durationSec = liveStatus?.durationSec ?? m.durationSec;
              const audioSizeBytes = liveStatus?.audioSizeBytes ?? m.audioSizeBytes;
              const hasTranscript = liveStatus?.hasTranscript ?? !!m.transcript?.trim();
              const hasMinutes = liveStatus?.hasMinutes ?? !!m.minutes;
              const hasSummary = liveStatus?.hasSummary ?? !!m.summary;
              const hasRecording = liveStatus?.hasRecording ?? !!m.recordingUrl;
              const analysisStalled = liveStatus?.analysisStalled === true;
              const canAnalyze = (hasTranscript || hasMinutes) && (processingStatus !== "analyzing" || analysisStalled);
              const progressLabel = transcriptionProgressLabel(liveStatus);
              const condensedInput = liveStatus?.analysisInput ?? analysisInputFromMeta(m.meta);
              const transcriptionStalled = liveStatus?.transcriptionStalled === true;
              // 分割アップロードは、正規化した再生用音声ができた時点で再生できる（文字起こしの完了やエラーとは無関係）。
              const playbackReady = liveStatus?.playbackReady ?? (playbackFileFromMeta(m.meta) || hasTranscript);
              const playbackPreparing = isSplitUploadRecording(m.recordingUrl) && !playbackReady;
              const structuredMinutes = normalizeMinutesJson(m.minutesJson);
              return (
                <div
                  key={m.id}
                  id={`meeting-${m.id}`}
                  className={`scroll-mt-24 rounded-lg border ${isLatest ? "border-orange-300 bg-white shadow-sm" : "border-zinc-200 bg-white"}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(m.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 rounded-lg transition-colors"
                  >
                    <div
                      className={`rounded-md p-1.5 ${isLatest ? "bg-orange-500 text-white" : "bg-zinc-100 text-zinc-500"}`}
                    >
                      <CalendarDays className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{label}</p>
                        {isLatest && <Badge variant="info">最新</Badge>}
                        <span className="text-[13px] text-zinc-500">{formatDate(m.meetingDate)}</span>
                        <Badge variant={processingStatus === "error" ? "danger" : isProcessingActive(processingStatus) ? "info" : "secondary"}>
                          {isProcessingActive(processingStatus) && <Loader2 className="h-3 w-3 animate-spin" />}
                          {STATUS_LABEL[processingStatus] ?? processingStatus}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-[12.5px] text-zinc-500 mt-0.5">
                        {fmtDuration(durationSec) && <span>録音 {fmtDuration(durationSec)}</span>}
                        {fmtBytes(audioSizeBytes) && <span>{fmtBytes(audioSizeBytes)}</span>}
                      </div>
                      {m.summary && (
                        <p className="text-[13px] text-zinc-500 truncate mt-0.5">{m.summary}</p>
                      )}
                    </div>
                    {canEdit && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(m.id);
                      }}
                      className="text-zinc-300 hover:text-red-500"
                      title="削除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </span>
                    )}
                    {isOpen ? (
                      <ChevronUp className="h-4 w-4 text-zinc-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-zinc-400" />
                    )}
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-0 space-y-3 border-t border-zinc-100">
                      <div
                        className={`rounded-md border px-3 py-2 text-sm ${
                          processingStatus === "error"
                            ? "border-red-200 bg-red-50 text-red-800"
                            : isProcessingActive(processingStatus)
                              ? "border-amber-200 bg-amber-50 text-amber-800"
                              : "border-zinc-200 bg-zinc-50 text-zinc-700"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <p className="font-medium flex items-center gap-1.5">
                              {processingStatus === "error" ? (
                                <AlertCircle className="h-4 w-4" />
                              ) : isProcessingActive(processingStatus) ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Sparkles className="h-4 w-4" />
                              )}
                              処理状態: {STATUS_LABEL[processingStatus] ?? processingStatus}
                            </p>
                            {progressLabel && <p className="text-[13px] leading-relaxed">{progressLabel}</p>}
                            {condensedInput && !isProcessingActive(processingStatus) && (
                              <p className="text-[13px] leading-relaxed opacity-80">
                                長い記録のため、関係する発言を原文のまま抜粋して分析しました（元 {condensedInput.originalChars.toLocaleString("ja-JP")}字 → 抜粋 {condensedInput.condensedChars.toLocaleString("ja-JP")}字・{condensedInput.chunks}区間）。
                                {(condensedInput.omitted ?? 0) > 0 && "分量の上限のため、AIが選んだ発言の一部は抜粋に含められませんでした。"}
                                {(condensedInput.mustKeepMissing ?? 0) > 0 && "1行が長すぎるため、撤回・訂正・未確認などの発言の一部を抜粋に含められませんでした。"}
                                {((condensedInput.omitted ?? 0) > 0 || (condensedInput.mustKeepMissing ?? 0) > 0) && "議事録・BANTを文字起こしと照らして確認してください。"}
                              </p>
                            )}
                            {analysisStalled && (
                              <p role="alert" className="text-[13px] leading-relaxed">分析が中断したまま止まっています。「分析を実行」で再実行してください。</p>
                            )}
                            {transcriptionStalled && (
                              <p role="alert" className="text-[13px] leading-relaxed">文字起こしが中断したまま止まっています。「文字起こし再実行」で再実行してください。</p>
                            )}
                            {processingError && <p role="alert" className="text-[13px] leading-relaxed">{processingError}</p>}
                            {recordingFactsLabel(durationSec, audioSizeBytes) && (
                              <p className="text-[13px] opacity-80">{recordingFactsLabel(durationSec, audioSizeBytes)}</p>
                            )}
                          </div>
                          <div className="flex gap-2 flex-wrap justify-end">
                            {canEdit && hasRecording && !hasTranscript && (!isProcessingActive(processingStatus) || transcriptionStalled) && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => retryTranscription(m.id)}
                                disabled={statusPendingIds.has(m.id)}
                              >
                                <RefreshCw className="h-3.5 w-3.5" />
                                文字起こし再実行
                              </Button>
                            )}
                            {canEdit && (processingStatus === "transcribed" || processingStatus === "completed" || (processingStatus === "error" && canAnalyze) || analysisStalled) && (
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => runAnalysis(m.id)}
                                disabled={statusPendingIds.has(m.id) || !canAnalyze}
                              >
                                <Sparkles className="h-3.5 w-3.5" />
                                {hasSummary ? "分析再実行" : "分析を実行"}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                      <MeetingTitleEditor meetingId={m.id} initialTitle={m.title} canEdit={canEdit} />
                      {hasRecording && (
                        <div className="rounded-lg border border-zinc-200 bg-white p-3">
                          <p className="text-[13px] font-medium text-zinc-600 inline-flex items-center gap-1.5 mb-2">
                            <Mic className="h-3.5 w-3.5" />
                            録音
                          </p>
                          {playbackPreparing ? (
                            <p className="text-[13px] text-zinc-500">
                              {processingStatus === "error"
                                ? "再生用の音声を作成できませんでした。「文字起こし再実行」で作成し直します。"
                                : "再生用の音声を準備中です。準備ができると再生できます。"}
                            </p>
                          ) : (
                            <RecordingPlayer
                              // 再生用の音声ができた時点で1回だけ作り直す（状態の変化では作り直さず、再生を止めない）。
                              key={`${m.id}-${playbackReady ? "ready" : "original"}`}
                              src={`/api/meetings/${m.id}/recording`}
                            />
                          )}
                        </div>
                      )}
                      {hasMinutesJsonContent(structuredMinutes) && structuredMinutes && (
                        <div className="rounded-lg border border-orange-100 bg-orange-50/40 p-3">
                          <p className="text-[13px] font-medium text-orange-800 inline-flex items-center gap-1.5 mb-3">
                            <Users className="h-3.5 w-3.5" />
                            議事録サマリー
                          </p>
                          {structuredMinutes.summary && (
                            <p className="text-sm text-zinc-800 whitespace-pre-wrap mb-3">
                              {structuredMinutes.summary}
                            </p>
                          )}
                          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[13px]">
                            {[
                              { label: "参加者", values: structuredMinutes.participants },
                              { label: "顧客の課題", values: structuredMinutes.customer_issues },
                              { label: "提案内容", values: structuredMinutes.proposals },
                              { label: "決定事項", values: structuredMinutes.decisions },
                            ].map((section) => (
                              <div key={section.label} className="rounded-md border border-orange-100 bg-white p-2">
                                <dt className="text-[12.5px] font-medium text-orange-700 mb-1">{section.label}</dt>
                                <dd className="space-y-1 text-zinc-700">
                                  {section.values.length ? section.values.map((v, i) => <p key={`${section.label}-${i}`}>{v}</p>) : <p>未確認</p>}
                                </dd>
                              </div>
                            ))}
                            <div className="rounded-md border border-orange-100 bg-white p-2 md:col-span-2">
                              <dt className="text-[12.5px] font-medium text-orange-700 mb-1">ネクストアクション</dt>
                              <dd className="space-y-1 text-zinc-700">
                                {structuredMinutes.next_actions.length ? (
                                  structuredMinutes.next_actions.map((a, i) => (
                                    <p key={`action-${i}`}>
                                      {a.action}（担当: {a.owner || "未確認"} / 期限: {a.due || "未確認"}）
                                    </p>
                                  ))
                                ) : (
                                  <p>未確認</p>
                                )}
                              </dd>
                            </div>
                          </dl>
                        </div>
                      )}
                      <MinutesEditor
                        meetingId={m.id}
                        initialMinutes={m.minutes ?? ""}
                        initialTranscript={m.transcript ?? ""}
                        meetingDate={m.meetingDate}
                        canEdit={canEdit}
                      />
                      {/* この回のBANTメモ（履歴・閲覧のみ。案件全体のBANTは商談ページの上部「BANT情報」で一元管理） */}
                      {(m.bantBudget || m.bantAuthority || m.bantNeed || m.bantTimeline) && (
                        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
                          {/* 390px でも見出しは1行に保ち、注記だけを次の行へ折り返す（見出しが狭い列で3行に折れないように）。 */}
                          <p className="text-[13px] text-zinc-500 flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-2">
                            <span className="inline-flex items-center gap-1 whitespace-nowrap">
                              <Target className="h-3 w-3 shrink-0" />
                              この回でのBANTメモ（履歴）
                            </span>
                            <span className="text-[12px] text-zinc-400">
                              ※ 編集は商談ページ上部の「BANT情報」で行います
                            </span>
                          </p>
                          <dl className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[13px]">
                            {[
                              { label: "B / 予算", v: m.bantBudget },
                              { label: "A / 決裁", v: m.bantAuthority },
                              { label: "N / 必要性", v: m.bantNeed },
                              { label: "T / 時期", v: m.bantTimeline },
                            ].map((row) =>
                              row.v ? (
                                <div key={row.label} className="bg-white rounded px-2 py-1.5 border border-zinc-100">
                                  <dt className="text-[12px] text-zinc-500">{row.label}</dt>
                                  <dd className="text-zinc-800">{row.v}</dd>
                                </div>
                              ) : null,
                            )}
                          </dl>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </CardContent>
    </Card>
  );
}

function MeetingTitleEditor({
  meetingId,
  initialTitle,
  canEdit,
}: {
  meetingId: string;
  initialTitle: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() || null }),
    });
    setSaving(false);
    router.refresh();
  }

  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-1">
        <Label className="text-[13px] text-zinc-500">この回のラベル</Label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例: 第3回 役員レビュー / クロージング MTG"
          className="h-9"
          disabled={!canEdit}
        />
      </div>
      {canEdit && (
      <Button size="sm" variant="outline" onClick={save} disabled={saving}>
        {saving ? "保存中..." : "ラベル保存"}
      </Button>
      )}
    </div>
  );
}
