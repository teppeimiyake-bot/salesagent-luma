"use client";
// エージェントメイン画面（モノトーン / Apple・Airbnb ライクな操作感）。
// サイドバーの「エージェント」を押した瞬間にこの画面になる。
// - ワークスペース: agent-proxy 経由の Cloud Run UI をフル画面 iframe で埋め込み
// - 概要: 実行履歴と候補ステータスの概況
// - 候補リスト: staging 候補のレビュー（承認/却下/取り込みは admin のみ）
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  Bot,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Download,
  Globe,
  FileText,
  Layers,
  Inbox,
  Clock,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ---------------------------------- 型 ---------------------------------- */

type Tab = "workspace" | "overview" | "candidates";

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

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
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
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

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
    // 初回マウント時の概況フェッチ（ローディングフラグ更新を含む）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadOverview();
  }, [loadOverview]);

  const tabs: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: "workspace", label: "ワークスペース", icon: Bot },
    { key: "overview", label: "概要", icon: Layers },
    { key: "candidates", label: "候補リスト", icon: Inbox },
  ];

  return (
    <div className="flex h-full flex-col bg-[#fafafa]">
      {/* ヘッダー：タイトル + セグメントタブ + アクション */}
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
                    proxyConfigured ? "bg-emerald-500" : "bg-zinc-300",
                  )}
                />
                {proxyConfigured ? "オンライン" : "接続未設定"}
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

          <div className="flex items-center gap-2">
            {tab === "workspace" && proxyConfigured && (
              <button
                onClick={() => {
                  setFrameLoaded(false);
                  setFrameKey((k) => k + 1);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
                title="再読み込み"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            )}
            {proxyConfigured && (
              <a
                href="/api/agent/open"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-[13px] font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50"
              >
                新しいタブで開く
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </header>

      {/* コンテンツ */}
      <div className="relative flex-1 overflow-hidden">
        {/* ワークスペース（iframe はタブ切替でもアンマウントしない） */}
        <div
          className={cn(
            "absolute inset-0",
            tab === "workspace" ? "visible" : "invisible",
          )}
        >
          {proxyConfigured ? (
            <>
              {!frameLoaded && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[#fafafa]">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-900 shadow-lg shadow-zinc-900/10">
                    <Bot className="h-7 w-7 animate-pulse text-white" />
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-zinc-800">
                      エージェントに接続しています
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      安全なプロキシ経由でセッションを確立中…
                    </div>
                  </div>
                  <div className="h-0.5 w-40 overflow-hidden rounded-full bg-zinc-200">
                    <div className="h-full w-1/3 animate-[shimmer_1.2s_ease-in-out_infinite] rounded-full bg-zinc-900" />
                  </div>
                  <style>{`@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
                </div>
              )}
              <iframe
                key={frameKey}
                src="/api/agent/open"
                title="営業リスト作成エージェント"
                className="h-full w-full border-0 bg-white"
                onLoad={() => setFrameLoaded(true)}
                allow="clipboard-read; clipboard-write"
              />
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100">
                  <Bot className="h-6 w-6 text-zinc-400" />
                </div>
                <h2 className="text-sm font-semibold text-zinc-800">
                  エージェント接続が未設定です
                </h2>
                <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                  環境変数{" "}
                  <code className="rounded bg-zinc-100 px-1 py-0.5 text-[11px]">
                    AGENT_PROXY_URL
                  </code>{" "}
                  を設定すると、この画面でエージェントを直接操作できます。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 概要 */}
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

        {/* 候補リスト */}
        {tab === "candidates" && (
          <div className="absolute inset-0 overflow-y-auto">
            <CandidatesPanel isAdmin={isAdmin} onChanged={loadOverview} />
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
        {/* 実行履歴 */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm lg:col-span-2">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-zinc-900">実行履歴</h3>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              累計 {overview?.runCount ?? 0} 回の実行
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
    // フィルタ変更時の再フェッチ（ローディングフラグ更新を含む）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
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
