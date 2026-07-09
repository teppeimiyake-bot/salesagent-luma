"use client";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Download,
} from "lucide-react";

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
  matchedCompanyId: string | null;
  reviewStatus: string;
  createdAt: string;
  run: { source: string; agentRunId: string | null } | null;
};

const STATUS_FILTERS = [
  { key: "pending", label: "未レビュー" },
  { key: "approved", label: "承認済み" },
  { key: "rejected", label: "却下" },
  { key: "ingested", label: "取り込み済み" },
  { key: "", label: "すべて" },
];

function statusBadge(s: string) {
  switch (s) {
    case "approved":
      return <Badge variant="success">承認済み</Badge>;
    case "rejected":
      return <Badge variant="danger">却下</Badge>;
    case "ingested":
      return <Badge variant="info">取り込み済み</Badge>;
    default:
      return <Badge variant="warning">未レビュー</Badge>;
  }
}

export function AgentCandidatesAdmin() {
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pending, start] = useTransition();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/agent-candidates${filter ? `?status=${filter}` : ""}`,
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "読み込みに失敗しました");
      setCandidates(data.candidates ?? []);
      const c: Record<string, number> = {};
      for (const row of data.counts ?? [])
        c[row.reviewStatus] = row._count?._all ?? 0;
      setCounts(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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
    });
  }

  function ingest() {
    if (
      !window.confirm(
        "承認済みの候補を Company/Contact に取り込みます。よろしいですか？",
      )
    )
      return;
    start(async () => {
      setNotice(null);
      setError(null);
      const res = await fetch(`/api/admin/agent-candidates/ingest`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "取り込みに失敗しました");
        return;
      }
      setNotice(
        `取り込み完了：${data.ingested}件（新規 ${data.created} / 既存更新 ${data.updated}）`,
      );
      await load();
    });
  }

  const approvedCount = counts["approved"] ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key || "all"}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                filter === f.key
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-600 hover:bg-zinc-100"
              }`}
            >
              {f.label}
              {f.key && counts[f.key] != null ? `（${counts[f.key]}）` : ""}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={loading || pending}
          >
            <RefreshCw className="h-4 w-4 mr-1" /> 更新
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={ingest}
            disabled={pending || approvedCount === 0}
          >
            <Download className="h-4 w-4 mr-1" /> 承認済みを取り込み
            {approvedCount ? `（${approvedCount}）` : ""}
          </Button>
        </div>
      </div>

      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}
      {notice && <div className="mb-3 text-sm text-emerald-700">{notice}</div>}

      {loading ? (
        <div className="text-sm text-zinc-500 py-8 text-center">読み込み中…</div>
      ) : candidates.length === 0 ? (
        <div className="text-sm text-zinc-500 py-8 text-center">
          候補がありません
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-200">
                <th className="py-2 pr-3">会社名</th>
                <th className="py-2 pr-3">媒体</th>
                <th className="py-2 pr-3">HP / フォーム</th>
                <th className="py-2 pr-3">電話 / メール</th>
                <th className="py-2 pr-3">突合</th>
                <th className="py-2 pr-3">状態</th>
                <th className="py-2 pr-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.id}
                  className="border-b border-zinc-100 align-top"
                >
                  <td className="py-2 pr-3 font-medium">
                    {c.companyName}
                    {c.industry && (
                      <div className="text-xs text-zinc-400">{c.industry}</div>
                    )}
                    {c.address && (
                      <div className="text-xs text-zinc-400">{c.address}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">{c.run?.source}</td>
                  <td className="py-2 pr-3 space-y-0.5">
                    {c.websiteUrl && (
                      <a
                        href={c.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 inline-flex items-center gap-1"
                      >
                        HP <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    {c.contactFormUrl && (
                      <div>
                        <a
                          href={c.contactFormUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 inline-flex items-center gap-1"
                        >
                          フォーム <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-zinc-600">
                    {c.phone && <div>{c.phone}</div>}
                    {c.email && <div className="text-xs">{c.email}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    {c.matchStatus && c.matchStatus !== "new" ? (
                      <Badge variant="warning">既存一致（{c.matchStatus}）</Badge>
                    ) : (
                      <Badge variant="outline">新規</Badge>
                    )}
                  </td>
                  <td className="py-2 pr-3">{statusBadge(c.reviewStatus)}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    {c.reviewStatus !== "ingested" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mr-1"
                          disabled={pending}
                          onClick={() => review(c.id, "approve")}
                          title="承認"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => review(c.id, "reject")}
                          title="却下"
                        >
                          <XCircle className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
