"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Loader2, Inbox, Building2, Check, ExternalLink } from "lucide-react";
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
import { StaffPicker } from "@/components/pm/staff-picker";

export type SnsPlatform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";

export type PmSnsAccount = {
  id: string;
  platform: SnsPlatform;
  accountId: string | null;
  profileUrl: string | null;
  miyakePcLogin: boolean;
};

export type PmProject = {
  id: string;
  dealId: string;
  dealProductId: string | null;
  companyId: string | null;
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
  storyboardUrl: string | null;
  shootingScheduleUrl: string | null;
  totalPosts: string | null;
  serviceStartMonth: string | null;
  serviceEndMonth: string | null;
  mgmtSheetUrl: string | null;
  deal: {
    id: string;
    title: string;
    company: { id: string; name: string } | null;
  } | null;
  company: { id: string; name: string } | null;
  dealProduct: {
    id: string;
    productName: string;
    planName: string | null;
    yomiStatus: string | null;
    amount: number | null;
  } | null;
  snsAccounts: PmSnsAccount[];
};

function isoDay(s: string | null): string {
  if (!s) return "";
  return s.slice(0, 10);
}

/** date(ISO) -> "YYYY-MM"（提供開始/終了月の表示用） */
function isoMonth(s: string | null): string {
  if (!s) return "";
  return s.slice(0, 7);
}

/** 表示用の会社名：明示FK(company) を優先、無ければ deal.company。 */
function companyName(p: PmProject): string | null {
  return p.company?.name ?? p.deal?.company?.name ?? null;
}

/** リンク用の企業ID：明示FK(company) を優先、無ければ deal.company。 */
function companyId(p: PmProject): string | null {
  return p.companyId ?? p.company?.id ?? p.deal?.company?.id ?? null;
}

/** プロジェクト名リンク先：受注商談詳細のPM管理タブ。dealId が辿れなければ null。 */
function dealHref(p: PmProject): string | null {
  const dealId = p.deal?.id ?? p.dealId ?? null;
  return dealId ? `/deals/${dealId}?tab=pm` : null;
}

export function PmTable({
  canEdit,
  projects,
  onUpdated,
  variant = "video",
}: {
  canEdit: boolean;
  projects: PmProject[];
  onUpdated: (p: PmProject) => void;
  /** video=映像/CATV/アライアンス（撮影日等を表示） / sns=SNS（投稿本数・提供期間・管理シート） */
  variant?: "video" | "sns";
}) {
  const [savingId, setSavingId] = useState<string | null>(null);
  const isSns = variant === "sns";

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
            {isSns ? (
              <>
                <th className="px-3 py-2.5 font-medium">プラン</th>
                <th className="px-3 py-2.5 font-medium">総投稿本数</th>
                <th className="px-3 py-2.5 font-medium">提供開始月</th>
                <th className="px-3 py-2.5 font-medium">提供終了月</th>
                <th className="px-3 py-2.5 font-medium">管理シート</th>
              </>
            ) : (
              <>
                <th className="px-3 py-2.5 font-medium">撮影日</th>
                <th className="px-3 py-2.5 font-medium">仮納品予定日</th>
                <th className="px-3 py-2.5 font-medium">納品予定日</th>
                <th className="px-3 py-2.5 font-medium">ディレクター</th>
                <th className="px-3 py-2.5 font-medium">カメラ</th>
                <th className="px-3 py-2.5 font-medium">編集</th>
              </>
            )}
            <th className="px-3 py-2.5 font-medium min-w-[160px]">備考</th>
            <th className="px-3 py-2.5 font-medium text-center">納品済</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 && (
            <tr>
              <td colSpan={isSns ? 11 : 12} className="py-16 text-center text-zinc-400">
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
              {/* プロジェクト名（＝受注商談名。クリックで商談詳細のPM管理タブを新規タブで開く。編集不可） */}
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {dealHref(p) ? (
                    <Link
                      href={dealHref(p)!}
                      target="_blank"
                      className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
                      title="商談詳細（PM管理タブ）を開く"
                    >
                      {p.projectName}
                      <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                    </Link>
                  ) : (
                    <span className="font-medium">{p.projectName}</span>
                  )}
                  {savingId === p.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400 shrink-0" />
                  )}
                </div>
              </td>

              {/* 企業（クリックで企業ページ /companies/[id] を新規タブで開く） */}
              <td className="px-3 py-2">
                {companyId(p) && companyName(p) ? (
                  <Link
                    href={`/companies/${companyId(p)}`}
                    target="_blank"
                    className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 hover:underline"
                    title="企業ページを開く"
                  >
                    <Building2 className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                    {companyName(p)}
                    <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                  </Link>
                ) : (
                  <span className="text-zinc-400">{companyName(p) ?? "（企業未紐付け）"}</span>
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
                <StaffPicker
                  role="pm"
                  value={p.pmName}
                  canEdit={canEdit}
                  onChange={(v) => patch(p.id, { pmName: v })}
                  width="w-[110px]"
                />
              </td>

              {isSns ? (
                <>
                  {/* プラン（DealProduct.planName が正・読み取り専用） */}
                  <td className="px-3 py-2">
                    {p.dealProduct?.planName ? (
                      <Badge variant="secondary">{p.dealProduct.planName}</Badge>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>

                  {/* 総投稿本数 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Input
                        defaultValue={p.totalPosts ?? ""}
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null;
                          if (v !== p.totalPosts) patch(p.id, { totalPosts: v });
                        }}
                        className="h-8 w-[120px]"
                      />
                    ) : (
                      <span>{p.totalPosts ?? "—"}</span>
                    )}
                  </td>

                  {/* 提供開始月 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Input
                        type="month"
                        defaultValue={isoMonth(p.serviceStartMonth)}
                        onBlur={(e) => {
                          const v = e.target.value || null;
                          const cur = isoMonth(p.serviceStartMonth) || null;
                          if (v !== cur) patch(p.id, { serviceStartMonth: v ? `${v}-01` : null });
                        }}
                        className="h-8 w-[120px]"
                      />
                    ) : (
                      <span className="tabular-nums">{isoMonth(p.serviceStartMonth) || "—"}</span>
                    )}
                  </td>

                  {/* 提供終了月 */}
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <Input
                        type="month"
                        defaultValue={isoMonth(p.serviceEndMonth)}
                        onBlur={(e) => {
                          const v = e.target.value || null;
                          const cur = isoMonth(p.serviceEndMonth) || null;
                          if (v !== cur) patch(p.id, { serviceEndMonth: v ? `${v}-01` : null });
                        }}
                        className="h-8 w-[120px]"
                      />
                    ) : (
                      <span className="tabular-nums">{isoMonth(p.serviceEndMonth) || "—"}</span>
                    )}
                  </td>

                  {/* 管理シートリンク */}
                  <td className="px-3 py-2">
                    {p.mgmtSheetUrl ? (
                      <a
                        href={p.mgmtSheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                      >
                        開く
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </>
              ) : (
                <>
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
                    <StaffPicker
                      role="director"
                      value={p.directorName}
                      canEdit={canEdit}
                      onChange={(v) => patch(p.id, { directorName: v })}
                      width="w-[100px]"
                    />
                  </td>

                  {/* カメラ */}
                  <td className="px-3 py-2">
                    <StaffPicker
                      role="camera"
                      value={p.cameraName}
                      canEdit={canEdit}
                      onChange={(v) => patch(p.id, { cameraName: v })}
                      width="w-[100px]"
                    />
                  </td>

                  {/* 編集 */}
                  <td className="px-3 py-2">
                    <StaffPicker
                      role="editor"
                      value={p.editorName}
                      canEdit={canEdit}
                      onChange={(v) => patch(p.id, { editorName: v })}
                      width="w-[100px]"
                    />
                  </td>
                </>
              )}

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
