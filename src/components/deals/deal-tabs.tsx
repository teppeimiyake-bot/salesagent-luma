"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, FolderKanban } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

/**
 * 商談詳細ページのトップレベルタブ。
 * 「商談」（既存の全セクション）と「PM管理」（受注プロダクトの制作管理）を切り替える。
 *
 * - PM管理タブは受注プロダクトがある商談でのみ表示（hasPm=true）。
 * - URLの ?tab=pm で直接PM管理を開ける（pm-table のプロジェクト名リンク先）。
 * - サーバ側で重い両タブの中身を描画済みのため、children として受け取り display 切替で表示する
 *   （PM管理の編集状態などをタブ往復で失わないよう mount は維持）。
 */
export function DealTabs({
  hasPm,
  pmCount,
  initialTab,
  dealContent,
  pmContent,
}: {
  hasPm: boolean;
  pmCount: number;
  initialTab: "deal" | "pm";
  dealContent: React.ReactNode;
  pmContent: React.ReactNode;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"deal" | "pm">(hasPm ? initialTab : "deal");

  const onChange = (v: string) => {
    const next = v === "pm" && hasPm ? "pm" : "deal";
    setTab(next);
    // URL を ?tab=pm に同期（共有/リロードで同じタブが開くように）。
    const params = new URLSearchParams(searchParams.toString());
    if (next === "pm") params.set("tab", "pm");
    else params.delete("tab");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  // PM管理が無い商談はタブUIを出さず、従来どおり商談セクションをそのまま表示。
  if (!hasPm) {
    return <>{dealContent}</>;
  }

  return (
    <Tabs value={tab} onValueChange={onChange}>
      <div className="px-6 pt-4">
        <TabsList>
          <TabsTrigger value="deal" className="gap-1.5">
            <ClipboardList className="h-4 w-4" />
            商談
          </TabsTrigger>
          <TabsTrigger value="pm" className="gap-1.5">
            <FolderKanban className="h-4 w-4" />
            PM管理
            <Badge variant="secondary" className="ml-1">
              {pmCount}
            </Badge>
          </TabsTrigger>
        </TabsList>
      </div>

      {/* forceMount + display 切替で両タブの状態を保持（Radix の hidden 属性で非表示制御） */}
      <TabsContent value="deal" forceMount className="data-[state=inactive]:hidden mt-0">
        {dealContent}
      </TabsContent>
      <TabsContent value="pm" forceMount className="data-[state=inactive]:hidden mt-0">
        <div className="p-6">{pmContent}</div>
      </TabsContent>
    </Tabs>
  );
}
