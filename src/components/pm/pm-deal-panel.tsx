"use client";

import { useMemo, useState } from "react";
import { Film, Share2, Tv, Handshake, Inbox } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PmDetail, type PmDetailData } from "@/components/pm/pm-detail";

const CATEGORY_META: { value: string; label: string; icon: React.ElementType }[] = [
  { value: "映像", label: "映像", icon: Film },
  { value: "SNS", label: "SNS", icon: Share2 },
  { value: "CATV", label: "CATV", icon: Tv },
  { value: "アライアンス", label: "アライアンス", icon: Handshake },
];

const KNOWN_CATEGORIES = new Set(["映像", "SNS", "CATV"]);

/** category を正規化：映像/SNS/CATV 以外（null含む）は「アライアンス」に寄せる。 */
function normalizeCategory(c: string | null): string {
  return c && KNOWN_CATEGORIES.has(c) ? c : "アライアンス";
}

/**
 * 商談詳細ページ「PM管理」タブの中身。
 * その商談の受注プロダクト（ProductionProject）をカテゴリごとのサブタブに分け、
 * 各プロジェクトの PmDetail（受注後の制作管理）を表示する。
 */
export function PmDealPanel({ projects }: { projects: PmDetailData[] }) {
  // カテゴリごとにグルーピング
  const byCategory = useMemo(() => {
    const m: Record<string, PmDetailData[]> = {};
    for (const p of projects) {
      const key = normalizeCategory(p.project.category);
      (m[key] ??= []).push(p);
    }
    return m;
  }, [projects]);

  // 実在するカテゴリのみサブタブ化（受注プロダクトがあるカテゴリだけ）
  const activeTabs = useMemo(
    () => CATEGORY_META.filter((c) => (byCategory[c.value]?.length ?? 0) > 0),
    [byCategory],
  );

  const [tab, setTab] = useState<string>(activeTabs[0]?.value ?? "映像");

  if (projects.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center text-zinc-400">
        <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
        この商談には受注プロダクトがありません。
      </div>
    );
  }

  // 単一カテゴリならサブタブを出さずそのまま並べる
  if (activeTabs.length <= 1) {
    const list = byCategory[activeTabs[0]?.value ?? "アライアンス"] ?? projects;
    return (
      <div className="space-y-8">
        {list.map((p) => (
          <PmDetail key={p.project.id} data={p} />
        ))}
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="mb-4">
        {activeTabs.map((c) => {
          const Icon = c.icon;
          const n = byCategory[c.value]?.length ?? 0;
          return (
            <TabsTrigger key={c.value} value={c.value} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {c.label}
              <Badge variant="secondary" className="ml-1">
                {n}
              </Badge>
            </TabsTrigger>
          );
        })}
      </TabsList>

      {activeTabs.map((c) => (
        <TabsContent key={c.value} value={c.value}>
          <div className="space-y-8">
            {(byCategory[c.value] ?? []).map((p) => (
              <PmDetail key={p.project.id} data={p} />
            ))}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
