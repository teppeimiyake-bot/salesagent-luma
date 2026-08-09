"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Film, Share2, Tv, Handshake } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PmTable, type PmProject } from "@/components/pm/pm-table";
import {
  PRODUCTION_STATUS_LABEL,
  PRODUCTION_STATUS_STYLE,
  defaultHiddenStatus,
  statusesForCategory,
  type ProductionStatus,
} from "@/lib/production";

const SUBTABS = [
  { value: "映像", label: "映像", icon: Film },
  { value: "SNS", label: "SNS", icon: Share2 },
  { value: "CATV", label: "CATV", icon: Tv },
  { value: "アライアンス", label: "アライアンス", icon: Handshake },
] as const;

/**
 * 既定の絞り込み：終わった案件（映像系＝納品済み / SNS＝解約）以外。
 * 終わった案件は件数が積み上がる一方で日々の進行管理では見る必要がないため、
 * 初期表示では隠して「進行中の案件だけが並ぶ」状態にする。
 */
function defaultStatuses(category: string): ProductionStatus[] {
  const hidden = defaultHiddenStatus(category);
  return statusesForCategory(category).filter((s) => s !== hidden);
}

/**
 * PMボード：映像 / SNS / CATV / アライアンス のサブタブ。
 * 受注企業の ProductionProject 一覧をカテゴリで振り分けて表示する。
 */
export function PmBoard({ canEdit }: { canEdit: boolean }) {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>("映像");
  // 選択中のステータスはサブタブごとに持つ（SNSだけ契約中/解約の体系で別物のため）
  const [statusesByTab, setStatusesByTab] = useState<Record<string, ProductionStatus[]>>(() =>
    Object.fromEntries(SUBTABS.map((s) => [s.value, defaultStatuses(s.value)])),
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
    (cat: string) => {
      const selected = statusesByTab[cat] ?? [];
      return byCategory(cat).filter((p) => selected.includes(p.status));
    },
    [byCategory, statusesByTab],
  );

  // フィルタチップの件数は「今開いているサブタブの、絞り込み前の母数」で出す。
  // こうしておくと隠れている納品済み／解約が何件あるかが一目で分かる。
  const statusCounts = useMemo(() => {
    const c: Partial<Record<ProductionStatus, number>> = {};
    for (const s of statusesForCategory(tab)) c[s] = 0;
    for (const p of byCategory(tab)) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [byCategory, tab]);

  const toggleStatus = useCallback(
    (s: ProductionStatus) => {
      setStatusesByTab((prev) => {
        const cur = prev[tab] ?? [];
        const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
        return { ...prev, [tab]: next };
      });
    },
    [tab],
  );

  const tabStatuses = statusesForCategory(tab);
  const selected = statusesByTab[tab] ?? [];
  const allSelected = selected.length === tabStatuses.length;
  const tabDefaults = defaultStatuses(tab);
  const isDefault =
    selected.length === tabDefaults.length && tabDefaults.every((s) => selected.includes(s));

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
        {tabStatuses.map((s) => {
          const on = selected.includes(s);
          const style = PRODUCTION_STATUS_STYLE[s];
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleStatus(s)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-all ${
                on
                  ? style.chip
                  : "bg-white text-zinc-400 ring-zinc-200 hover:text-zinc-600 hover:ring-zinc-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${
                  on ? style.dot : "bg-zinc-300"
                }`}
              />
              {PRODUCTION_STATUS_LABEL[s]}
              <span className={`tabular-nums ${on ? "opacity-60" : "text-zinc-300"}`}>
                {statusCounts[s] ?? 0}
              </span>
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatusesByTab((prev) => ({ ...prev, [tab]: [...tabStatuses] }))}
            disabled={allSelected}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            すべて表示
          </button>
          <button
            type="button"
            onClick={() => setStatusesByTab((prev) => ({ ...prev, [tab]: tabDefaults }))}
            disabled={isDefault}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {PRODUCTION_STATUS_LABEL[defaultHiddenStatus(tab)]}を隠す
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
