"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { Loader2, Inbox, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { type ProductionStatus } from "@/lib/production";
import { StaffPicker } from "@/components/pm/staff-picker";
import { UserPicker } from "@/components/pm/user-picker";
import { StatusPill, StatusSelect } from "@/components/pm/status-pill";

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

/** 企業アイコン用の頭文字。法人格を落として先頭1文字を拾う。 */
function initial(name: string): string {
  const stripped = name
    .replace(/(株式会社|有限会社|合同会社|一般財団法人|公益財団法人|一般社団法人|公益社団法人|社会福祉法人|社会医療法人|医療法人|学校法人|㈱|㈲)/g, "")
    .trim();
  return (stripped || name).slice(0, 1);
}

/**
 * 企業名の頭文字から安定した色を選ぶ。
 * ランダムだと再描画で色が変わるので、文字コードのハッシュで固定する。
 */
const AVATAR_TONES = [
  "bg-rose-100 text-rose-700",
  "bg-orange-100 text-orange-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-teal-100 text-teal-700",
  "bg-sky-100 text-sky-700",
  "bg-indigo-100 text-indigo-700",
  "bg-violet-100 text-violet-700",
  "bg-fuchsia-100 text-fuchsia-700",
];
function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 9973;
  return AVATAR_TONES[h % AVATAR_TONES.length];
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
  emptyMessage = "このカテゴリの受注案件はありません",
}: {
  canEdit: boolean;
  projects: PmProject[];
  onUpdated: (p: PmProject) => void;
  /** video=映像/CATV/アライアンス（撮影日等を表示） / sns=SNS（投稿本数・提供期間・管理シート） */
  variant?: "video" | "sns";
  /** 0件のときの文言。絞り込みで0件になった場合と元から0件の場合を呼び出し側で出し分ける。 */
  emptyMessage?: string;
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
    <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.06)]">
      <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200/80 bg-zinc-50/70 text-left text-[11px] uppercase tracking-wider text-zinc-400">
            <th className="whitespace-nowrap px-4 py-3 font-semibold min-w-[220px]">プロジェクト名</th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold min-w-[230px]">企業</th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold">ステータス</th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold">PM担当</th>
            {isSns ? (
              <>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">プラン</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">総投稿本数</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">提供開始月</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">提供終了月</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">管理シート</th>
              </>
            ) : (
              <>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">撮影日</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">納品予定日</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">カメラ</th>
                <th className="whitespace-nowrap px-4 py-3 font-semibold">編集</th>
              </>
            )}
            <th className="whitespace-nowrap px-4 py-3 font-semibold min-w-[140px]">備考</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 && (
            <tr>
              <td colSpan={10} className="py-16 text-center text-zinc-400">
                <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
                {emptyMessage}
              </td>
            </tr>
          )}
          {projects.map((p) => (
            <tr
              key={p.id}
              className="group border-b border-zinc-100 last:border-0 align-middle transition-colors hover:bg-zinc-50/70"
            >
              {/* プロジェクト名（＝受注商談名。クリックで商談詳細のPM管理タブを新規タブで開く。編集不可） */}
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  {dealHref(p) ? (
                    <Link
                      href={dealHref(p)!}
                      target="_blank"
                      className="inline-flex items-center gap-1 font-medium text-zinc-900 decoration-zinc-300 underline-offset-4 hover:underline"
                      title="商談詳細（PM管理タブ）を開く"
                    >
                      {p.projectName}
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100" />
                    </Link>
                  ) : (
                    <span className="font-medium text-zinc-900">{p.projectName}</span>
                  )}
                  {savingId === p.id && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400 shrink-0" />
                  )}
                </div>
              </td>

              {/* 企業（クリックで企業ページ /companies/[id] を新規タブで開く） */}
              <td className="px-4 py-3">
                {companyId(p) && companyName(p) ? (
                  <Link
                    href={`/companies/${companyId(p)}`}
                    target="_blank"
                    className="inline-flex items-center gap-2 text-zinc-700 decoration-zinc-300 underline-offset-4 hover:text-zinc-900 hover:underline"
                    title="企業ページを開く"
                  >
                    <span
                      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${avatarTone(companyName(p)!)}`}
                      aria-hidden
                    >
                      {initial(companyName(p)!)}
                    </span>
                    {companyName(p)}
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-zinc-400 opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                ) : (
                  <span className="text-zinc-400">{companyName(p) ?? "（企業未紐付け）"}</span>
                )}
              </td>

              {/* ステータス */}
              <td className="px-4 py-3">
                {canEdit ? (
                  <StatusSelect
                    status={p.status}
                    category={p.category}
                    onChange={(v) => patch(p.id, { status: v })}
                  />
                ) : (
                  <StatusPill status={p.status} />
                )}
              </td>

              {/* PM担当（このツールの登録メンバーから選択） */}
              <td className="px-4 py-3">
                <UserPicker
                  value={p.pmName}
                  canEdit={canEdit}
                  onChange={(v) => patch(p.id, { pmName: v })}
                  width="w-[110px]"
                />
              </td>

              {isSns ? (
                <>
                  {/* プラン（DealProduct.planName が正・読み取り専用） */}
                  <td className="px-4 py-3">
                    {p.dealProduct?.planName ? (
                      <Badge variant="secondary" className="whitespace-nowrap">{p.dealProduct.planName}</Badge>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>

                  {/* 総投稿本数 */}
                  <td className="px-4 py-3">
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
                      <span className="whitespace-nowrap">{p.totalPosts ?? "—"}</span>
                    )}
                  </td>

                  {/* 提供開始月 */}
                  <td className="px-4 py-3">
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
                      <span className="whitespace-nowrap tabular-nums">{isoMonth(p.serviceStartMonth) || "—"}</span>
                    )}
                  </td>

                  {/* 提供終了月 */}
                  <td className="px-4 py-3">
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
                      <span className="whitespace-nowrap tabular-nums">{isoMonth(p.serviceEndMonth) || "—"}</span>
                    )}
                  </td>

                  {/* 管理シートリンク */}
                  <td className="px-4 py-3">
                    {p.mgmtSheetUrl ? (
                      <a
                        href={p.mgmtSheetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
                      >
                        開く
                        <ArrowUpRight className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                </>
              ) : (
                <>
                  {/* 撮影日 */}
                  <td className="px-4 py-3">
                    {canEdit ? (
                      <DateInput
                        value={isoDay(p.shootDate)}
                        onChange={(v) => patch(p.id, { shootDate: v || null })}
                        className="scale-90 origin-left"
                      />
                    ) : (
                      <span className="whitespace-nowrap tabular-nums">{isoDay(p.shootDate) || "—"}</span>
                    )}
                  </td>

                  {/* 納品予定日 */}
                  <td className="px-4 py-3">
                    {canEdit ? (
                      <DateInput
                        value={isoDay(p.deliveryDate)}
                        onChange={(v) => patch(p.id, { deliveryDate: v || null })}
                        className="scale-90 origin-left"
                      />
                    ) : (
                      <span className="whitespace-nowrap tabular-nums">{isoDay(p.deliveryDate) || "—"}</span>
                    )}
                  </td>

                  {/* カメラ */}
                  <td className="px-4 py-3">
                    <StaffPicker
                      role="camera"
                      value={p.cameraName}
                      canEdit={canEdit}
                      onChange={(v) => patch(p.id, { cameraName: v })}
                      width="w-[100px]"
                    />
                  </td>

                  {/* 編集 */}
                  <td className="px-4 py-3">
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
              <td className="px-4 py-3">
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
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
