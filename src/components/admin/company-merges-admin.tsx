"use client";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/ui/company-logo";
import {
  RefreshCw,
  Merge,
  XCircle,
  ExternalLink,
  Briefcase,
  Users,
  Star,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";

type CandidateCompany = {
  id: string;
  name: string;
  industry: string | null;
  websiteUrl: string | null;
  address: string | null;
  ceoName: string | null;
  logoUrl: string | null;
  logoColor: string | null;
  createdAt: string;
  dealCount: number;
  contactCount: number;
  richness: number;
  isSurvivingDefault: boolean;
};

type CandidateGroup = {
  key: string;
  confidence: "high" | "review";
  reason: string;
  companies: CandidateCompany[];
};

type Summary = {
  totalLive: number;
  groupCount: number;
  highCount: number;
  reviewCount: number;
  affectedCompanies: number;
};

type RecentMerge = {
  id: string;
  survivingCompanyId: string;
  mergedCompanyId: string;
  performedAt: string;
};

export function CompanyMergesAdmin() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [groups, setGroups] = useState<CandidateGroup[]>([]);
  const [recent, setRecent] = useState<RecentMerge[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [cRes, mRes] = await Promise.all([
        fetch("/api/admin/company-merges/candidates"),
        fetch("/api/admin/company-merges"),
      ]);
      const cJson = await cRes.json();
      if (!cRes.ok) throw new Error(cJson.error ?? "候補の取得に失敗しました");
      setSummary(cJson.summary);
      setGroups(cJson.groups);
      const mJson = await mRes.json();
      if (mRes.ok) setRecent(mJson.merges ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function executeMerge(group: CandidateGroup, survivingId: string) {
    const mergedIds = group.companies.map((c) => c.id).filter((id) => id !== survivingId);
    const survName = group.companies.find((c) => c.id === survivingId)?.name ?? "";
    if (
      !confirm(
        `「${survName}」に ${mergedIds.length} 社を統合します。\n統合元の商談・連絡先は「${survName}」へ移り、統合元はアーカイブされます（後から復元可）。\n実行しますか？`,
      )
    )
      return;
    start(async () => {
      const r = await fetch("/api/admin/company-merges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survivingCompanyId: survivingId, mergedCompanyIds: mergedIds }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "統合に失敗しました");
        return;
      }
      setNotice(`「${survName}」へ ${j.mergedCount} 社を統合しました。`);
      // 統合したグループを一覧から消す
      setGroups((gs) => gs.filter((g) => g.key !== group.key));
      load();
    });
  }

  function dismissGroup(group: CandidateGroup) {
    const names = group.companies.map((c) => c.name).join(" / ");
    if (!confirm(`これらを「別会社」として今後の候補から除外します。\n${names}\nよろしいですか？`)) return;
    start(async () => {
      const r = await fetch("/api/admin/company-merges/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyIds: group.companies.map((c) => c.id) }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "除外に失敗しました");
        return;
      }
      setNotice("「別会社」として候補から除外しました。");
      setGroups((gs) => gs.filter((g) => g.key !== group.key));
    });
  }

  function undoMerge(id: string) {
    if (!confirm("このマージを復元しますか？\n統合元企業を元に戻し、商談・連絡先も戻します。")) return;
    start(async () => {
      const r = await fetch(`/api/admin/company-merges/${id}/undo`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "復元に失敗しました");
        return;
      }
      setNotice("マージを復元しました。");
      load();
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          {summary && (
            <>
              <Badge variant="secondary">live企業 {summary.totalLive} 社</Badge>
              <Badge className="bg-rose-100 text-rose-700 border-rose-200">
                高確度 {summary.highCount} グループ
              </Badge>
              <Badge className="bg-amber-100 text-amber-700 border-amber-200">
                要確認 {summary.reviewCount} グループ
              </Badge>
            </>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={pending || loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          再読込
        </Button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </div>
      )}
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500 py-10 text-center">候補を検出中…</p>
      ) : groups.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
          <p className="text-sm text-zinc-600">未処理の重複候補はありません。</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <MergeGroupCard
              key={g.key}
              group={g}
              pending={pending}
              onMerge={executeMerge}
              onDismiss={dismissGroup}
            />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="pt-4 border-t border-zinc-200">
          <div className="text-xs uppercase tracking-wider text-zinc-500 mb-2 font-bold">
            直近の統合（復元できます）
          </div>
          <div className="space-y-1.5">
            {recent.slice(0, 10).map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between text-xs text-zinc-600 bg-white border border-zinc-200 rounded px-3 py-2"
              >
                <span className="font-mono">
                  {new Date(m.performedAt).toLocaleString("ja-JP")} ／ merged: {m.mergedCompanyId.slice(0, 8)}… → surviving: {m.survivingCompanyId.slice(0, 8)}…
                </span>
                <Button variant="ghost" size="sm" onClick={() => undoMerge(m.id)} disabled={pending}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  復元
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MergeGroupCard({
  group,
  pending,
  onMerge,
  onDismiss,
}: {
  group: CandidateGroup;
  pending: boolean;
  onMerge: (g: CandidateGroup, survivingId: string) => void;
  onDismiss: (g: CandidateGroup) => void;
}) {
  const defaultSurv = group.companies.find((c) => c.isSurvivingDefault) ?? group.companies[0];
  const [survivingId, setSurvivingId] = useState(defaultSurv.id);

  const high = group.confidence === "high";

  return (
    <div
      className={`rounded-lg border p-4 ${
        high ? "border-rose-200 bg-rose-50/30" : "border-amber-200 bg-amber-50/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        {high ? (
          <Badge className="bg-rose-100 text-rose-700 border-rose-200 inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            高確度
          </Badge>
        ) : (
          <Badge className="bg-amber-100 text-amber-700 border-amber-200 inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            要確認
          </Badge>
        )}
        <span className="text-sm text-zinc-600">{group.reason}</span>
        <span className="text-xs text-zinc-400">／ {group.companies.length} 社</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        {group.companies.map((c) => {
          const selected = survivingId === c.id;
          return (
            <label
              key={c.id}
              className={`relative block rounded-lg border bg-white p-3 cursor-pointer transition-all ${
                selected ? "border-emerald-400 ring-2 ring-emerald-200" : "border-zinc-200 hover:border-zinc-300"
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`surv-${group.key}`}
                  checked={selected}
                  onChange={() => setSurvivingId(c.id)}
                  className="mt-1"
                />
                <CompanyLogo name={c.name} logoUrl={c.logoUrl} logoColor={c.logoColor} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate flex items-center gap-1">
                    {c.name}
                    {c.isSurvivingDefault && (
                      <span title="充実度が最大（推奨）">
                        <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-400" />
                      </span>
                    )}
                  </div>
                  {c.industry && <div className="text-xs text-zinc-500 truncate">{c.industry}</div>}
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-600">
                    <span className="inline-flex items-center gap-0.5">
                      <Briefcase className="h-3 w-3" />
                      {c.dealCount}
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      <Users className="h-3 w-3" />
                      {c.contactCount}
                    </span>
                    <span className="text-zinc-400">充実度 {c.richness}</span>
                  </div>
                  {c.websiteUrl && (
                    <a
                      href={c.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-0.5 text-xs text-sky-600 hover:underline mt-1 truncate max-w-full"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      <span className="truncate">{c.websiteUrl}</span>
                    </a>
                  )}
                  <div className="text-[10px] text-zinc-400 mt-1">
                    登録 {new Date(c.createdAt).toLocaleDateString("ja-JP")}
                  </div>
                </div>
              </div>
              {selected && (
                <div className="absolute top-2 right-2 text-[10px] font-bold text-emerald-600">
                  統合先
                </div>
              )}
            </label>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onDismiss(group)} disabled={pending}>
          <XCircle className="h-4 w-4" />
          別会社（統合しない）
        </Button>
        <Button variant="primary" size="sm" onClick={() => onMerge(group, survivingId)} disabled={pending}>
          <Merge className="h-4 w-4" />
          この内容で統合実行
        </Button>
      </div>
    </div>
  );
}
