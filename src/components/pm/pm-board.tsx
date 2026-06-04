"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Film, Share2, Tv, Handshake } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PmTable, type PmProject } from "@/components/pm/pm-table";

const SUBTABS = [
  { value: "映像", label: "映像", icon: Film },
  { value: "SNS", label: "SNS", icon: Share2 },
  { value: "CATV", label: "CATV", icon: Tv },
  { value: "アライアンス", label: "アライアンス", icon: Handshake },
] as const;

/**
 * PMボード：映像 / SNS / CATV / アライアンス のサブタブ。
 * 受注企業の ProductionProject 一覧をカテゴリで振り分けて表示する。
 */
export function PmBoard({ canEdit }: { canEdit: boolean }) {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>("映像");

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

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) {
      const key = p.category ?? "(未分類)";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [projects]);

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
          const n =
            s.value === "アライアンス"
              ? byCategory("アライアンス").length
              : counts[s.value] ?? 0;
          return (
            <TabsTrigger key={s.value} value={s.value} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {s.label}
              <Badge variant="secondary" className="ml-1">
                {n}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>

      {SUBTABS.map((s) => (
        <TabsContent key={s.value} value={s.value}>
          <PmTable canEdit={canEdit} projects={byCategory(s.value)} onUpdated={onUpdated} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
