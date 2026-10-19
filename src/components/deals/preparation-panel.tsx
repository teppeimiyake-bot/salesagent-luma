"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Lightbulb,
  MessageCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

interface Preparation {
  hearing_questions: string[];
  hypotheses: string[];
  talking_points: string[];
  common_concerns: string[];
  recommended_materials: string[];
}

type PreparationBriefStatus = "pending" | "researching" | "generating" | "done" | "error";

type PreparationSource = {
  title: string;
  url: string;
};

type PreparationBrief = {
  vertex_grounding?: { text: string; searchHtml: string } | null;
  id: string;
  status: PreparationBriefStatus;
  error: string | null;
  /** Server-judged: still in progress 10+ minutes after creation (recovery write skipped). */
  interrupted?: boolean;
  industry_summary: string | null;
  hiring_insights: {
    media: string;
    roles: string;
    scale: string;
    sources: PreparationSource[];
  } | null;
  pain_hypotheses: Array<{
    hypothesis: string;
    confidence: "high" | "medium" | "low";
    evidence: string;
    source_url: string;
  }>;
  proposal_story: string | null;
  sources: PreparationSource[];
  model: string | null;
  created_at: string;
  disclaimer: string;
};

// Same message as PREPARATION_INTERRUPTED_MESSAGE in src/lib/ai/preparation.ts.
// The API marks such briefs as errors; when that write was skipped (e.g. the
// all-company view) it still reports `interrupted`, judged with the server clock,
// so the panel stops waiting without comparing the viewer's clock to created_at.
const INTERRUPTED_BRIEF_MESSAGE = "AI処理が中断されました（開始から10分以上完了していません）。再実行してください。";

function isBriefInProgress(status?: string | null): boolean {
  return status === "pending" || status === "researching" || status === "generating";
}

function withInterruptedStatus(brief: PreparationBrief): PreparationBrief {
  if (brief.interrupted !== true || !isBriefInProgress(brief.status)) return brief;
  return { ...brief, status: "error", error: INTERRUPTED_BRIEF_MESSAGE };
}

export function PreparationPanel({
  dealId,
  status,
  preparationV2Enabled = false,
}: {
  dealId: string;
  status: string;
  preparationV2Enabled?: boolean;
}) {
  const isPreStage = ["LEAD", "HEARING"].includes(status);
  if (!preparationV2Enabled) {
    if (!isPreStage) return null;
    return <LegacyPreparationPanel key={dealId} dealId={dealId} status={status} />;
  }

  return <PreparationV2Panel key={dealId} dealId={dealId} status={status} />;
}

function LegacyPreparationPanel({ dealId, status }: { dealId: string; status: string }) {
  const [data, setData] = useState<Preparation | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/deals/${dealId}/preparation`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j.preparation) throw new Error(j.message || j.error || "事前準備の生成に失敗しました");
      setData(j.preparation);
      setFallback(j.fallback);
    } catch (e) { setError(e instanceof Error ? e.message : "通信に失敗しました"); }
    finally { setLoading(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
              <Sparkles className="h-4 w-4" />
            </div>
            商談前 AI事前準備
            <Badge variant="warning" className="ml-1">
              {status === "LEAD" ? "リード" : "ヒアリング段階"}
            </Badge>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={generate} disabled={loading}>
              <Sparkles className="h-3.5 w-3.5" />
              {loading ? "生成中..." : data ? "再生成" : "AI準備"}
            </Button>
            {data && (
              <button onClick={() => setOpen(!open)} className="text-zinc-400 hover:text-zinc-600">
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      {error && <p role="alert" className="px-6 text-sm text-red-700">{error}</p>}
      {open && data && (
        <CardContent className="space-y-4">
          {fallback && (
            <p className="text-[13px] text-amber-700 bg-amber-100 px-3 py-1.5 rounded">
              AIキー未設定または生成失敗のためフォールバックを表示しています。
            </p>
          )}
          <LegacySection icon={MessageCircle} color="text-amber-600 bg-amber-50" title="ヒアリング項目">
            <ul className="space-y-1.5">
              {data.hearing_questions.map((q, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-amber-500 font-bold">Q{i + 1}.</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </LegacySection>

          <LegacySection icon={Lightbulb} color="text-orange-600 bg-orange-50" title="顧客課題の仮説">
            <ul className="space-y-1.5">
              {data.hypotheses.map((h, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-orange-500">-</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </LegacySection>

          <LegacySection icon={Sparkles} color="text-orange-600 bg-orange-50" title="想定論点">
            <ul className="space-y-1.5">
              {data.talking_points.map((p, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-orange-500">-</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </LegacySection>

          <LegacySection icon={ShieldAlert} color="text-red-600 bg-red-50" title="想定される懸念">
            <ul className="space-y-1.5">
              {data.common_concerns.map((c, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-red-500">!</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </LegacySection>

          <LegacySection icon={FileText} color="text-orange-600 bg-orange-50" title="推奨資料">
            <ul className="space-y-1.5">
              {data.recommended_materials.map((m, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-orange-500">-</span>
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          </LegacySection>
        </CardContent>
      )}
      {!data && (
        <CardContent>
          <p className="text-sm text-zinc-500 text-center py-4">
            AIが企業情報・業界・既存議事録から、ヒアリング項目、仮説、論点、懸念、推奨資料を生成します。
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function PreparationV2Panel({ dealId, status }: { dealId: string; status: string }) {
  const [brief, setBrief] = useState<PreparationBrief | null>(null);
  const [latestBrief, setLatestBrief] = useState<PreparationBrief | null>(null);
  const [history, setHistory] = useState<PreparationBrief[]>([]);
  const [selectedBriefId, setSelectedBriefId] = useState<string>("");
  const selectedBriefIdRef = useRef("");
  // Set while the requester's POST is running. On Cloud Run the POST returns only
  // after the whole generation (1-3 minutes), so the panel polls meanwhile.
  // baseId is the latest brief before the request: while GET still returns it,
  // the requested brief is not saved yet and is shown as pending.
  const [pendingRequest, setPendingRequest] = useState<{ baseId: string | null } | null>(null);
  const requestRef = useRef<{ baseId: string | null; adopted: boolean } | null>(null);
  const pollingRef = useRef(false);
  // Each GET of the latest brief and of the history is numbered when sent. Its
  // answer is used only when no newer answer of the same kind is shown; the POST
  // answer counts as newer than every GET sent before it. A status poll that
  // answers late therefore cannot take the display back from 完了 to 生成中.
  const readsRef = useRef({ latest: { sent: 0, shown: 0 }, history: { sent: 0, shown: 0 } });
  // Viewers may read saved briefs but not create them (the API answers can_create).
  // Hidden until the first GET answers: before it the panel knows neither the
  // permission nor the latest brief that a new request is told apart from.
  const [canCreate, setCanCreate] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Until the first latest/history reads have answered the panel does not know
  // whether a saved brief exists, so it shows 読み込み中 instead of 未作成.
  const [initialLoad, setInitialLoad] = useState<"loading" | "ready" | "failed">("loading");

  const selectBrief = useCallback((nextBrief: PreparationBrief | null) => {
    const id = nextBrief?.id ?? "";
    selectedBriefIdRef.current = id;
    setSelectedBriefId(id);
    setBrief(nextBrief);
  }, []);

  /** Resolves to undefined when a newer answer is already shown (this one is dropped). */
  const fetchLatestBrief = useCallback(async () => {
    const reads = readsRef.current.latest;
    const seq = ++reads.sent;
    const r = await fetch(`/api/deals/${dealId}/preparation`, { method: "GET" });
    if (!r.ok) throw new Error("事前準備の取得に失敗しました");
    const j = await r.json();
    if (seq <= reads.shown) return undefined;
    reads.shown = seq;
    const brief = (j.brief ?? null) as PreparationBrief | null;
    const latest = brief && withInterruptedStatus(brief);
    setLatestBrief(latest);
    setCanCreate(j.can_create !== false);
    return latest;
  }, [dealId]);

  /** Resolves to undefined when a newer history is already shown (this one is dropped). */
  const fetchHistory = useCallback(async () => {
    const reads = readsRef.current.history;
    const seq = ++reads.sent;
    const r = await fetch(`/api/deals/${dealId}/preparation?history=1`, { method: "GET" });
    if (!r.ok) throw new Error("事前準備の履歴取得に失敗しました");
    const j = await r.json();
    if (seq <= reads.shown) return undefined;
    reads.shown = seq;
    return ((j.briefs ?? []) as PreparationBrief[]).map(withInterruptedStatus);
  }, [dealId]);

  const loadInitial = useCallback(async () => {
    const latest = await fetchLatestBrief();
    const latestShown = readsRef.current.latest.shown;
    const rows = await fetchHistory();
    if (rows) {
      setHistory(rows);
      const initialBrief = rows.find((row) => row.id === latest?.id) ?? latest ?? rows[0] ?? null;
      // The history is read after the latest brief, so its row is the newer status
      // (e.g. 生成中 after リサーチ中). Show that one in the header too, unless a
      // newer latest read (a poll or the POST answer) has been shown meanwhile.
      if (latest && initialBrief?.id === latest.id && readsRef.current.latest.shown === latestShown) {
        setLatestBrief(initialBrief);
      }
      selectBrief(initialBrief);
    }
    setInitialLoad("ready");
  }, [fetchHistory, fetchLatestBrief, selectBrief]);

  const refreshHistoryPreservingSelection = useCallback(
    async (latest: PreparationBrief | null | undefined) => {
      const rows = await fetchHistory();
      if (!rows) return;
      setHistory(rows);
      const selectedId = selectedBriefIdRef.current;
      const selected = rows.find((row) => row.id === selectedId) ?? null;
      if (!selectedId || selectedId === latest?.id) {
        selectBrief(rows.find((row) => row.id === latest?.id) ?? latest ?? rows[0] ?? null);
      } else if (selected) {
        setBrief(selected);
      }
    },
    [fetchHistory, selectBrief],
  );

  useEffect(() => {
    void Promise.resolve().then(loadInitial).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
      setInitialLoad("failed");
    });
  }, [loadInitial]);

  const pollLatestBrief = useCallback(async () => {
    const latest = await fetchLatestBrief();
    if (!latest) return;
    const request = requestRef.current;
    // The requested brief is not saved yet; GET still returns the previous one.
    if (request && latest.id === request.baseId) return;
    if (request && !request.adopted) {
      // First sight of the requested brief: follow it, as the POST response would.
      request.adopted = true;
      selectBrief(latest);
      await refreshHistoryPreservingSelection(latest);
      return;
    }
    setHistory((rows) => rows.map((row) => (row.id === latest.id ? latest : row)));
    if (selectedBriefIdRef.current === latest.id) {
      setBrief(latest);
    }
    if (!isBriefInProgress(latest.status)) {
      await refreshHistoryPreservingSelection(latest);
    }
  }, [fetchLatestBrief, refreshHistoryPreservingSelection, selectBrief]);

  const loading = pendingRequest !== null;
  // Polls from the moment the POST is sent, not after it returns, so the
  // requester sees 準備中 → リサーチ中 → 生成中 while the server generates inline.
  const polling = loading || isBriefInProgress(latestBrief?.status);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      void pollLatestBrief()
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          pollingRef.current = false;
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [polling, pollLatestBrief]);

  async function generate() {
    // 同じイベント内の2回目のクリックは、再描画前で disabled がまだ効かない。Meet発行（meetInFlight）と同じく
    // 送信中の requestRef で止める（終わると finally で null に戻る）。
    if (requestRef.current) return;
    const request = { baseId: latestBrief?.id ?? null, adopted: false };
    requestRef.current = request;
    setPendingRequest({ baseId: request.baseId });
    setError(null);
    try {
      const r = await fetch(`/api/deals/${dealId}/preparation`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || "事前準備の生成に失敗しました");
      const nextBrief = (j.brief ?? null) as PreparationBrief | null;
      // Every GET sent so far is older than this answer: drop those still on the way.
      for (const reads of Object.values(readsRef.current)) reads.shown = reads.sent;
      setLatestBrief(nextBrief);
      // The POST answer is newer than the first reads, so they are no longer awaited.
      setInitialLoad("ready");
      if (nextBrief) setHistory((rows) => rows.map((row) => (row.id === nextBrief.id ? nextBrief : row)));
      // Once polling has shown the new brief, keep an older brief the requester
      // picked meanwhile instead of switching back when the POST returns.
      if (!request.adopted) {
        selectBrief(nextBrief);
      } else if (nextBrief && selectedBriefIdRef.current === nextBrief.id) {
        setBrief(nextBrief);
      }
      const latest = await fetchLatestBrief();
      await refreshHistoryPreservingSelection(latest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      requestRef.current = null;
      setPendingRequest(null);
    }
  }

  // Fetched briefs pass through withInterruptedStatus, so an interrupted one is not busy.
  const latestStatus =
    pendingRequest && (latestBrief?.id ?? null) === pendingRequest.baseId ? "pending" : latestBrief?.status;
  const latestBusy = isBriefInProgress(latestStatus);
  const busy = loading || latestBusy;
  // Until the history has answered too, the latest read alone may be one step
  // behind the body (リサーチ中 vs 生成中), so neither is shown yet.
  const initialLoading = initialLoad === "loading" && !pendingRequest;
  const statusText = initialLoading
    ? "読み込み中"
    : latestBusy
      ? progressText(latestStatus)
      : initialLoad === "failed" && !latestBrief
        ? "取得失敗"
        : latestStatus === "error"
          ? "失敗"
          : latestBrief
            ? "完了"
            : "未作成";

  return (
    <Card>
      <CardHeader className="pb-3">
        {/* On a narrow screen (390px) the buttons wrap below instead of squeezing the
            title to 事… and the status badge onto two lines. */}
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-base">
          <span className="flex flex-wrap items-center gap-2 min-w-0">
            <div className="rounded-lg bg-amber-600 text-white p-1.5 shadow-sm shrink-0">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="whitespace-nowrap">事前準備ブリーフ</span>
            <Badge variant="info" className="ml-1 shrink-0 whitespace-nowrap">
              {status}
            </Badge>
            <Badge variant={brief?.status === "error" ? "danger" : "outline"} className="shrink-0 whitespace-nowrap">{statusText}</Badge>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {canCreate && (
              <Button variant="primary" size="sm" onClick={generate} disabled={busy}>
                {latestStatus === "error" ? <RefreshCw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                {busy ? (initialLoading ? "読み込み中" : progressText(latestStatus)) : latestBrief ? "再実行" : "事前準備を作成"}
              </Button>
            )}
            {brief && (
              <button onClick={() => setOpen(!open)} className="text-zinc-400 hover:text-zinc-600">
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[13px] text-amber-800 bg-amber-50 border border-amber-100 px-3 py-2 rounded">
          AIによる仮説です。断定せず商談の土台として使ってください。
        </p>
        {error && <p className="text-[13px] text-red-700 bg-red-50 border border-red-100 px-3 py-2 rounded">{error}</p>}
        {brief?.status === "error" && (
          <p className="text-[13px] text-red-700 bg-red-50 border border-red-100 px-3 py-2 rounded whitespace-pre-wrap break-all">
            {brief.error || "生成に失敗しました。再実行は原因確認後にしてください。"}
          </p>
        )}
        {history.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-zinc-600">
            <span className="font-medium">過去のブリーフ</span>
            <select
              aria-label="過去のブリーフ"
              value={brief?.id ?? selectedBriefId}
              onChange={(event) => {
                const selected = history.find((item) => item.id === event.target.value) ?? null;
                selectedBriefIdRef.current = event.target.value;
                setSelectedBriefId(event.target.value);
                setBrief(selected);
              }}
              disabled={history.length === 1}
              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-[13px]"
            >
              {history.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {index === 0 ? "最新: " : ""}
                  {formatBriefCreatedAt(item.created_at)} / {progressText(item.status)}
                </option>
              ))}
            </select>
          </div>
        )}
        {!brief && initialLoad === "loading" && (
          <p role="status" className="text-sm text-zinc-500 text-center py-4">
            保存済みブリーフを読み込んでいます…
          </p>
        )}
        {!brief && initialLoad === "ready" && (
          <p className="text-sm text-zinc-500 text-center py-4">
            保存済みブリーフはありません。
          </p>
        )}
        {open && brief && isBriefInProgress(brief.status) && (
          // Not the sections yet: their 確認できず placeholders would read as research results.
          <p role="status" className="text-sm text-zinc-500 text-center py-4">
            {progressText(brief.status)}です。完了すると業界サマリー・採用状況・課題仮説を表示します（1〜3分程度）。
          </p>
        )}
        {open && brief && brief.status !== "error" && !isBriefInProgress(brief.status) && (
          <>
            <LegacySection icon={FileText} color="text-amber-600 bg-amber-50" title="業界サマリー">
              <BriefMarkdown text={brief.industry_summary || "確認できず"} />
            </LegacySection>

            <LegacySection icon={MessageCircle} color="text-orange-600 bg-orange-50" title="採用状況">
              <dl className="grid gap-2 text-sm">
                <BriefField label="媒体掲載" value={brief.hiring_insights?.media} />
                <BriefField label="募集職種" value={brief.hiring_insights?.roles} />
                <BriefField label="想定規模" value={brief.hiring_insights?.scale} />
              </dl>
              <SourcesList sources={brief.hiring_insights?.sources ?? []} />
            </LegacySection>

            <LegacySection icon={Lightbulb} color="text-amber-600 bg-amber-50" title="課題仮説">
              <ul className="space-y-3">
                {brief.pain_hypotheses.map((h, i) => (
                  <li key={i} className="text-sm text-zinc-800">
                    <div className="flex items-start gap-2">
                      <Badge variant={confidenceVariant(h.confidence)} className="mt-1 shrink-0 whitespace-nowrap">{confidenceLabel(h.confidence)}</Badge>
                      <BriefMarkdown text={h.hypothesis} />
                    </div>
                    <div className="mt-1"><BriefMarkdown text={h.evidence} /></div>
                    {h.source_url && (
                      <a
                        href={h.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[13px] text-amber-600 hover:underline"
                      >
                        出典 <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </LegacySection>

            <LegacySection icon={Sparkles} color="text-amber-600 bg-amber-50" title="提案ストーリー">
              <ProposalStory story={brief.proposal_story} />
            </LegacySection>

            <LegacySection icon={FileText} color="text-zinc-600 bg-zinc-50" title="出典">
              <SourcesList sources={brief.sources} />
            </LegacySection>
            {(brief.vertex_grounding?.text || brief.vertex_grounding?.searchHtml) && (
              <LegacySection icon={FileText} color="text-zinc-600 bg-zinc-50" title="公開情報の検索結果">
                <BriefMarkdown text={brief.vertex_grounding.text} />
                {brief.vertex_grounding.searchHtml && (
                  <iframe
                    title="Google検索候補"
                    srcDoc={brief.vertex_grounding.searchHtml}
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    className="mt-3 h-48 w-full border-0"
                  />
                )}
              </LegacySection>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BriefField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2">
      <dt className="text-[13px] font-semibold text-zinc-500">{label}</dt>
      <dd className="min-w-0"><BriefMarkdown text={value || "確認できず"} /></dd>
    </div>
  );
}

function SourcesList({ sources }: { sources: PreparationSource[] }) {
  if (sources.length === 0) {
    return <p className="mt-2 text-[13px] text-zinc-500">出典URL: 確認できず</p>;
  }
  return (
    <ul className="mt-2 space-y-1">
      {sources.map((source) => (
        <li key={source.url}>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[13px] text-amber-600 hover:underline break-all"
          >
            {source.title || source.url}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function progressText(status?: string): string {
  if (status === "done") return "完了";
  if (status === "error") return "失敗";
  // Same order as the saved status: pending → researching → generating.
  if (status === "pending") return "準備中";
  if (status === "researching") return "リサーチ中";
  if (status === "generating") return "生成中";
  return "未作成";
}

function formatBriefCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ProposalStory({ story }: { story?: string | null }) {
  if (!story) return <p className="text-sm text-zinc-500">確認できず</p>;
  return <BriefMarkdown text={story} />;
}

function BriefHeading({ children }: { children?: React.ReactNode }) {
  return <h4 className="font-semibold text-amber-700">{children}</h4>;
}

function BriefMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-3 text-sm leading-7 text-zinc-800 [overflow-wrap:anywhere] [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-50 [&_pre]:p-3">
      {/* Share the minutes renderer's safe Markdown parser. Keep its default URL
          sanitization; generated text must never introduce raw HTML or images. */}
      <ReactMarkdown
        skipHtml
        disallowedElements={["img"]}
        components={{
          h1: BriefHeading,
          h2: BriefHeading,
          h3: BriefHeading,
          h4: BriefHeading,
          h5: BriefHeading,
          h6: BriefHeading,
          p: ({ children }) => <p className="whitespace-pre-line">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-amber-200 pl-3 text-zinc-600">{children}</blockquote>,
          a: ({ href, children }) => href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-amber-700 underline underline-offset-2">
              {children}
            </a>
          ) : <span>{children}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function confidenceLabel(confidence: "high" | "medium" | "low"): string {
  if (confidence === "high") return "確度:高";
  if (confidence === "medium") return "確度:中";
  return "確度:低";
}

function confidenceVariant(confidence: "high" | "medium" | "low"): "success" | "warning" | "outline" {
  if (confidence === "high") return "success";
  if (confidence === "medium") return "warning";
  return "outline";
}

function LegacySection({
  icon: Icon,
  color,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`rounded-md p-1 ${color}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="font-semibold text-sm">{title}</span>
      </div>
      {children}
    </div>
  );
}
