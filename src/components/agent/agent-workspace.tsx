"use client";
// エージェントメイン画面（モノトーン / Apple・Airbnb ライクな操作感）。
// 旧: Cloud Run の営業リスト自動化ツール UI を iframe 埋め込み → 全面撤去し、
// Luma ネイティブの実行 UI に一新した。通信は /api/agent/gw 経由の server-to-server。
// - ワークスペース: 収集先の選択 → 実行（常に本番/factcheck）→ ライブ進捗 → 結果
// - 実行履歴: Cloud Run 側に残る過去 run の一覧・詳細
// - 概要: staging 候補ステータスの概況
// - 候補リスト: staging 候補のレビュー（承認/却下/取り込みは admin のみ）
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  Bot,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Download,
  Globe,
  FileText,
  Layers,
  Inbox,
  Clock,
  ArrowUpRight,
  ArrowLeft,
  Play,
  ChevronDown,
  ExternalLink,
  Loader2,
  AlertCircle,
  Table2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------- 型 ---------------------------------- */

type Tab = "workspace" | "history" | "overview" | "candidates";

type SourceDefaults = {
  mode?: string;
  limit?: number;
  parallel?: number;
  max_loops?: number;
  min_improvement?: number;
  source_start_position?: number;
  estimated_seconds_per_company?: number;
  include_step3?: boolean;
};

type AgentSource = {
  id: string;
  label: string;
  description?: string;
  defaults?: SourceDefaults;
  supports_seq_range?: boolean;
};

type SourceState = {
  recommended_start_position?: number;
  processed_count?: number;
  executed_at?: string;
};

type RunProgress = {
  count_done: number | null;
  count_total: number | null;
  stage: string | null;
  company: string | null;
};

type RunTotals = {
  total: number;
  verified: number;
  needs_review: number;
  out_of_scope: number;
};

type RunSummary = {
  run_dir?: string;
  totals?: RunTotals;
  loops?: unknown[];
};

type ResultCompany = {
  seq_no?: number;
  company_name: string;
  status: string;
  review_status?: string;
  next_action?: string;
  inquiry_kind?: string;
  email?: string;
  contact_form_url?: string;
  hp_url?: string;
  confidence?: number;
  warning_summary?: string;
};

type HistoryRun = {
  key: string;
  date: string;
  time: string;
  source: string;
  mode: string;
  limit?: number | null;
  totals?: RunTotals | null;
  has_companies?: boolean;
};

type HistoryDetail = HistoryRun & {
  companies?: ResultCompany[];
  review_packet?: ResultCompany[];
  loop_report?: string;
};

type Overview = {
  counts: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    ingested: number;
  };
  runCount: number;
  runs: {
    id: string;
    source: string;
    agentRunId: string | null;
    createdAt: string;
    candidateCount: number;
  }[];
  recent: {
    id: string;
    companyName: string;
    industry: string | null;
    websiteUrl: string | null;
    contactFormUrl: string | null;
    reviewStatus: string;
    createdAt: string;
    run: { source: string } | null;
  }[];
};

type Candidate = {
  id: string;
  sourceKey: string;
  companyName: string;
  websiteUrl: string | null;
  contactFormUrl: string | null;
  phone: string | null;
  email: string | null;
  industry: string | null;
  address: string | null;
  matchStatus: string | null;
  reviewStatus: string;
  createdAt: string;
  run: { source: string; agentRunId: string | null } | null;
};

const GW = "/api/agent/gw";
const ACTIVE_RUN_KEY = "luma_agent_active_run";
// 営業台帳（GAS組込済み、送信元設定・メニューはこのシート内の「設定」シートで管理）
const LEDGER_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1cuXK1K0GTK0u_J51MF4qQQueP1M_iTUcFBavhOIZr6Q/edit";

/* ------------------------------- 小物 UI ------------------------------- */

const STATUS_LABEL: Record<string, string> = {
  pending: "未レビュー",
  approved: "承認済み",
  rejected: "却下",
  ingested: "取り込み済み",
};

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-zinc-100 text-zinc-600 ring-zinc-200",
    approved: "bg-zinc-900 text-white ring-zinc-900",
    rejected: "bg-white text-zinc-400 ring-zinc-200 line-through",
    ingested: "bg-zinc-700 text-white ring-zinc-700",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        styles[status] ?? styles.pending,
      )}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function ResultStatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    verified: { label: "確認済み", cls: "bg-zinc-900 text-white ring-zinc-900" },
    needs_review: {
      label: "要レビュー",
      cls: "bg-zinc-100 text-zinc-600 ring-zinc-200",
    },
    out_of_scope: {
      label: "対象外",
      cls: "bg-white text-zinc-400 ring-zinc-200",
    },
  };
  const s = map[status] ?? {
    label: status,
    cls: "bg-zinc-100 text-zinc-600 ring-zinc-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        s.cls,
      )}
    >
      {s.label}
    </span>
  );
}

const STAGE_LABEL: Record<string, string> = {
  step1: "会社リスト抽出",
  hp: "公式HP解決",
  crawl: "サイト巡回",
  llm: "会社情報の抽出",
  factcheck: "ファクトチェック",
  step3: "文面生成",
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function formatEta(seconds: number) {
  if (seconds < 90) return `約${Math.max(1, Math.round(seconds))}秒`;
  const min = Math.round(seconds / 60);
  if (min < 90) return `約${min}分`;
  return `約${Math.round(min / 6) / 10}時間`;
}

/* ------------------------------ メイン画面 ------------------------------ */

export function AgentWorkspace({
  proxyConfigured,
  isAdmin,
}: {
  proxyConfigured: boolean;
  isAdmin: boolean;
}) {
  const [tab, setTab] = useState<Tab>("workspace");
  const [running, setRunning] = useState(false);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      const res = await fetch("/api/agent/overview");
      if (res.ok) setOverview(await res.json());
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: "workspace", label: "ワークスペース", icon: Bot },
    { key: "history", label: "実行履歴", icon: Clock },
    { key: "overview", label: "概要", icon: Layers },
    { key: "candidates", label: "候補リスト", icon: Inbox },
  ];

  return (
    <div className="flex h-full flex-col bg-[#fafafa]">
      {/* ヘッダー：タイトル + セグメントタブ */}
      <header className="shrink-0 border-b border-zinc-200/80 bg-white/90 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-900 shadow-sm">
              <Bot className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold tracking-tight text-zinc-900">
                エージェント
              </h1>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <span
                  className={cn(
                    "inline-block h-1.5 w-1.5 rounded-full",
                    !proxyConfigured
                      ? "bg-zinc-300"
                      : running
                        ? "animate-pulse bg-zinc-900"
                        : "bg-emerald-500",
                  )}
                />
                {!proxyConfigured
                  ? "接続未設定"
                  : running
                    ? "実行中"
                    : "スタンバイ"}
                <span className="text-zinc-300">·</span>
                営業リスト作成エージェント
              </div>
            </div>
          </div>

          {/* セグメントコントロール */}
          <div className="flex items-center rounded-xl bg-zinc-100 p-1">
            {tabs.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-all duration-200",
                    active
                      ? "bg-white text-zinc-900 shadow-sm"
                      : "text-zinc-500 hover:text-zinc-800",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 営業台帳（GAS組込済み）を新タブで開く */}
          <a
            href={LEDGER_SHEET_URL}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
          >
            <Table2 className="h-3.5 w-3.5" />
            営業台帳を開く
            <ExternalLink className="h-3 w-3 text-zinc-400" />
          </a>
        </div>
      </header>

      {/* コンテンツ（ワークスペースは SSE 維持のためタブ切替でもアンマウントしない） */}
      <div className="relative flex-1 overflow-hidden">
        <div
          className={cn(
            "absolute inset-0 overflow-y-auto",
            tab === "workspace" ? "visible" : "invisible",
          )}
        >
          <RunPanel
            proxyConfigured={proxyConfigured}
            onRunningChange={setRunning}
          />
        </div>

        {tab === "history" && (
          <div className="absolute inset-0 overflow-y-auto">
            <HistoryPanel />
          </div>
        )}

        {tab === "overview" && (
          <div className="absolute inset-0 overflow-y-auto">
            <OverviewPanel
              overview={overview}
              loading={overviewLoading}
              onRefresh={loadOverview}
              onGoCandidates={() => setTab("candidates")}
            />
          </div>
        )}

        {tab === "candidates" && (
          <div className="absolute inset-0 overflow-y-auto">
            <CandidatesPanel isAdmin={isAdmin} onChanged={loadOverview} />
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------- ワークスペース（実行） --------------------------- */

type Phase = "setup" | "running" | "done";

function RunPanel({
  proxyConfigured,
  onRunningChange,
}: {
  proxyConfigured: boolean;
  onRunningChange: (running: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);

  const [sources, setSources] = useState<AgentSource[]>([]);
  const [sourceStates, setSourceStates] = useState<Record<string, SourceState>>({});
  const [sheetsUrl, setSheetsUrl] = useState<string | null>(null);

  // フォーム状態
  const [sourceId, setSourceId] = useState<string>("");
  // お試し(dry-run)モードは廃止。常に本番(factcheck)実行のみ。
  const [mode] = useState<"dry-run" | "factcheck">("factcheck");
  const [limit, setLimit] = useState<number>(20);
  const [startPosition, setStartPosition] = useState<number | "">("");
  const [seqFrom, setSeqFrom] = useState<number | "">("");
  const [seqTo, setSeqTo] = useState<number | "">("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [parallel, setParallel] = useState<number>(30);
  const [maxLoops, setMaxLoops] = useState<number>(3);

  // 実行状態
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RunProgress>({
    count_done: null,
    count_total: null,
    stage: null,
    company: null,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [results, setResults] = useState<ResultCompany[]>([]);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const runMetaRef = useRef<{ source: string; mode: string } | null>(null);
  const runIdRef = useRef<string | null>(null);

  const selectedSource = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? null,
    [sources, sourceId],
  );

  useEffect(() => {
    onRunningChange(phase === "running");
  }, [phase, onRunningChange]);

  /* ---- 収集先の既定値・推奨開始位置をフォームへ反映（選択時/初期化時に呼ぶ） ---- */
  function applySourceDefaults(
    source: AgentSource,
    states: Record<string, SourceState>,
  ) {
    const d = source.defaults ?? {};
    setLimit((prev) => (prev ? prev : (d.limit ?? 20)));
    setParallel(d.parallel ?? 30);
    setMaxLoops(d.max_loops ?? 3);
    const rec = states[source.id]?.recommended_start_position;
    setStartPosition(rec ?? d.source_start_position ?? 1);
  }

  /* ---- 初期ロード：sources / source-states / config、実行中 run への再接続 ---- */
  const boot = useCallback(async () => {
    setBootLoading(true);
    setBootError(null);
    try {
      const [srcRes, stateRes, cfgRes] = await Promise.all([
        fetch(`${GW}/api/sources`),
        fetch(`${GW}/api/source-states`),
        fetch(`${GW}/api/config`),
      ]);
      if (!srcRes.ok) {
        const d = await srcRes.json().catch(() => ({}));
        throw new Error(d.error ?? `エージェントに接続できません（${srcRes.status}）`);
      }
      const srcData = await srcRes.json();
      const list: AgentSource[] = srcData.sources ?? [];
      setSources(list);

      let states: Record<string, SourceState> = {};
      if (stateRes.ok) {
        const st = await stateRes.json();
        states = st.sources ?? {};
        setSourceStates(states);
      }
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        setSheetsUrl(cfg.sheets_url ?? null);
      }

      if (list.length > 0) {
        setSourceId((prev) => prev || list[0].id);
        applySourceDefaults(list[0], states);
      }

      // 実行中 run があれば再接続（リロード対応）
      const saved =
        typeof window !== "undefined"
          ? window.localStorage.getItem(ACTIVE_RUN_KEY)
          : null;
      if (saved) {
        const stRes = await fetch(`${GW}/api/runs/${saved}`);
        if (stRes.ok) {
          const st = await stRes.json();
          if (st.status === "running") {
            runMetaRef.current = { source: st.source, mode: st.mode };
            runIdRef.current = saved;
            attachStream(saved);
            setPhase("running");
          } else {
            window.localStorage.removeItem(ACTIVE_RUN_KEY);
          }
        } else {
          window.localStorage.removeItem(ACTIVE_RUN_KEY);
        }
      }
    } catch (e) {
      setBootError(e instanceof Error ? e.message : "接続エラーが発生しました");
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!proxyConfigured) return;
    void boot();
    return () => {
      esRef.current?.close();
    };
  }, [proxyConfigured, boot]);

  /* ---- ログ自動スクロール ---- */
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  /* ---- SSE 接続 ---- */
  function attachStream(id: string) {
    esRef.current?.close();
    const es = new EventSource(`${GW}/api/runs/${id}/stream`);
    es.addEventListener("log", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        if (typeof d.line === "string") {
          setLogs((prev) =>
            prev.length > 2000 ? [...prev.slice(-1500), d.line] : [...prev, d.line],
          );
        }
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("progress", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        setProgress((prev) => ({
          count_done: d.count_done ?? prev.count_done,
          count_total: d.count_total ?? prev.count_total,
          stage: d.stage ?? prev.stage,
          company: d.company ?? null,
        }));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", async (ev) => {
      es.close();
      esRef.current = null;
      window.localStorage.removeItem(ACTIVE_RUN_KEY);
      let status = "failed";
      let error: string | null = null;
      let sum: RunSummary | null = null;
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        status = d.status ?? "failed";
        error = d.error ?? null;
        sum = d.summary ?? null;
      } catch {
        /* ignore */
      }
      setRunStatus(status);
      setRunError(error);
      setSummary(sum);
      if (status === "succeeded") {
        try {
          const res = await fetch(`${GW}/api/runs/${id}/results`);
          if (res.ok) {
            const data = await res.json();
            setResults(
              (data.review_packet?.length ? data.review_packet : data.companies) ??
                [],
            );
          }
        } catch {
          /* ignore */
        }
      }
      setPhase("done");
    });
    es.onerror = () => {
      // EventSource が自動再接続する（サーバ側は既存ログを replay）
    };
    esRef.current = es;
  }

  /* ---- 実行開始 ---- */
  async function startRun() {
    if (!selectedSource || starting) return;
    setStarting(true);
    setStopping(false);
    setRunError(null);
    try {
      const params: Record<string, unknown> = {
        limit,
        parallel,
        max_loops: maxLoops,
      };
      if (selectedSource.supports_seq_range) {
        if (seqFrom !== "") params.seq_from = seqFrom;
        if (seqTo !== "") params.seq_to = seqTo;
      } else if (startPosition !== "") {
        params.source_start_position = startPosition;
      }
      const res = await fetch(`${GW}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selectedSource.id, mode, params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.detail ?? data.error ?? `実行を開始できませんでした（${res.status}）`,
        );
      }
      runMetaRef.current = { source: selectedSource.id, mode };
      runIdRef.current = data.run_id;
      window.localStorage.setItem(ACTIVE_RUN_KEY, data.run_id);
      setLogs([]);
      setProgress({ count_done: null, count_total: limit, stage: null, company: null });
      setSummary(null);
      setResults([]);
      setRunStatus(null);
      attachStream(data.run_id);
      setPhase("running");
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "実行開始に失敗しました");
    } finally {
      setStarting(false);
    }
  }

  /* ---- 途中停止 ---- */
  async function handleStop() {
    const runId = runIdRef.current;
    if (!runId || stopping) return;
    setStopping(true);
    try {
      const res = await fetch(`${GW}/api/runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? data.error ?? `停止に失敗しました（${res.status}）`);
      }
      // 実際の停止完了は SSE の done イベントで検知される (attachStream 側で phase="done" に遷移)
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "停止に失敗しました");
      setStopping(false);
    }
  }

  function resetToSetup() {
    esRef.current?.close();
    esRef.current = null;
    setPhase("setup");
    setRunError(null);
    setLogs([]);
    setSummary(null);
    setResults([]);
    setRunStatus(null);
    // 本番実行後はカーソルが進むので推奨開始位置を取り直す
    fetch(`${GW}/api/source-states`)
      .then((r) => (r.ok ? r.json() : null))
      .then((st) => {
        if (!st) return;
        const states = st.sources ?? {};
        setSourceStates(states);
        if (selectedSource) applySourceDefaults(selectedSource, states);
      })
      .catch(() => {});
  }

  /* ---- 未設定 / ロード中 / エラー ---- */
  if (!proxyConfigured) {
    return (
      <CenterCard
        icon={<Bot className="h-6 w-6 text-zinc-400" />}
        title="エージェント接続が未設定です"
        body={
          <>
            環境変数{" "}
            <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px]">
              AGENT_PROXY_URL
            </code>{" "}
            を設定すると、この画面でエージェントを直接操作できます。
          </>
        }
      />
    );
  }

  if (bootLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 shadow-lg shadow-zinc-900/10">
          <Bot className="h-7 w-7 animate-pulse text-white" />
        </div>
        <div className="text-center">
          <div className="text-sm font-semibold text-zinc-800">
            エージェントに接続しています
          </div>
          <div className="mt-1 text-xs text-zinc-500">収集先の情報を取得中…</div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <CenterCard
        icon={<AlertCircle className="h-6 w-6 text-zinc-400" />}
        title="エージェントに接続できません"
        body={bootError}
        action={
          <button
            onClick={boot}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            再接続
          </button>
        }
      />
    );
  }

  /* ---- 実行中ビュー ---- */
  if (phase === "running") {
    const total = progress.count_total;
    const done = progress.count_done ?? 0;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : null;
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              実行中
              {runMetaRef.current && (
                <>
                  <span className="text-zinc-300">·</span>
                  {sources.find((s) => s.id === runMetaRef.current?.source)?.label ??
                    runMetaRef.current.source}
                </>
              )}
            </div>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-zinc-900">
              {progress.stage
                ? (STAGE_LABEL[progress.stage] ?? progress.stage)
                : "準備しています…"}
            </h2>
            {progress.company && (
              <p className="mt-1 truncate text-sm text-zinc-500">{progress.company}</p>
            )}
          </div>
          <button
            onClick={handleStop}
            disabled={stopping}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-[13px] font-medium text-red-600 shadow-sm transition-colors hover:bg-red-50 disabled:opacity-50"
          >
            {stopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            {stopping ? "停止中…" : "途中で止める"}
          </button>
        </div>

        {/* 進捗バー */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-end justify-between">
            <div className="text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
              {total ? `${done} / ${total}` : "—"}
              <span className="ml-2 text-sm font-medium text-zinc-400">社</span>
            </div>
            {pct != null && (
              <div className="text-sm font-semibold tabular-nums text-zinc-500">
                {pct}%
              </div>
            )}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            {pct != null ? (
              <div
                className="h-full rounded-full bg-zinc-900 transition-all duration-700 ease-out"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            ) : (
              <div className="h-full w-1/3 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-zinc-900" />
            )}
          </div>
          <style>{`@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
          <p className="mt-3 text-[11px] text-zinc-400">
            実行はサーバー側で継続されます。画面を離れても中断されません。「途中で止める」を押すと、完了済みループの結果は台帳に残したまま停止します（処理中だったループの分は反映されません）。
          </p>
        </div>

        {/* ライブログ */}
        <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-zinc-950 shadow-sm">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              ライブログ
            </span>
            <span className="text-[11px] tabular-nums text-zinc-500">
              {logs.length} 行
            </span>
          </div>
          <div
            ref={logBoxRef}
            className="h-72 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-5 text-zinc-300"
          >
            {logs.length === 0 ? (
              <span className="text-zinc-500">ログを待機しています…</span>
            ) : (
              logs.map((l, i) => <div key={i}>{l}</div>)
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ---- 完了ビュー ---- */
  if (phase === "done") {
    const totals = summary?.totals;
    const succeeded = runStatus === "succeeded";
    const cancelled = runStatus === "cancelled";
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-500">
              {succeeded ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 text-zinc-400" />
              )}
              {succeeded
                ? "実行が完了しました"
                : cancelled
                  ? "途中で停止しました"
                  : "実行が失敗しました"}
            </div>
            <h2 className="mt-1 text-xl font-bold tracking-tight text-zinc-900">
              結果
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {sheetsUrl && (
              <a
                href={sheetsUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3.5 py-2 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
              >
                <Table2 className="h-3.5 w-3.5" />
                台帳を開く
                <ExternalLink className="h-3 w-3 text-zinc-400" />
              </a>
            )}
            <button
              onClick={resetToSetup}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-700"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              新しい実行
            </button>
          </div>
        </div>

        {!succeeded && (
          <div className="mb-4 rounded-2xl border border-zinc-200 bg-white p-5 text-sm text-zinc-600 shadow-sm">
            {runError ?? "詳細はライブログを確認してください。"}
          </div>
        )}

        {totals && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "処理企業", value: totals.total },
              { label: "確認済み", value: totals.verified },
              { label: "要レビュー", value: totals.needs_review },
              { label: "対象外", value: totals.out_of_scope },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm"
              >
                <div className="text-xs font-medium text-zinc-500">{s.label}</div>
                <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
            <CompaniesTable companies={results} />
          </div>
        )}

        {/* 失敗時などのためログも残す */}
        {logs.length > 0 && (
          <details className="mt-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
            <summary className="cursor-pointer select-none px-5 py-3.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50">
              実行ログを表示（{logs.length} 行）
            </summary>
            <div className="max-h-72 overflow-y-auto border-t border-zinc-100 bg-zinc-950 px-4 py-3 font-mono text-[11px] leading-5 text-zinc-300">
              {logs.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </details>
        )}
      </div>
    );
  }

  /* ---- セットアップビュー ---- */
  const etaSeconds =
    (selectedSource?.defaults?.estimated_seconds_per_company ?? 240) *
    Math.max(1, limit);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-7">
        <h2 className="text-xl font-bold tracking-tight text-zinc-900">
          新しいリスト作成
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          収集先とモードを選んで実行すると、会社リストの生成から公式HP・連絡先の解決までを自動で行います。
        </p>
      </div>

      {/* STEP 1: 収集先 */}
      <SectionLabel step="1" title="収集先" subtitle="どこから会社を集めるか" />
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sources.map((s) => {
          const active = s.id === sourceId;
          const state = sourceStates[s.id];
          return (
            <button
              key={s.id}
              onClick={() => {
                setSourceId(s.id);
                applySourceDefaults(s, sourceStates);
              }}
              className={cn(
                "group relative rounded-2xl border bg-white p-4 text-left shadow-sm transition-all duration-200",
                active
                  ? "border-zinc-900 ring-1 ring-zinc-900"
                  : "border-zinc-200/80 hover:border-zinc-300 hover:shadow-md",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-[14px] font-semibold text-zinc-900">
                  {s.label}
                </div>
                <span
                  className={cn(
                    "mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    active
                      ? "border-zinc-900 bg-zinc-900"
                      : "border-zinc-300 bg-white",
                  )}
                >
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
              </div>
              {s.description && (
                <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-zinc-500">
                  {s.description}
                </p>
              )}
              {state?.recommended_start_position != null && (
                <p className="mt-2 text-[11px] text-zinc-400">
                  次の開始位置: {state.recommended_start_position} 社目〜
                </p>
              )}
            </button>
          );
        })}
      </div>

      {/* STEP 2: 件数・範囲 */}
      <div className="mt-8">
        <SectionLabel step="2" title="対象範囲" subtitle="処理する会社の件数" />
        <div className="mt-3 rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField
              label="件数"
              value={limit}
              min={1}
              onChange={(v) => setLimit(v ?? 1)}
            />
            {selectedSource?.supports_seq_range ? (
              <>
                <NumberField
                  label="開始 No.（任意）"
                  value={seqFrom}
                  min={1}
                  onChange={(v) => setSeqFrom(v ?? "")}
                  placeholder="台帳の連番"
                />
                <NumberField
                  label="終了 No.（任意）"
                  value={seqTo}
                  min={1}
                  onChange={(v) => setSeqTo(v ?? "")}
                  placeholder="台帳の連番"
                />
              </>
            ) : (
              <NumberField
                label="開始位置"
                value={startPosition}
                min={1}
                onChange={(v) => setStartPosition(v ?? "")}
                hint="前回の続きが自動で入ります"
              />
            )}
          </div>

          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="mt-4 flex items-center gap-1 text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-900"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                showAdvanced && "rotate-180",
              )}
            />
            詳細設定
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 gap-4 border-t border-zinc-100 pt-4 sm:grid-cols-3">
              <NumberField
                label="並列数"
                value={parallel}
                min={1}
                onChange={(v) => setParallel(v ?? 1)}
                hint="同時に処理する会社数"
              />
              <NumberField
                label="最大ループ回数"
                value={maxLoops}
                min={1}
                onChange={(v) => setMaxLoops(v ?? 1)}
                hint="未解決分の再調査回数"
              />
            </div>
          )}
        </div>
      </div>

      {/* 実行 */}
      <div className="mt-8 flex flex-col items-stretch gap-3">
        {runError && (
          <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-red-600 shadow-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {runError}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-zinc-900">
              {selectedSource?.label ?? "—"}
              <span className="mx-1.5 text-zinc-300">·</span>
              {limit} 社
            </div>
            <div className="mt-0.5 text-[12px] text-zinc-500">
              所要時間の目安: {formatEta(etaSeconds)}
            </div>
          </div>
          <button
            onClick={startRun}
            disabled={!selectedSource || starting}
            className="flex items-center gap-2 rounded-xl bg-zinc-900 px-6 py-3 text-[14px] font-semibold text-white shadow-lg shadow-zinc-900/10 transition-all hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-40"
          >
            {starting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            本番実行
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({
  step,
  title,
  subtitle,
}: {
  step: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-bold text-white">
        {step}
      </span>
      <span className="text-[15px] font-semibold text-zinc-900">{title}</span>
      {subtitle && <span className="text-[12px] text-zinc-400">{subtitle}</span>}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  placeholder,
  hint,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | null) => void;
  min?: number;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-medium text-zinc-500">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
        className="mt-1.5 w-full rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-[14px] font-medium text-zinc-900 tabular-nums shadow-sm outline-none transition-shadow placeholder:text-zinc-300 focus:border-zinc-900 focus:ring-1 focus:ring-zinc-900"
      />
      {hint && <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>}
    </label>
  );
}

function CenterCard({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100">
          {icon}
        </div>
        <h2 className="text-sm font-semibold text-zinc-800">{title}</h2>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">{body}</p>
        {action}
      </div>
    </div>
  );
}

/* ------------------------------ 結果テーブル ------------------------------ */

function CompaniesTable({ companies }: { companies: ResultCompany[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            <th className="px-5 py-3">会社名</th>
            <th className="px-3 py-3">状態</th>
            <th className="px-3 py-3">連絡手段</th>
            <th className="px-3 py-3">リンク</th>
            <th className="px-3 py-3">次のアクション</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-50">
          {companies.map((c, i) => (
            <tr key={`${c.seq_no ?? i}-${c.company_name}`} className="align-top transition-colors hover:bg-zinc-50/60">
              <td className="px-5 py-3">
                <div className="font-medium text-zinc-900">
                  {c.seq_no != null && (
                    <span className="mr-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">
                      #{c.seq_no}
                    </span>
                  )}
                  {c.company_name}
                </div>
                {c.warning_summary && (
                  <div className="mt-0.5 text-xs text-zinc-400">
                    {c.warning_summary}
                  </div>
                )}
              </td>
              <td className="px-3 py-3">
                <ResultStatusPill status={c.status} />
              </td>
              <td className="px-3 py-3 text-zinc-600">
                {c.inquiry_kind && (
                  <div className="text-[12px]">{c.inquiry_kind}</div>
                )}
                {c.email && <div className="text-xs text-zinc-500">{c.email}</div>}
              </td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-2">
                  {c.hp_url && (
                    <a
                      href={c.hp_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
                    >
                      <Globe className="h-3.5 w-3.5" /> HP
                    </a>
                  )}
                  {c.contact_form_url && (
                    <a
                      href={c.contact_form_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
                    >
                      <FileText className="h-3.5 w-3.5" /> フォーム
                    </a>
                  )}
                </div>
              </td>
              <td className="px-3 py-3 text-[12px] text-zinc-600">
                {c.next_action ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------- 実行履歴 ------------------------------- */

function HistoryPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<HistoryRun[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${GW}/api/history`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "履歴を取得できませんでした");
      setRuns(data.runs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(run: HistoryRun) {
    setDetailLoading(true);
    try {
      const res = await fetch(`${GW}/api/history/${run.key}`);
      if (res.ok) setDetail(await res.json());
    } finally {
      setDetailLoading(false);
    }
  }

  if (detail || detailLoading) {
    const companies =
      (detail?.review_packet?.length ? detail.review_packet : detail?.companies) ??
      [];
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <button
          onClick={() => setDetail(null)}
          className="mb-5 flex items-center gap-1.5 text-[13px] font-medium text-zinc-500 transition-colors hover:text-zinc-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          履歴一覧に戻る
        </button>
        {detailLoading || !detail ? (
          <div className="py-16 text-center text-sm text-zinc-400">読み込み中…</div>
        ) : (
          <>
            <div className="mb-6">
              <h2 className="text-xl font-bold tracking-tight text-zinc-900">
                {detail.date} {detail.time}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {detail.source}
                <span className="mx-1.5 text-zinc-300">·</span>
                {detail.mode === "dry-run" ? "お試し" : "本番"}
                {detail.limit != null && (
                  <>
                    <span className="mx-1.5 text-zinc-300">·</span>
                    {detail.limit} 社
                  </>
                )}
              </p>
            </div>
            {detail.totals && (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {[
                  { label: "処理企業", value: detail.totals.total },
                  { label: "確認済み", value: detail.totals.verified },
                  { label: "要レビュー", value: detail.totals.needs_review },
                  { label: "対象外", value: detail.totals.out_of_scope },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm"
                  >
                    <div className="text-xs font-medium text-zinc-500">
                      {s.label}
                    </div>
                    <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {companies.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
                <CompaniesTable companies={companies} />
              </div>
            )}
            {detail.loop_report && (
              <details className="mt-4 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
                <summary className="cursor-pointer select-none px-5 py-3.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-50">
                  実行レポートを表示
                </summary>
                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap border-t border-zinc-100 px-5 py-4 text-[12px] leading-relaxed text-zinc-600">
                  {detail.loop_report}
                </pre>
              </details>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-900">
            実行履歴
          </h2>
          <p className="mt-1 text-sm text-zinc-500">過去のリスト作成の実行結果</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          更新
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-red-600 shadow-sm">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-sm text-zinc-400">読み込み中…</div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100">
              <Clock className="h-6 w-6 text-zinc-300" />
            </div>
            <div className="text-sm text-zinc-400">実行履歴はまだありません</div>
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {runs.map((r) => (
              <button
                key={r.key}
                onClick={() => openDetail(r)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-zinc-50"
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-zinc-900">
                    {r.date} {r.time}
                    <span className="ml-2 font-normal text-zinc-400">
                      {r.source}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-zinc-500">
                    {r.mode === "dry-run" ? "お試し" : "本番"}
                    {r.limit != null && (
                      <>
                        <span className="mx-1 text-zinc-300">·</span>
                        {r.limit} 社
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {r.totals && (
                    <div className="hidden items-center gap-3 text-[12px] tabular-nums text-zinc-500 sm:flex">
                      <span>
                        確認済み{" "}
                        <span className="font-semibold text-zinc-900">
                          {r.totals.verified}
                        </span>
                      </span>
                      <span>
                        要レビュー{" "}
                        <span className="font-semibold text-zinc-900">
                          {r.totals.needs_review}
                        </span>
                      </span>
                    </div>
                  )}
                  <ArrowUpRight className="h-4 w-4 text-zinc-300" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- 概要パネル ------------------------------- */

function OverviewPanel({
  overview,
  loading,
  onRefresh,
  onGoCandidates,
}: {
  overview: Overview | null;
  loading: boolean;
  onRefresh: () => void;
  onGoCandidates: () => void;
}) {
  const stats = useMemo(() => {
    const c = overview?.counts;
    return [
      { label: "候補企業", value: c?.total ?? 0, sub: "累計", icon: Globe },
      { label: "未レビュー", value: c?.pending ?? 0, sub: "レビュー待ち", icon: Clock },
      { label: "承認済み", value: c?.approved ?? 0, sub: "取り込み待ち", icon: CheckCircle2 },
      { label: "取り込み済み", value: c?.ingested ?? 0, sub: "CRM 反映済み", icon: Download },
    ];
  }, [overview]);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-900">概要</h2>
          <p className="mt-1 text-sm text-zinc-500">
            エージェントの実行状況と候補企業のステータス
          </p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          更新
        </button>
      </div>

      {/* 統計カード */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="group rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500">{s.label}</span>
                <Icon className="h-4 w-4 text-zinc-300 transition-colors group-hover:text-zinc-500" />
              </div>
              <div className="mt-2 text-3xl font-bold tracking-tight text-zinc-900 tabular-nums">
                {s.value.toLocaleString()}
              </div>
              <div className="mt-1 text-[11px] text-zinc-400">{s.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-5">
        {/* 実行履歴（DB側） */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm lg:col-span-2">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-zinc-900">取り込み実行</h3>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              累計 {overview?.runCount ?? 0} 回の候補投入
            </p>
          </div>
          <div className="divide-y divide-zinc-50 px-2 py-1">
            {(overview?.runs ?? []).length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-zinc-400">
                実行履歴はまだありません
              </div>
            ) : (
              overview!.runs.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-zinc-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-zinc-800">
                      {r.source}
                      {r.agentRunId && (
                        <span className="ml-1.5 font-normal text-zinc-400">
                          {r.agentRunId}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      {formatDate(r.createdAt)}
                    </div>
                  </div>
                  <div className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-600 tabular-nums">
                    {r.candidateCount} 件
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 最近の候補 */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm lg:col-span-3">
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900">最近の候補</h3>
              <p className="mt-0.5 text-[11px] text-zinc-400">
                直近に収集された候補企業
              </p>
            </div>
            <button
              onClick={onGoCandidates}
              className="flex items-center gap-1 text-[12px] font-medium text-zinc-500 transition-colors hover:text-zinc-900"
            >
              すべて見る
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="divide-y divide-zinc-50 px-2 py-1">
            {(overview?.recent ?? []).length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-zinc-400">
                候補はまだありません
              </div>
            ) : (
              overview!.recent.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-zinc-50"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-zinc-800">
                      {c.companyName}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                      {c.run?.source && <span>{c.run.source}</span>}
                      {c.industry && <span>{c.industry}</span>}
                      <span>{formatDate(c.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {c.websiteUrl && (
                      <a
                        href={c.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-300 transition-colors hover:text-zinc-700"
                        title="公式サイト"
                      >
                        <Globe className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {c.contactFormUrl && (
                      <a
                        href={c.contactFormUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-300 transition-colors hover:text-zinc-700"
                        title="問い合わせフォーム"
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </a>
                    )}
                    <StatusPill status={c.reviewStatus} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- 候補リストパネル ----------------------------- */

const FILTERS = [
  { key: "pending", label: "未レビュー" },
  { key: "approved", label: "承認済み" },
  { key: "rejected", label: "却下" },
  { key: "ingested", label: "取り込み済み" },
  { key: "", label: "すべて" },
];

function CandidatesPanel({
  isAdmin,
  onChanged,
}: {
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pending, start] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agent/candidates${filter ? `?status=${filter}` : ""}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "読み込みに失敗しました");
      setCandidates(data.candidates ?? []);
      const c: Record<string, number> = {};
      for (const row of data.counts ?? []) c[row.reviewStatus] = row._count?._all ?? 0;
      setCounts(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  function review(id: string, action: "approve" | "reject") {
    start(async () => {
      setNotice(null);
      setError(null);
      const res = await fetch(`/api/admin/agent-candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "更新に失敗しました");
        return;
      }
      await load();
      onChanged();
    });
  }

  function ingest() {
    if (!window.confirm("承認済みの候補を Company/Contact に取り込みます。よろしいですか？"))
      return;
    start(async () => {
      setNotice(null);
      setError(null);
      const res = await fetch(`/api/admin/agent-candidates/ingest`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "取り込みに失敗しました");
        return;
      }
      setNotice(
        `取り込み完了：${data.ingested}件（新規 ${data.created} / 既存更新 ${data.updated}）`,
      );
      await load();
      onChanged();
    });
  }

  const approvedCount = counts["approved"] ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-900">候補リスト</h2>
          <p className="mt-1 text-sm text-zinc-500">
            エージェントが収集した候補企業のレビューと CRM への取り込み
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading || pending}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            更新
          </button>
          {isAdmin && (
            <button
              onClick={ingest}
              disabled={pending || approvedCount === 0}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-zinc-700 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              承認済みを取り込み{approvedCount ? `（${approvedCount}）` : ""}
            </button>
          )}
        </div>
      </div>

      {/* フィルタ（セグメント） */}
      <div className="mb-4 inline-flex flex-wrap items-center rounded-xl bg-zinc-100 p-1">
        {FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all duration-200",
              filter === f.key
                ? "bg-white text-zinc-900 shadow-sm"
                : "text-zinc-500 hover:text-zinc-800",
            )}
          >
            {f.label}
            {f.key && counts[f.key] != null && (
              <span className="ml-1 text-[11px] text-zinc-400 tabular-nums">
                {counts[f.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm text-red-600 shadow-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-xl border border-zinc-200 bg-zinc-900 px-4 py-2.5 text-sm text-white shadow-sm">
          {notice}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm">
        {loading ? (
          <div className="py-16 text-center text-sm text-zinc-400">読み込み中…</div>
        ) : candidates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100">
              <Inbox className="h-6 w-6 text-zinc-300" />
            </div>
            <div className="text-sm text-zinc-400">候補がありません</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  <th className="px-5 py-3">会社名</th>
                  <th className="px-3 py-3">媒体</th>
                  <th className="px-3 py-3">リンク</th>
                  <th className="px-3 py-3">連絡先</th>
                  <th className="px-3 py-3">突合</th>
                  <th className="px-3 py-3">状態</th>
                  {isAdmin && <th className="px-5 py-3 text-right">操作</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50">
                {candidates.map((c) => (
                  <tr key={c.id} className="align-top transition-colors hover:bg-zinc-50/60">
                    <td className="px-5 py-3">
                      <div className="font-medium text-zinc-900">{c.companyName}</div>
                      {c.industry && (
                        <div className="text-xs text-zinc-400">{c.industry}</div>
                      )}
                      {c.address && (
                        <div className="text-xs text-zinc-400">{c.address}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-zinc-500">{c.run?.source}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        {c.websiteUrl && (
                          <a
                            href={c.websiteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
                          >
                            <Globe className="h-3.5 w-3.5" /> HP
                          </a>
                        )}
                        {c.contactFormUrl && (
                          <a
                            href={c.contactFormUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-zinc-500 underline-offset-2 transition-colors hover:text-zinc-900 hover:underline"
                          >
                            <FileText className="h-3.5 w-3.5" /> フォーム
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-zinc-500">
                      {c.phone && <div>{c.phone}</div>}
                      {c.email && <div className="text-xs">{c.email}</div>}
                    </td>
                    <td className="px-3 py-3">
                      {c.matchStatus && c.matchStatus !== "new" ? (
                        <span className="inline-flex items-center rounded-full bg-zinc-100 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-600 ring-1 ring-inset ring-zinc-200">
                          既存一致（{c.matchStatus}）
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-white px-2.5 py-0.5 text-[11px] font-semibold text-zinc-500 ring-1 ring-inset ring-zinc-200">
                          新規
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <StatusPill status={c.reviewStatus} />
                    </td>
                    {isAdmin && (
                      <td className="whitespace-nowrap px-5 py-3 text-right">
                        {c.reviewStatus !== "ingested" && (
                          <div className="inline-flex items-center gap-1">
                            <button
                              disabled={pending}
                              onClick={() => review(c.id, "approve")}
                              title="承認"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-900 hover:text-white disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </button>
                            <button
                              disabled={pending}
                              onClick={() => review(c.id, "reject")}
                              title="却下"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
                            >
                              <XCircle className="h-4 w-4" />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
