"use client";

import { useCallback, useState } from "react";
import { Loader2, Inbox, Building2, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PRODUCTION_STATUSES,
  PRODUCTION_STATUS_LABEL,
  productionStatusVariant,
  type ProductionStatus,
} from "@/lib/production";

export type PmProject = {
  id: string;
  dealId: string;
  dealProductId: string | null;
  category: string | null;
  projectName: string;
  status: ProductionStatus;
  pmName: string | null;
  directorName: string | null;
  cameraName: string | null;
  editorName: string | null;
  shootDate: string | null;
  deliveryDate: string | null;
  provisionalDeliveryDate: string | null;
  delivered: boolean;
  note: string | null;
  deal: {
    id: string;
    title: string;
    company: { id: string; name: string } | null;
  } | null;
  dealProduct: {
    id: string;
    productName: string;
    planName: string | null;
    yomiStatus: string | null;
    amount: number | null;
  } | null;
};

function isoDay(s: string | null): string {
  if (!s) return "";
  return s.slice(0, 10);
}

export function PmTable({
  canEdit,
  projects,
  onUpdated,
}: {
  canEdit: boolean;
  projects: PmProject[];
  onUpdated: (p: PmProject) => void;
}) {
  const [savingId, setSavingId] = useState<string | null>(null);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      setSavingId(id);
      try {
        const res = await fetch(`/api/pm/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const j = await res.json();
          if (j.project) onUpdated(j.project);
        }
      } finally {
        setSavingId(null);
      }
    },
    [onUpdated],
  );

  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs text-zinc-500">
            <th className="px-3 py-2.5 font-medium min-w-[200px]">プロジェクト名</th>
            <th className="px-3 py-2.5 font-medium min-w-[140px]">企業</th>
            <th className="px-3 py-2.5 font-medium">ステータス</th>
            <th className="px-3 py-2.5 font-medium">PM担当</th>
            <th className="px-3 py-2.5 font-medium">撮影日</th>
            <th className="px-3 py-2.5 font-medium">仮納品予定日</th>
            <th className="px-3 py-2.5 font-medium">納品予定日</th>
            <th className="px-3 py-2.5 font-medium">ディレクター</th>
            <th className="px-3 py-2.5 font-medium">カメラ</th>
            <th className="px-3 py-2.5 font-medium">編集</th>
            <th className="px-3 py-2.5 font-medium min-w-[160px]">備考</th>
            <th className="px-3 py-2.5 font-medium text-center">納品済</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 && (
            <tr>
              <td colSpan={12} className="py-16 text-center text-zinc-400">
                <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
                このカテゴリの受注案件はありません
              </td>
            </tr>
          )}
          {projects.map((p) => (
            <tr
              key={p.id}
              className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50/60 align-middle"
            >
              {/* プロジェクト名 */}
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {canEdit ? (
                    <Input
                      defaultValue={p.projectName}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== p.projectName) patch(p.id, { projectName: v });
                      }}
                      className="h-8 w-[200px]"
                    />
                  ) : (
                    <span className="font-medium">{p.projectName}</span>
                  )}
                  {savingId === p.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400 shrink-0" />
                  )}
                </div>
              </td>

              {/* 企業 */}
              <td className="px-3 py-2">
                {p.deal?.company ? (
                  <span className="inline-flex items-center gap-1 text-zinc-700">
                    <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    {p.deal.company.name}
                  </span>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>

              {/* ステータス */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Select value={p.status} onValueChange={(v) => patch(p.id, { status: v })}>
                    <SelectTrigger className="h-8 w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRODUCTION_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {PRODUCTION_STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant={productionStatusVariant(p.status)}>
                    {PRODUCTION_STATUS_LABEL[p.status]}
                  </Badge>
                )}
              </td>

              {/* PM担当 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Input
                    defaultValue={p.pmName ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== p.pmName) patch(p.id, { pmName: v });
                    }}
                    className="h-8 w-[100px]"
                  />
                ) : (
                  <span>{p.pmName ?? "—"}</span>
                )}
              </td>

              {/* 撮影日 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <DateInput
                    value={isoDay(p.shootDate)}
                    onChange={(v) => patch(p.id, { shootDate: v || null })}
                    className="scale-90 origin-left"
                  />
                ) : (
                  <span className="tabular-nums">{isoDay(p.shootDate) || "—"}</span>
                )}
              </td>

              {/* 仮納品予定日 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <DateInput
                    value={isoDay(p.provisionalDeliveryDate)}
                    onChange={(v) => patch(p.id, { provisionalDeliveryDate: v || null })}
                    className="scale-90 origin-left"
                  />
                ) : (
                  <span className="tabular-nums">
                    {isoDay(p.provisionalDeliveryDate) || "—"}
                  </span>
                )}
              </td>

              {/* 納品予定日 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <DateInput
                    value={isoDay(p.deliveryDate)}
                    onChange={(v) => patch(p.id, { deliveryDate: v || null })}
                    className="scale-90 origin-left"
                  />
                ) : (
                  <span className="tabular-nums">{isoDay(p.deliveryDate) || "—"}</span>
                )}
              </td>

              {/* ディレクター */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Input
                    defaultValue={p.directorName ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== p.directorName) patch(p.id, { directorName: v });
                    }}
                    className="h-8 w-[90px]"
                  />
                ) : (
                  <span>{p.directorName ?? "—"}</span>
                )}
              </td>

              {/* カメラ */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Input
                    defaultValue={p.cameraName ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== p.cameraName) patch(p.id, { cameraName: v });
                    }}
                    className="h-8 w-[90px]"
                  />
                ) : (
                  <span>{p.cameraName ?? "—"}</span>
                )}
              </td>

              {/* 編集 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Input
                    defaultValue={p.editorName ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== p.editorName) patch(p.id, { editorName: v });
                    }}
                    className="h-8 w-[90px]"
                  />
                ) : (
                  <span>{p.editorName ?? "—"}</span>
                )}
              </td>

              {/* 備考 */}
              <td className="px-3 py-2">
                {canEdit ? (
                  <Input
                    defaultValue={p.note ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== p.note) patch(p.id, { note: v });
                    }}
                    className="h-8 w-[160px]"
                  />
                ) : (
                  <span className="text-zinc-600">{p.note ?? "—"}</span>
                )}
              </td>

              {/* 納品済 */}
              <td className="px-3 py-2 text-center">
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => patch(p.id, { delivered: !p.delivered })}
                  className={`inline-flex h-6 w-6 items-center justify-center rounded border transition-colors ${
                    p.delivered
                      ? "bg-emerald-500 border-emerald-500 text-white"
                      : "bg-white border-zinc-300 text-transparent hover:border-zinc-400"
                  } ${canEdit ? "cursor-pointer" : "cursor-default opacity-70"}`}
                  aria-pressed={p.delivered}
                  title={p.delivered ? "納品済み" : "未納品"}
                >
                  <Check className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
