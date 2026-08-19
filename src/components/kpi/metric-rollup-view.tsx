"use client";
/**
 * 指標別 KPI 階層ロールアップビュー（Luma・リージー共通）
 * ============================================================
 * 社長要望：「月次で入れたものを合算して、四半期目標や年間KGIに反映」
 *
 * 月次（正本）→ 四半期（3ヶ月合算）→ 年間KGI（12ヶ月合算）を
 * 指標ごとに1枚のテーブルで俯瞰する。
 *
 * 集計タイプ：
 *  - 累積系（受注金額・商談数・受注数）… 単純合算
 *  - 比率/平均系（受注率・平均受注単価）… 加重平均で再計算
 *    （上位期間でも「合算した分子 / 合算した分母」で正しい値になる）
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
} from "lucide-react";
import {
  KPI_METRICS,
  formatMetricValue,
  type KpiMetricKey,
  type KpiRollupResult,
  type PeriodRollup,
  type MetricProgress,
} from "@/lib/kpi-rollup";

export function MetricRollupView({
  data,
  isOrgView,
}: {
  data: KpiRollupResult;
  isOrgView: boolean;
}) {
  const [metric, setMetric] = useState<KpiMetricKey>("revenue");
  const def = KPI_METRICS.find((m) => m.key === metric)!;

  const pick = (p: PeriodRollup): MetricProgress =>
    p.metrics.find((m) => m.metric === metric)!;

  const yearM = pick(data.year);

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
        {/* 指標タブ */}
        <div className="flex flex-wrap gap-1.5">
          {KPI_METRICS.map((m) => {
            const active = m.key === metric;
            return (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "border-indigo-400 bg-indigo-500 text-white shadow-sm"
                    : "border-zinc-200 bg-white text-zinc-600 hover:border-indigo-200 hover:bg-indigo-50/50"
                }`}
              >
                {m.kind === "sum" ? (
                  <Sigma className="h-3 w-3" />
                ) : (
                  <Percent className="h-3 w-3" />
                )}
                {m.label}
              </button>
            );
          })}
        </div>

        {/* 集計タイプの説明 */}
        <div
          className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${
            def.kind === "sum"
              ? "border-emerald-200 bg-emerald-50/60 text-emerald-800"
              : "border-amber-200 bg-amber-50/60 text-amber-800"
          }`}
        >
          {def.kind === "sum" ? (
            <>
              <Badge variant="success" className="text-[10px]">
                累積タイプ
              </Badge>
              <span>
                <strong>{def.label}</strong> は累積系の指標です。四半期は3ヶ月分、年間KGIは12ヶ月分を
                <strong>単純合算</strong>して積み上げます。
              </span>
            </>
          ) : (
            <>
              <Badge variant="warning" className="text-[10px]">
                比率/平均タイプ
              </Badge>
              <span>
                <strong>{def.label}</strong> は比率・平均系の指標です。単純合算はできないため、
                上位期間では<strong>分子と分母をそれぞれ合算して再計算（加重平均）</strong>します。
              </span>
            </>
          )}
        </div>

        {/* 年間KGI サマリ */}
        <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Crown className="h-4 w-4 text-rose-500" />
            <span className="text-sm font-semibold text-rose-700">
              年間KGI（FY{data.fy}）— {def.label}
            </span>
            {yearM.target > 0 && yearM.targetEstimated && (
              <Badge variant="secondary" className="text-[9px]">
                目標=月次合算（推定）
              </Badge>
            )}
          </div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-3xl font-bold tabular-nums">
              {formatMetricValue(yearM.actual, yearM.unit)}
            </span>
            {yearM.target > 0 && (
              <>
                <span className="text-sm text-zinc-500">
                  / 目標 {formatMetricValue(yearM.target, yearM.unit)}
                </span>
                <Badge
                  variant={progressBadge(yearM.rate)}
                  className="text-[11px]"
                >
                  達成率 {(yearM.rate * 100).toFixed(1)}%
                </Badge>
              </>
            )}
          </div>
          {yearM.target > 0 && (
            <Progress
              value={Math.min(100, yearM.rate * 100)}
              className="mt-2 h-2.5"
            />
          )}
          {yearM.target === 0 && (
            <p className="mt-1 text-[11px] text-zinc-400">
              {def.key === "revenue"
                ? "年間目標が未設定です（管理者が KPI目標管理から設定できます）。"
                : "この指標は実績の積み上げ表示のみ対応しています（目標設定は売上のみ）。"}
            </p>
          )}
        </div>

        {/* 四半期 → 月次 の階層テーブル */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500 border-b border-zinc-200">
                <th className="py-2 pr-3 font-medium">期間</th>
                <th className="py-2 px-3 font-medium text-right">実績</th>
                <th className="py-2 px-3 font-medium text-right">目標</th>
                <th className="py-2 px-3 font-medium text-right">達成率</th>
                <th className="py-2 pl-3 font-medium w-40">進捗</th>
              </tr>
            </thead>
            <tbody>
              {data.quarters.map((q, qi) => {
                const qm = pick(q);
                const qMonths = data.months.slice(qi * 3, qi * 3 + 3);
                return (
                  <QuarterBlock
                    key={q.period}
                    quarter={q}
                    qm={qm}
                    months={qMonths}
                    pick={pick}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function QuarterBlock({
  quarter,
  qm,
  months,
  pick,
}: {
  quarter: PeriodRollup;
  qm: MetricProgress;
  months: PeriodRollup[];
  pick: (p: PeriodRollup) => MetricProgress;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {/* 四半期行（3ヶ月合算） */}
      <tr
        className="border-b border-zinc-100 bg-emerald-50/40 cursor-pointer hover:bg-emerald-50/70"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="py-2.5 pr-3">
          <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-800">
            <CalendarRange className="h-3.5 w-3.5" />
            {quarter.label}
            <span className="text-[10px] text-emerald-600/70 font-normal">
              {open ? "▼" : "▶"} 3ヶ月合算
            </span>
            {qm.target > 0 && qm.targetEstimated && (
              <Badge variant="secondary" className="text-[9px]">
                目標=月次合算
              </Badge>
            )}
          </span>
        </td>
        <td className="py-2.5 px-3 text-right font-bold tabular-nums">
          {formatMetricValue(qm.actual, qm.unit)}
        </td>
        <td className="py-2.5 px-3 text-right tabular-nums text-zinc-500">
          {qm.target > 0 ? formatMetricValue(qm.target, qm.unit) : "—"}
        </td>
        <td className="py-2.5 px-3 text-right">
          {qm.target > 0 ? (
            <Badge variant={progressBadge(qm.rate)} className="text-[10px]">
              {(qm.rate * 100).toFixed(0)}%
            </Badge>
          ) : (
            <span className="text-zinc-300">—</span>
          )}
        </td>
        <td className="py-2.5 pl-3">
          {qm.target > 0 && (
            <Progress value={Math.min(100, qm.rate * 100)} className="h-1.5" />
          )}
        </td>
      </tr>
      {/* 月次行（正本） */}
      {open &&
        months.map((m) => {
          const mm = pick(m);
          const empty = mm.actual === 0 && mm.target === 0;
          return (
            <tr key={m.period} className="border-b border-zinc-50">
              <td className="py-2 pr-3 pl-6">
                <span className="inline-flex items-center gap-1.5 text-zinc-600">
                  <CalendarDays className="h-3 w-3 text-sky-400" />
                  {m.label}
                </span>
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {empty ? (
                  <span className="text-zinc-300">—</span>
                ) : (
                  formatMetricValue(mm.actual, mm.unit)
                )}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-zinc-400">
                {mm.target > 0 ? formatMetricValue(mm.target, mm.unit) : "—"}
              </td>
              <td className="py-2 px-3 text-right">
                {mm.target > 0 ? (
                  <Badge
                    variant={progressBadge(mm.rate)}
                    className="text-[9px] px-1.5"
                  >
                    {(mm.rate * 100).toFixed(0)}%
                  </Badge>
                ) : (
                  <span className="text-zinc-300">—</span>
                )}
              </td>
              <td className="py-2 pl-3">
                {mm.target > 0 && (
                  <Progress
                    value={Math.min(100, mm.rate * 100)}
                    className="h-1"
                  />
                )}
              </td>
            </tr>
          );
        })}
    </>
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
