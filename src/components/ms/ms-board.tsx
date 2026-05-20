"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Inbox,
  ArrowUpNarrowWide,
  ArrowDownWideNarrow,
  CalendarCheck,
  User as UserIcon,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MsDealRow, type MsDeal } from "@/components/ms/ms-deal-row";
import { MsNewDealDialog } from "@/components/ms/ms-new-deal-dialog";
import type { PipelineStageRow } from "@/lib/pipeline-stage";

export type MsLeadSource = {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
};
export type MsUser = { id: string; name: string; avatarColor: string | null };

/**
 * ms管理ボード：3つの「商談前」ステージをタブで切り替え、
 * 各タブで該当 pipelineStage の商談一覧をインライン編集する。
 *
 * stages = 全 group のステージ。タブは before グループのみ。
 * 行のステージ変更先には全 group を渡す（before 以外へ移すと一覧から外れる）。
 */
export function MsBoard({
  stages,
  leadSources,
  users,
  canEdit,
}: {
  stages: PipelineStageRow[];
  leadSources: MsLeadSource[];
  users: MsUser[];
  canEdit: boolean;
}) {
  // タブ = before グループのステージのみ。sortOrder 順。最初のタブをデフォルト選択。
  const tabStages = stages.filter((s) => s.group === "before");
  const [active, setActive] = useState<string>(tabStages[0]?.value ?? "");
  const [deals, setDeals] = useState<MsDeal[]>([]);
  const [loading, setLoading] = useState(false);

  // アポ獲得日（Deal.appointmentDate）でのソート方向。デフォルトは降順（新しい順）。
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  // 商談担当者（owner）でのフィルター。"" = すべて。
  const [ownerFilter, setOwnerFilter] = useState<string>("");

  const fetchDeals = useCallback(async (stageValue: string) => {
    if (!stageValue) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/ms?stage=${encodeURIComponent(stageValue)}`);
      const j = await r.json();
      setDeals(j.deals ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDeals(active);
  }, [active, fetchDeals]);

  // 行のステージ変更などで一覧から外れる場合：再フェッチで反映
  const refresh = useCallback(() => fetchDeals(active), [active, fetchDeals]);

  // 行を即時に一覧から取り除く（削除時の楽観的更新）
  const removeDealLocal = useCallback((id: string) => {
    setDeals((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // 現在のタブの商談から、実際に owner が存在する担当者だけをフィルタ候補に出す。
  const ownerOptions = useMemo(() => {
    const seen = new Map<string, MsUser>();
    for (const d of deals) {
      if (d.owner && !seen.has(d.owner.id)) {
        seen.set(d.owner.id, {
          id: d.owner.id,
          name: d.owner.name,
          avatarColor: d.owner.avatarColor,
        });
      }
    }
    return Array.from(seen.values());
  }, [deals]);

  // 担当者フィルター → アポ獲得日ソートを適用した表示用リスト。
  const visibleDeals = useMemo(() => {
    const filtered =
      ownerFilter === ""
        ? deals
        : ownerFilter === "__none__"
          ? deals.filter((d) => !d.ownerUserId)
          : deals.filter((d) => d.ownerUserId === ownerFilter);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // null（未設定）は常に末尾へ
      const at = a.appointmentDate ? new Date(a.appointmentDate).getTime() : null;
      const bt = b.appointmentDate ? new Date(b.appointmentDate).getTime() : null;
      if (at === null && bt === null) return 0;
      if (at === null) return 1;
      if (bt === null) return -1;
      return (at - bt) * dir;
    });
  }, [deals, ownerFilter, sortDir]);

  if (tabStages.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        商談前ステージ（group=&quot;before&quot;）が登録されていません。管理者メニュー →「商談プロセス」から
        「商談予定」「日程調整不可」「催促2回送信済」を追加してください。
      </div>
    );
  }

  return (
    <Tabs value={active} onValueChange={setActive} className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <TabsList className="h-auto flex-wrap">
          {tabStages.map((s) => (
            <TabsTrigger key={s.value} value={s.value} className="text-xs">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {canEdit && (
          <MsNewDealDialog
            stages={stages}
            users={users}
            leadSources={leadSources}
            defaultStage={active}
            onCreated={refresh}
          />
        )}
      </div>

      {/* ツールバー：アポ獲得日ソート + 商談担当者フィルター */}
      <div className="flex items-center gap-3 flex-wrap rounded-lg border border-zinc-200 bg-white px-3 py-2">
        {/* アポ獲得日ソート方向トグル */}
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          title="アポ獲得日の並び順を切り替え"
        >
          <CalendarCheck className="h-3.5 w-3.5 text-emerald-500" />
          アポ獲得日
          {sortDir === "desc" ? (
            <>
              <ArrowDownWideNarrow className="h-3.5 w-3.5" />
              <span className="text-[11px] text-zinc-500">新しい順</span>
            </>
          ) : (
            <>
              <ArrowUpNarrowWide className="h-3.5 w-3.5" />
              <span className="text-[11px] text-zinc-500">古い順</span>
            </>
          )}
        </button>

        {/* 商談担当者フィルター */}
        <div className="inline-flex items-center gap-1.5">
          <UserIcon className="h-3.5 w-3.5 text-sky-500" />
          <span className="text-xs text-zinc-500">担当者:</span>
          <Select value={ownerFilter || "__all__"} onValueChange={(v) => setOwnerFilter(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue placeholder="すべて" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">すべて</SelectItem>
              <SelectItem value="__none__">未設定</SelectItem>
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

        {ownerFilter && ownerOptions.length === 0 && (
          <span className="text-[11px] text-zinc-400">
            （このステージに該当する担当者の商談はありません）
          </span>
        )}
      </div>

      {tabStages.map((s) => (
        <TabsContent key={s.value} value={s.value}>
          <div className="space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                読み込み中…
              </div>
            ) : visibleDeals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
                <Inbox className="h-8 w-8 mb-2" />
                <p className="text-sm">
                  {deals.length === 0
                    ? "このステージの商談はありません"
                    : "条件に一致する商談はありません"}
                </p>
              </div>
            ) : (
              <>
                <p className="text-xs text-zinc-500 px-1">
                  {visibleDeals.length} 件
                  {visibleDeals.length !== deals.length && (
                    <span className="text-zinc-400">（全 {deals.length} 件中）</span>
                  )}
                </p>
                {visibleDeals.map((d) => (
                  <MsDealRow
                    key={d.id}
                    deal={d}
                    stages={stages}
                    leadSources={leadSources}
                    users={users}
                    canEdit={canEdit}
                    onChanged={refresh}
                    onDeleted={() => removeDealLocal(d.id)}
                  />
                ))}
              </>
            )}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
