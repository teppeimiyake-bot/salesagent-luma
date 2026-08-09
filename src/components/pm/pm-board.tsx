"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Film, Share2, Tv, Handshake } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PmTable, type PmProject } from "@/components/pm/pm-table";
import {
  PRODUCTION_STATUSES,
  PRODUCTION_STATUS_LABEL,
  type ProductionStatus,
} from "@/lib/production";

const SUBTABS = [
  { value: "映像", label: "映像", icon: Film },
  { value: "SNS", label: "SNS", icon: Share2 },
  { value: "CATV", label: "CATV", icon: Tv },
  { value: "アライアンス", label: "アライアンス", icon: Handshake },
] as const;

/**
 * 既定の絞り込み：納品済み以外。
 * 納品済みは件数が積み上がる一方で日々の進行管理では見る必要がないため、
 * 初期表示では隠して「進行中の案件だけが並ぶ」状態にする。
 */
const DEFAULT_STATUSES = PRODUCTION_STATUSES.filter((s) => s !== "DELIVERED");

/**
 * PMボード：映像 / SNS / CATV / アライアンス のサブタブ。
 * 受注企業の ProductionProject 一覧をカテゴリで振り分けて表示する。
 */
export function PmBoard({ canEdit }: { canEdit: boolean }) {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>("映像");
  const [statuses, setStatuses] = useState<Set<ProductionStatus>>(
    () => new Set<ProductionStatus>(DEFAULT_STATUSES),
  );

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/pm");
      const j = await r.json();
      setProjects(j.projects ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // 楽観更新コールバック
  const onUpdated = useCallback((p: PmProject) => {
    setProjects((prev) => prev.map((x) => (x.id === p.id ? p : x)));
  }, []);

  // 未分類は「アライアンス」サブタブに寄せる（映像/SNS/CATV 以外の受注はここで拾う）
  const byCategory = useCallback(
    (cat: string) => {
      if (cat === "アライアンス") {
        return projects.filter((p) => p.category !== "映像" && p.category !== "SNS" && p.category !== "CATV");
      }
      return projects.filter((p) => p.category === cat);
    },
    [projects],
  );

  /** ステータス絞り込みまで通した、実際に表に出る案件 */
  const visible = useCallback(
    (cat: string) => byCategory(cat).filter((p) => statuses.has(p.status)),
    [byCategory, statuses],
  );

  // フィルタチップの件数は「今開いているサブタブの、絞り込み前の母数」で出す。
  // こうしておくと隠れている納品済みが何件あるかが一目で分かる。
  const statusCounts = useMemo(() => {
    const c = {} as Record<ProductionStatus, number>;
    for (const s of PRODUCTION_STATUSES) c[s] = 0;
    for (const p of byCategory(tab)) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [byCategory, tab]);

  const toggleStatus = useCallback((s: ProductionStatus) => {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }, []);

  const allSelected = statuses.size === PRODUCTION_STATUSES.length;
  const isDefault =
    statuses.size === DEFAULT_STATUSES.length && DEFAULT_STATUSES.every((s) => statuses.has(s));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        読み込み中...
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        {SUBTABS.map((s) => {
          const Icon = s.icon;
          return (
            <TabsTrigger key={s.value} value={s.value} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {s.label}
              <Badge variant="secondary" className="ml-1">
                {visible(s.value).length}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>

      {/* ステータス絞り込み */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-medium text-zinc-500">ステータス</span>
        {PRODUCTION_STATUSES.map((s) => {
          const on = statuses.has(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                on
                  ? "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700"
                  : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700"
              }`}
            >
              {PRODUCTION_STATUS_LABEL[s]}
              <span className={`tabular-nums ${on ? "text-indigo-100" : "text-zinc-400"}`}>
                {statusCounts[s]}
              </span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatuses(new Set(PRODUCTION_STATUSES))}
            disabled={allSelected}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            すべて表示
          </button>
          <button
            type="button"
            onClick={() => setStatuses(new Set(DEFAULT_STATUSES))}
            disabled={isDefault}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            納品済みを隠す
          </button>
        </div>
      </div>

      {SUBTABS.map((s) => (
        <TabsContent key={s.value} value={s.value}>
          <PmTable
            canEdit={canEdit}
            projects={visible(s.value)}
            onUpdated={onUpdated}
            variant={s.value === "SNS" ? "sns" : "video"}
            emptyMessage={
              byCategory(s.value).length > 0
                ? "選択中のステータスに該当する案件はありません"
                : "このカテゴリの受注案件はありません"
            }
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
