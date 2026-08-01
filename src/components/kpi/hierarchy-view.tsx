"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ReferenceLine,
} from "recharts";
import {
  Crown,
  CalendarRange,
  CalendarDays,
  TrendingUp,
  Trophy,
  Target,
  Building2,
  Package,
  Inbox,
} from "lucide-react";
import { formatJPY } from "@/lib/utils";
import { getFiscalMonthIndex, getFiscalYear } from "@/lib/config";
import type { WonDealCard } from "@/lib/queries";
import {
  WonDealProductEditor,
  type KpiProductMaster,
} from "@/components/kpi/won-deal-product-editor";
import { WonDealContractDateEditor } from "@/components/kpi/won-deal-contract-date-editor";

type Progress = {
  targetAmount: number;
  wonAmount: number;
  rate: number;
  period: string;
};

type Hierarchy = {
  year: Progress;
  quarters: Progress[];
  months: Progress[];
  monthLabels: string[];
  remainingMonths: number;
};

export function KpiHierarchyView({
  data,
  year, // 会計年度（FY2026 → 2026）
  fiscalStartMonth, // 会計年度の開始月（Luma=6 / リージー=1）
  isOrgView,
  monthlyWonDeals,
  productMasters = [],
  canEditProducts = false,
}: {
  data: Hierarchy;
  year: number;
  fiscalStartMonth: number;
  isOrgView: boolean;
  /** period(YYYY-MM) → その月の受注案件カード一覧（月クリックのドリルダウン用） */
  monthlyWonDeals?: Record<string, WonDealCard[]>;
  /** 受注企業カード上のプロダクト追加/変更で使う商材マスタ（カテゴリ＋プラン） */
  productMasters?: KpiProductMaster[];
  /** プロダクト編集の可否（user/admin のみ true） */
  canEditProducts?: boolean;
}) {
  // 月クリックで開くドリルダウン（選択中の月インデックス。null=閉）
  const [openMonthIdx, setOpenMonthIdx] = useState<number | null>(null);
  const selectedMonth = openMonthIdx != null ? data.months[openMonthIdx] : null;
  const selectedLabel = openMonthIdx != null ? data.monthLabels[openMonthIdx] : "";
  const selectedCards: WonDealCard[] =
    selectedMonth && monthlyWonDeals ? (monthlyWonDeals[selectedMonth.period] ?? []) : [];

  const yearRate = Math.min(100, data.year.rate * 100);
  const remaining = Math.max(0, data.year.targetAmount - data.year.wonAmount);
  const labels = data.monthLabels;
  const now = new Date();
  const isCurrentFy = year === getFiscalYear(fiscalStartMonth, now);
  const currentMonthIdx = isCurrentFy ? getFiscalMonthIndex(fiscalStartMonth, now) : -1;
  const currentMonthLabel = currentMonthIdx >= 0 ? labels[currentMonthIdx] : null;

  // 月次グラフ用データ：目標 vs 実績の累積も併記
  let cumWon = 0;
  let cumTarget = 0;
  const chartData = data.months.map((m, idx) => {
    cumWon += m.wonAmount;
    cumTarget += m.targetAmount;
    return {
      label: labels[idx],
      target: Math.round(m.targetAmount / 10000),
      won: Math.round(m.wonAmount / 10000),
      cumTarget: Math.round(cumTarget / 10000),
      cumWon: Math.round(cumWon / 10000),
    };
  });

  return (
    <div className="space-y-5">
      {/* ============ 集計基準ノート ============ */}
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-2.5 text-xs text-emerald-800 flex items-center gap-2 flex-wrap">
        <Badge variant="success" className="text-[10px]">
          受注計上日ベース
        </Badge>
        <span>
          受注実績は <strong className="font-bold">Deal.受注計上日</strong> が指定期間に入っており、
          かつプロダクトのヨミが <strong className="font-bold">「受注」</strong> のものを集計します。
        </span>
        <span className="text-emerald-700/70">
          （受注に変更すると本日付で自動セット／後から手動編集可）
        </span>
      </div>

      {/* ============ 年間KGI ============ */}
      <Card className="border-rose-200 bg-gradient-to-br from-rose-50/40 via-white to-pink-50/30 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base flex-wrap">
            <div className="rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 text-white p-1.5 shadow-sm">
              <Crown className="h-4 w-4" />
            </div>
            年間KGI
            <Badge variant="danger">FY{year}</Badge>
            <Badge variant="success" className="text-[10px]">受注計上日ベース</Badge>
            <Badge variant={isOrgView ? "info" : "secondary"} className="ml-auto">
              {isOrgView ? "組織全体" : "個人"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Stat
              icon={Target}
              label="年間目標"
              value={formatJPY(data.year.targetAmount)}
              accent="rose"
            />
            <Stat
              icon={Trophy}
              label="達成額（受注計上日ベース）"
              value={formatJPY(data.year.wonAmount)}
              accent="emerald"
              highlight
            />
            <Stat
              icon={TrendingUp}
              label="達成率"
              value={`${yearRate.toFixed(1)}%`}
              accent="indigo"
            />
            <Stat
              icon={CalendarRange}
              label="残り月数"
              value={`${data.remainingMonths} ヶ月`}
              accent="amber"
              sub={`残り目標 ${formatJPY(remaining)}`}
            />
          </div>
          <div className="mt-4 space-y-1">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-zinc-600">{formatJPY(data.year.wonAmount)}</span>
              <span className="text-zinc-500">{formatJPY(data.year.targetAmount)}</span>
            </div>
            <Progress value={yearRate} className="h-3" />
          </div>
        </CardContent>
      </Card>

      {/* ============ 四半期KPI ============ */}
      <Card className="border-orange-200 bg-white shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
              <CalendarRange className="h-4 w-4" />
            </div>
            四半期KPI
            <span className="text-xs text-zinc-500 ml-2">FY{year}（Q1〜Q4）</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {data.quarters.map((q, idx) => {
              const rate = Math.min(100, q.rate * 100);
              const accent = pickAccent(rate);
              return (
                <div
                  key={q.period}
                  className={`rounded-xl border p-3 ${accent.border} ${accent.bg}`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-zinc-700">Q{idx + 1}</p>
                    <Badge variant={accent.badge} className="text-[10px]">
                      {rate.toFixed(0)}%
                    </Badge>
                  </div>
                  <p className="mt-1 text-lg font-bold tabular-nums">
                    {formatJPY(q.wonAmount)}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    / {formatJPY(q.targetAmount)}
                  </p>
                  <Progress value={rate} className="mt-2 h-1.5" />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ============ 月次KPI ============ */}
      <Card className="border-sky-200 bg-white shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="rounded-lg bg-gradient-to-br from-sky-500 to-cyan-500 text-white p-1.5 shadow-sm">
              <CalendarDays className="h-4 w-4" />
            </div>
            月次KPI（推移）
            <span className="text-xs text-zinc-500 ml-2">FY{year}（{labels[0]}〜{labels[11]}）</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* 推移グラフ */}
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} unit="万" />
                <Tooltip
                  formatter={(value: number, name: string) => {
                    const v = `${value.toLocaleString()}万円`;
                    return [v, name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="target" fill="#cbd5e1" name="月次目標" />
                <Bar dataKey="won" fill="#10b981" name="月次受注" />
                <Line
                  type="monotone"
                  dataKey="cumWon"
                  stroke="#6366f1"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  name="累計受注"
                />
                <Line
                  type="monotone"
                  dataKey="cumTarget"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={false}
                  name="累計目標"
                />
                {currentMonthLabel && (
                  <ReferenceLine
                    x={currentMonthLabel}
                    stroke="#6366f1"
                    strokeDasharray="3 3"
                    label={{ value: "今月", fill: "#6366f1", fontSize: 10, position: "top" }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* 月次セルグリッド（クリックで受注企業カードを表示） */}
          <p className="mt-5 mb-2 text-[11px] text-zinc-500">
            月をクリックすると、その月に受注した企業と商材を確認できます。
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
            {data.months.map((m, idx) => {
              const rate = Math.min(100, m.rate * 100);
              const accent = pickAccent(rate);
              const isCurrent = idx === currentMonthIdx;
              const cardCount = monthlyWonDeals?.[m.period]?.length ?? 0;
              return (
                <button
                  type="button"
                  key={m.period}
                  onClick={() => setOpenMonthIdx(idx)}
                  className={`text-left rounded-lg border p-2.5 transition hover:shadow-md hover:ring-2 hover:ring-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${accent.border} ${accent.bg} ${
                    isCurrent ? "ring-2 ring-emerald-400" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-zinc-700">{labels[idx]}</p>
                    {m.targetAmount > 0 && (
                      <Badge variant={accent.badge} className="text-[9px] px-1.5">
                        {rate.toFixed(0)}%
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm font-bold tabular-nums">
                    {m.wonAmount === 0 && m.targetAmount === 0 ? "—" : formatJPY(m.wonAmount)}
                  </p>
                  {m.targetAmount > 0 && (
                    <p className="text-[10px] text-zinc-400">
                      / {formatJPY(m.targetAmount)}
                    </p>
                  )}
                  <p className="mt-1 text-[10px] text-sky-600 font-medium">
                    {cardCount > 0 ? `受注 ${cardCount}件 ›` : "受注なし"}
                  </p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ============ 月別 受注企業カード（ドリルダウン） ============ */}
      <Dialog
        open={openMonthIdx != null}
        onOpenChange={(o) => {
          if (!o) setOpenMonthIdx(null);
        }}
      >
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-sky-500" />
              {`FY${year} ${selectedLabel}`}の受注
            </DialogTitle>
            <DialogDescription>
              {selectedMonth
                ? `受注 ${selectedCards.length}件 ／ 受注金額 ${formatJPY(selectedMonth.wonAmount)}（受注計上日ベース）`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {selectedCards.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-zinc-400">
              <Inbox className="h-8 w-8" />
              <p className="text-sm">この月に受注した案件はありません。</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {selectedCards.map((c) => (
                <WonCardItem
                  key={c.dealId}
                  card={c}
                  productMasters={productMasters}
                  canEditProducts={canEditProducts}
                />
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 受注企業カード 1件。
 * 表示（企業名・受注金額・受注商材ピル）＋ プロダクトのインライン編集を内包。
 * 編集中はローカル受注金額を楽観表示し、確定後は router.refresh() でサーバー集計に同期される。
 */
function WonCardItem({
  card,
  productMasters,
  canEditProducts,
}: {
  card: WonDealCard;
  productMasters: KpiProductMaster[];
  canEditProducts: boolean;
}) {
  // サーバー値（card.wonAmount）を初期値に、編集中はローカル楽観値を表示
  const [localWon, setLocalWon] = useState<number | null>(null);
  // card が差し替わった（再フェッチ後）らローカル楽観値をリセット
  useEffect(() => {
    setLocalWon(null);
  }, [card]);
  const displayWon = localWon ?? card.wonAmount;

  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="rounded-lg bg-emerald-100 text-emerald-700 p-1.5 shrink-0">
            <Building2 className="h-4 w-4" />
          </div>
          <p className="font-semibold text-sm text-zinc-800 truncate">{card.companyName}</p>
        </div>
        <p className="text-sm font-bold tabular-nums text-emerald-700 shrink-0">
          {formatJPY(displayWon)}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {card.products.length === 0 ? (
          <span className="text-[11px] text-zinc-400">商材情報なし</span>
        ) : (
          card.products.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-800"
            >
              <Package className="h-3 w-3" />
              {p.name}
              {p.amount != null && <span className="text-sky-500">（{formatJPY(p.amount)}）</span>}
            </span>
          ))
        )}
      </div>

      {/* 受注計上日の編集（KPIの月度振り分けに直結）。
          編集権が無くても閲覧用に計上日は表示する（canEdit=false で読み取り専用表示）。 */}
      <WonDealContractDateEditor
        dealId={card.dealId}
        contractDate={card.contractDate}
        bookedDate={card.bookedDate}
        bookedDateSource={card.bookedDateSource}
        canEdit={canEditProducts}
      />

      {canEditProducts && (
        <WonDealProductEditor
          dealId={card.dealId}
          initial={card.editableProducts}
          products={productMasters}
          canEdit={canEditProducts}
          onLocalWonAmountChange={setLocalWon}
        />
      )}
    </li>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  highlight,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  accent: "rose" | "emerald" | "indigo" | "amber";
  highlight?: boolean;
}) {
  const colorMap = {
    rose: "text-rose-700 bg-rose-100",
    emerald: "text-emerald-700 bg-emerald-100",
    indigo: "text-emerald-700 bg-emerald-100",
    amber: "text-amber-700 bg-amber-100",
  };
  return (
    <div className="flex items-start gap-3">
      <div className={`rounded-lg p-2 ${colorMap[accent]}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p
          className={`${highlight ? "text-3xl" : "text-2xl"} font-bold tabular-nums leading-tight`}
        >
          {value}
        </p>
        {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

function pickAccent(rate: number) {
  if (rate >= 100)
    return {
      border: "border-emerald-300",
      bg: "bg-emerald-50/60",
      badge: "success" as const,
    };
  if (rate >= 70)
    return {
      border: "border-sky-200",
      bg: "bg-sky-50/40",
      badge: "info" as const,
    };
  if (rate >= 40)
    return {
      border: "border-amber-200",
      bg: "bg-amber-50/40",
      badge: "warning" as const,
    };
  if (rate > 0)
    return {
      border: "border-rose-200",
      bg: "bg-rose-50/40",
      badge: "danger" as const,
    };
  return {
    border: "border-zinc-200",
    bg: "bg-zinc-50/40",
    badge: "secondary" as const,
  };
}
