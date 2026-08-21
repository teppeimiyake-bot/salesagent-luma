"use client";
/**
 * 指標別 KPI 階層ロールアップビュー（Luma・リージー共通）
 * ============================================================
 * 社長要望1：「月次で入れたものを合算して、四半期目標や年間KGIに反映」
 * 社長要望2（2026-08）：「指標ごとにタブを切り替えないと見えないので見にくい。
 *                        全指標を一覧で見渡せるようにしてほしい」
 *
 * → 指標タブを廃止し、「期間（縦） × 指標（横）」のマトリクス1枚に変更。
 *   年間KGIは表の上に指標タイルとして並べ、四半期行をクリックすると
 *   その3ヶ月の月次行（正本）が開く。
 *
 * 集計タイプ：
 *  - 累積系（売上・商談数・受注数・MS送信数・MSアポ数）… 単純合算
 *  - 比率/平均系（受注率・平均単価）… 加重平均で再計算
 *    （上位期間でも「合算した分子 / 合算した分母」で正しい値になる）
 *
 * MS指標（MS送信数 / MSアポ数）：
 *  データソースは「MS送付状況」(/ms-outreach) の週次グリッド。
 *  送付代行ワーカー単位の記録で営業担当に紐付かないため、個人ビューでは「—」になる。
 */
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Layers,
  Crown,
  CalendarRange,
  CalendarDays,
  Sigma,
  Percent,
  Send,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import {
  KPI_METRICS,
  formatMetricValue,
  type KpiMetricKey,
  type KpiRollupResult,
  type PeriodRollup,
  type MetricProgress,
} from "@/lib/kpi-rollup";

/** MS系の指標（表の列で視覚的にひとまとまりに見せる） */
const MS_METRIC_KEYS = new Set<KpiMetricKey>(["msSent", "msAppointments"]);

export function MetricRollupView({
  data,
  isOrgView,
}: {
  data: KpiRollupResult;
  isOrgView: boolean;
}) {
  // 四半期の開閉。初期は全展開（=従来の見え方を維持）。
  const [openQuarters, setOpenQuarters] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.quarters.map((q) => [q.period, true])),
  );
  const allOpen = data.quarters.every((q) => openQuarters[q.period]);

  const toggleAll = () => {
    const next = !allOpen;
    setOpenQuarters(
      Object.fromEntries(data.quarters.map((q) => [q.period, next])),
    );
  };

  /** 「この指標はこのビューでは出せない」= MS指標 × 個人ビュー */
  const isUnavailable = (m: MetricProgress) => m.orgOnly && !isOrgView;

  /** 年間のMS送信数（MSアポ率＝アポ数÷送信数 の分母） */
  const yearMsSent =
    data.year.metrics.find((x) => x.metric === "msSent")?.actual ?? 0;

  return (
    <Card className="border-indigo-200 bg-gradient-to-br from-indigo-50/40 via-white to-violet-50/30 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white p-1.5 shadow-sm">
            <Layers className="h-4 w-4" />
          </div>
          指標別 積み上げ集計
          <Badge variant="info" className="text-[10px]">
            月次 → 四半期 → 年間KGI
          </Badge>
          <Badge variant={isOrgView ? "info" : "secondary"} className="ml-auto">
            {isOrgView ? "組織全体" : "個人"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── 年間KGI：全指標をタイルで一覧 ───────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Crown className="h-4 w-4 text-rose-500" />
            <span className="text-sm font-semibold text-rose-700">
              年間KGI（FY{data.fy}）
            </span>
            <span className="text-[11px] text-zinc-400">12ヶ月合算</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-2">
            {KPI_METRICS.map((def) => {
              const m = data.year.metrics.find((x) => x.metric === def.key)!;
              const na = isUnavailable(m);
              const isMs = MS_METRIC_KEYS.has(def.key);
              // MSアポ数のタイルには参考値として年間アポ率（=返信率）を添える。
              // MS送付状況(/ms-outreach)のKPI目標が「返信率」で運用されているため、
              // 年間の着地を同じ物差しで見られるようにしておく。
              const msRate =
                def.key === "msAppointments" && !na && yearMsSent > 0
                  ? (m.actual / yearMsSent) * 100
                  : null;
              return (
                <div
                  key={def.key}
                  className={`rounded-xl border p-3 flex flex-col gap-1 ${
                    isMs
                      ? "border-sky-200 bg-sky-50/50"
                      : "border-rose-200 bg-rose-50/40"
                  }`}
                >
                  <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-500">
                    <MetricKindIcon
                      kind={def.kind}
                      isMs={isMs}
                      className="h-3 w-3"
                    />
                    {def.label}
                  </span>
                  <span
                    className={`text-xl font-bold tabular-nums leading-tight ${
                      na ? "text-zinc-300" : "text-zinc-900"
                    }`}
                  >
                    {na ? "—" : formatMetricValue(m.actual, m.unit)}
                  </span>
                  {na ? (
                    <span className="text-[10px] text-zinc-400">
                      組織全体のみ集計
                    </span>
                  ) : m.target > 0 ? (
                    <>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-zinc-500">
                          目標 {formatMetricValue(m.target, m.unit)}
                        </span>
                        <Badge
                          variant={progressBadge(m.rate)}
                          className="text-[9px] px-1.5"
                        >
                          {(m.rate * 100).toFixed(0)}%
                        </Badge>
                      </div>
                      <Progress
                        value={Math.min(100, m.rate * 100)}
                        className="h-1.5"
                      />
                      {m.targetEstimated && (
                        <span className="text-[9px] text-zinc-400">
                          目標=月次合算（推定）
                        </span>
                      )}
                    </>
                  ) : msRate !== null ? (
                    <span className="text-[10px] text-sky-600">
                      アポ率 {msRate.toFixed(2)}%
                    </span>
                  ) : def.key === "revenue" ? (
                    <span className="text-[10px] text-zinc-400">
                      年間目標が未設定（KPI目標管理から設定）
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-400">実績のみ</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 期間 × 指標 のマトリクス ─────────────────────────── */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-sm font-semibold text-zinc-700">
            期間 × 指標
          </span>
          <button
            onClick={toggleAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:border-indigo-300 hover:bg-indigo-50/60"
          >
            {allOpen ? (
              <ChevronsDownUp className="h-3 w-3" />
            ) : (
              <ChevronsUpDown className="h-3 w-3" />
            )}
            {allOpen ? "月次を全て折りたたむ" : "月次を全て展開"}
          </button>
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-sm min-w-[880px]">
            <thead>
              <tr className="text-xs text-zinc-500 border-b border-zinc-200 bg-zinc-50/80">
                <th className="py-2 px-3 font-medium text-left sticky left-0 bg-zinc-50/95 z-10 w-32">
                  期間
                </th>
                {KPI_METRICS.map((def) => {
                  const isMs = MS_METRIC_KEYS.has(def.key);
                  return (
                    <th
                      key={def.key}
                      // 集計の起算日など、指標ごとの注記はホバーで出す（列幅を増やさないため）
                      title={def.note}
                      className={`py-2 px-3 font-medium text-right whitespace-nowrap ${
                        isMs ? "bg-sky-50/70 text-sky-700" : ""
                      }`}
                    >
                      <span className="inline-flex items-center gap-1">
                        <MetricKindIcon
                          kind={def.kind}
                          isMs={isMs}
                          className="h-3 w-3"
                        />
                        {def.label}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {data.quarters.map((q, qi) => (
                <QuarterRows
                  key={q.period}
                  quarter={q}
                  months={data.months.slice(qi * 3, qi * 3 + 3)}
                  open={!!openQuarters[q.period]}
                  onToggle={() =>
                    setOpenQuarters((s) => ({
                      ...s,
                      [q.period]: !s[q.period],
                    }))
                  }
                  isUnavailable={isUnavailable}
                />
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-rose-200 bg-rose-50/50">
                <td className="py-2.5 px-3 sticky left-0 bg-rose-50/90 z-10">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-rose-700 whitespace-nowrap">
                    <Crown className="h-3.5 w-3.5" />
                    年間KGI
                  </span>
                </td>
                {KPI_METRICS.map((def) => {
                  const m = data.year.metrics.find((x) => x.metric === def.key)!;
                  return (
                    <MetricCell
                      key={def.key}
                      m={m}
                      unavailable={isUnavailable(m)}
                      isMs={MS_METRIC_KEYS.has(def.key)}
                      emphasis="year"
                    />
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 商談数の起算日（社長判断 2026-08）。受注率の分母もこの商談数を使う。 */}
        <p className="text-[11px] text-zinc-500">
          <strong className="text-zinc-600">商談数</strong>
          は商談詳細の「初回商談日」の月で集計します（初回商談日が未入力の商談のみ、作成日で代替）。
          <strong className="text-zinc-600">受注率</strong>の分母もこの商談数です。
        </p>

        {/* ── 凡例：集計タイプとデータソース ─────────────────────── */}
        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-[11px] text-emerald-800 flex items-start gap-2">
            <Sigma className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>累積タイプ</strong>（売上・商談数・受注数・MS送信数・MSアポ数）は、
              四半期＝3ヶ月分、年間KGI＝12ヶ月分を<strong>単純合算</strong>します。
            </span>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 flex items-start gap-2">
            <Percent className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>比率/平均タイプ</strong>（受注率・平均単価）は単純合算できないため、
              上位期間では<strong>分子と分母をそれぞれ合算して再計算（加重平均）</strong>します。
            </span>
          </div>
          <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 text-[11px] text-sky-800 flex items-start gap-2">
            <Send className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>MS送信数 / MSアポ数</strong>は「MS送付状況」の週次グリッドの実績を月合算した値です。
              送付代行ワーカー単位の記録のため、<strong>担当者を絞った個人ビューでは表示されません</strong>。
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** 四半期行（3ヶ月合算）＋ 展開時の月次行（正本） */
function QuarterRows({
  quarter,
  months,
  open,
  onToggle,
  isUnavailable,
}: {
  quarter: PeriodRollup;
  months: PeriodRollup[];
  open: boolean;
  onToggle: () => void;
  isUnavailable: (m: MetricProgress) => boolean;
}) {
  return (
    <>
      <tr
        className="border-b border-zinc-100 bg-emerald-50/40 cursor-pointer hover:bg-emerald-50/70"
        onClick={onToggle}
      >
        <td className="py-2.5 px-3 sticky left-0 bg-emerald-50/90 z-10">
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-800 whitespace-nowrap">
            <CalendarRange className="h-3.5 w-3.5" />
            {quarter.label}
            <span className="text-[10px] text-emerald-600/70 font-normal">
              {open ? "▼" : "▶"}
            </span>
          </span>
        </td>
        {KPI_METRICS.map((def) => {
          const m = quarter.metrics.find((x) => x.metric === def.key)!;
          return (
            <MetricCell
              key={def.key}
              m={m}
              unavailable={isUnavailable(m)}
              isMs={MS_METRIC_KEYS.has(def.key)}
              emphasis="quarter"
            />
          );
        })}
      </tr>
      {open &&
        months.map((mo) => (
          <tr key={mo.period} className="border-b border-zinc-50">
            <td className="py-2 px-3 pl-7 sticky left-0 bg-white z-10">
              <span className="inline-flex items-center gap-1.5 text-zinc-600 whitespace-nowrap">
                <CalendarDays className="h-3 w-3 text-sky-400" />
                {mo.label}
              </span>
            </td>
            {KPI_METRICS.map((def) => {
              const m = mo.metrics.find((x) => x.metric === def.key)!;
              return (
                <MetricCell
                  key={def.key}
                  m={m}
                  unavailable={isUnavailable(m)}
                  isMs={MS_METRIC_KEYS.has(def.key)}
                  emphasis="month"
                />
              );
            })}
          </tr>
        ))}
    </>
  );
}

/**
 * 1セル＝1期間 × 1指標。
 * 実績を主役にし、目標が入っている指標（現状は売上のみ）は達成率バッジを下に添える。
 */
function MetricCell({
  m,
  unavailable,
  isMs,
  emphasis,
}: {
  m: MetricProgress;
  unavailable: boolean;
  isMs: boolean;
  emphasis: "year" | "quarter" | "month";
}) {
  const empty = m.actual === 0 && m.target === 0;
  const base = isMs ? "bg-sky-50/40" : "";
  const weight =
    emphasis === "month" ? "font-normal text-zinc-700" : "font-bold text-zinc-900";
  const pad = emphasis === "month" ? "py-2 px-3" : "py-2.5 px-3";

  return (
    <td className={`${pad} text-right align-top ${base}`}>
      {unavailable || empty ? (
        <span className="text-zinc-300">—</span>
      ) : (
        <div className="flex flex-col items-end gap-0.5">
          <span className={`tabular-nums whitespace-nowrap ${weight}`}>
            {formatMetricValue(m.actual, m.unit)}
          </span>
          {m.target > 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <span className="text-[9px] text-zinc-400">
                /{formatMetricValue(m.target, m.unit)}
              </span>
              <Badge
                variant={progressBadge(m.rate)}
                className="text-[9px] px-1"
              >
                {(m.rate * 100).toFixed(0)}%
              </Badge>
            </span>
          )}
        </div>
      )}
    </td>
  );
}

function MetricKindIcon({
  kind,
  isMs,
  className,
}: {
  kind: "sum" | "avg";
  isMs: boolean;
  className?: string;
}) {
  if (isMs) return <Send className={className} />;
  return kind === "sum" ? (
    <Sigma className={className} />
  ) : (
    <Percent className={className} />
  );
}

function progressBadge(
  rate: number,
): "success" | "info" | "warning" | "danger" | "secondary" {
  const pct = rate * 100;
  if (pct >= 100) return "success";
  if (pct >= 70) return "info";
  if (pct >= 40) return "warning";
  if (pct > 0) return "danger";
  return "secondary";
}
