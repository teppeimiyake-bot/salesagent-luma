"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Search,
  Building2,
  Check,
  ChevronRight,
  ChevronDown,
  PhoneCall,
} from "lucide-react";
import {
  STAGE_GROUP_LABEL,
  rowToStageDef,
  type PipelineStageRow,
  type StageGroup,
} from "@/lib/pipeline-stage";
import type { MsLeadSource, MsUser } from "@/components/ms/ms-board";

type Company = {
  id: string;
  name: string;
  industry?: string | null;
  websiteUrl?: string | null;
};

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * ms管理タブ専用の新規商談作成ダイアログ。
 * 既存の /api/companies・/api/deals POST を再利用。
 * /deals へ遷移せず /ms にとどまり、作成後は親で再フェッチ（onCreated）。
 */
export function MsNewDealDialog({
  stages,
  users,
  leadSources,
  defaultStage,
  onCreated,
}: {
  stages: PipelineStageRow[];
  users: MsUser[];
  leadSources: MsLeadSource[];
  defaultStage: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [companies, setCompanies] = useState<Company[]>([]);

  // 企業：既存選択 or 新規入力
  const [companyId, setCompanyId] = useState("");
  const [companySearch, setCompanySearch] = useState("");
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyHp, setNewCompanyHp] = useState("");

  const [title, setTitle] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [leadSourceId, setLeadSourceId] = useState("");
  const [stage, setStage] = useState(defaultStage);

  useEffect(() => {
    if (open) setStage(defaultStage);
  }, [open, defaultStage]);

  // 企業マスタ取得
  useEffect(() => {
    if (!open) return;
    fetch("/api/companies")
      .then((r) => r.json())
      .then((j) => setCompanies(j.companies ?? []));
  }, [open]);

  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim().toLowerCase();
    if (!q) return companies.slice(0, 20);
    return companies
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 20);
  }, [companies, companySearch]);

  const selectedCompany = companies.find((c) => c.id === companyId);

  function resetAll() {
    setCompanyId("");
    setCompanySearch("");
    setShowNewCompany(false);
    setNewCompanyName("");
    setNewCompanyHp("");
    setTitle("");
    setOwnerUserId("");
    setLeadSourceId("");
    setStage(defaultStage);
    setError(null);
  }

  async function createNewCompanyInline() {
    if (!newCompanyName.trim()) {
      setError("社名を入力してください");
      return;
    }
    if (!newCompanyHp.trim() || !isValidHttpUrl(newCompanyHp.trim())) {
      setError("HP URL は http:// または https:// で始まる正しいURLを入力してください");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newCompanyName.trim(),
          websiteUrl: newCompanyHp.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.company) {
        setError(j.error ?? "企業作成に失敗しました");
        return;
      }
      setCompanies((prev) => [j.company, ...prev]);
      setCompanyId(j.company.id);
      setShowNewCompany(false);
      setNewCompanyName("");
      setNewCompanyHp("");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyId) {
      setError("企業を選択してください");
      return;
    }
    if (!title.trim()) {
      setError("商談タイトルを入力してください");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          title: title.trim(),
          ownerUserId: ownerUserId || undefined,
          leadSourceId: leadSourceId || undefined,
          pipelineStage: stage,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.deal) {
        setError(j.error ?? "作成に失敗しました");
        return;
      }
      setOpen(false);
      resetAll();
      onCreated();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetAll();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus className="h-4 w-4" />
          新規商談作成
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-md bg-gradient-to-br from-amber-500 to-orange-500 text-white p-1.5">
              <PhoneCall className="h-4 w-4" />
            </span>
            新規商談を作成（ms管理）
          </DialogTitle>
          <DialogDescription>
            アポ獲得直後のリードを登録します。プロダクト構成・詳細は商談詳細画面で追加してください。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {/* 企業 */}
          <section className="space-y-2 rounded-lg border-2 border-amber-200 bg-amber-50/30 p-3">
            <Label className="text-sm font-bold flex items-center gap-1.5">
              <Building2 className="h-4 w-4 text-amber-600" />
              企業 <span className="text-rose-500">*</span>
            </Label>
            {selectedCompany ? (
              <div className="flex items-center justify-between rounded-md bg-white border border-amber-300 px-3 py-2">
                <span className="inline-flex items-center gap-2 min-w-0">
                  <Check className="h-4 w-4 text-amber-600 shrink-0" />
                  <span className="font-bold truncate">{selectedCompany.name}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCompanyId("")}
                  className="text-xs text-zinc-500 hover:text-rose-600"
                >
                  変更
                </Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                  <Input
                    value={companySearch}
                    onChange={(e) => setCompanySearch(e.target.value)}
                    placeholder="企業名で検索"
                    className="pl-9 h-9 text-sm"
                  />
                </div>
                {filteredCompanies.length > 0 && (
                  <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-white divide-y divide-zinc-100">
                    {filteredCompanies.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setCompanyId(c.id);
                          setCompanySearch("");
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-amber-50 flex items-center gap-2"
                      >
                        <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowNewCompany((v) => !v)}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md border-2 border-dashed border-amber-400 text-amber-700 font-bold text-sm hover:bg-amber-100"
                >
                  {showNewCompany ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  ＋ 新規企業を登録
                </button>
                {showNewCompany && (
                  <div className="space-y-2 rounded-md bg-white border border-amber-300 p-3">
                    <div className="space-y-1">
                      <Label className="text-xs">社名 <span className="text-rose-500">*</span></Label>
                      <Input
                        value={newCompanyName}
                        onChange={(e) => setNewCompanyName(e.target.value)}
                        placeholder="例：株式会社サンプル"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">HP URL <span className="text-rose-500">*</span></Label>
                      <Input
                        value={newCompanyHp}
                        onChange={(e) => setNewCompanyHp(e.target.value)}
                        placeholder="https://..."
                        className="h-9"
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={loading || !newCompanyName.trim() || !newCompanyHp.trim()}
                        onClick={createNewCompanyInline}
                      >
                        企業を作成して選択
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>

          {/* 商談タイトル */}
          <div className="space-y-1">
            <Label className="text-sm font-semibold">
              商談タイトル <span className="text-rose-500">*</span>
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：採用動画 初回商談"
              className="h-9"
            />
          </div>

          {/* 主担当 */}
          <div className="space-y-1">
            <Label className="text-sm font-semibold">主担当（自社）</Label>
            <Select value={ownerUserId} onValueChange={setOwnerUserId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="未選択" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
                        style={{ background: u.avatarColor ?? "#6366f1" }}
                      >
                        {u.name.charAt(0)}
                      </span>
                      {u.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* リード獲得経由 */}
          <div className="space-y-1">
            <Label className="text-sm font-semibold">リード獲得経由</Label>
            <Select value={leadSourceId} onValueChange={setLeadSourceId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="未選択" />
              </SelectTrigger>
              <SelectContent>
                {leadSources.map((ls) => (
                  <SelectItem key={ls.id} value={ls.id}>
                    {ls.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 初期ステージ */}
          <div className="space-y-1">
            <Label className="text-sm font-semibold">初期ステージ</Label>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["before", "after", "contract"] as const).map((g: StageGroup) => {
                  const rows = stages.filter((s) => s.group === g && s.active);
                  if (rows.length === 0) return null;
                  return (
                    <div key={g}>
                      <div className="px-2 py-1 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                        {STAGE_GROUP_LABEL[g]}
                      </div>
                      {rows.map((row) => {
                        const s = rowToStageDef(row);
                        return (
                          <SelectItem key={row.id} value={s.value}>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${s.bg} ${s.text}`}
                            >
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

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !companyId || !title.trim()}
            >
              {loading ? "作成中…" : "商談を作成"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
