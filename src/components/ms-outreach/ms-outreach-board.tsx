"use client";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, Pencil, Plus, Power, PowerOff, Settings2, Target, Trash2, Users, X } from "lucide-react";

// 月内の最大週数（1w〜5w）
const WEEKS = [1, 2, 3, 4, 5];

type Worker = {
  id: string;
  code: string | null;
  name: string;
  isAgency: boolean;
  active: boolean;
};

type Entry = {
  id: string;
  workerId: string;
  year: number;
  month: number;
  weekOfMonth: number;
  sent: number;
  appointments: number;
  listOrders: number;
  inquiryOrders: number;
  notes: string | null;
};

type MonthCol = { year: number; month: number };
/** 会計年度12ヶ月（月次サマリ用）。quarter は 1〜4。 */
type FyMonth = MonthCol & { quarter: number };

// 1セルの集計（4指標）
type Cell = { sent: number; appointments: number; listOrders: number; inquiryOrders: number };
const EMPTY_CELL: Cell = { sent: 0, appointments: 0, listOrders: 0, inquiryOrders: 0 };

// 表示する指標の定義（入力もこの4つ）
const METRICS = [
  { key: "sent", label: "送信数" },
  { key: "appointments", label: "アポ数" },
  { key: "listOrders", label: "リスト発注" },
  { key: "inquiryOrders", label: "問合せ発注" },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

function monthKey(year: number, month: number) {
  return `${year}-${month}`;
}

function addCell(acc: Cell, c: Cell): Cell {
  acc.sent += c.sent;
  acc.appointments += c.appointments;
  acc.listOrders += c.listOrders;
  acc.inquiryOrders += c.inquiryOrders;
  return acc;
}

function sumCells(cells: Cell[]): Cell {
  return cells.reduce((acc, c) => addCell(acc, c), { ...EMPTY_CELL });
}

function num(v: number): string {
  return v === 0 ? "—" : v.toLocaleString();
}

function entryKey(workerId: string, year: number, month: number, week: number) {
  return `${workerId}|${year}|${month}|${week}`;
}

function replyRate(sent: number, appointments: number): number | null {
  if (sent <= 0) return null;
  return appointments / sent;
}

function pct(v: number | null, digits = 2): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function MsOutreachBoard({
  workers,
  entries,
  monthCols,
  fyMonths,
  fy,
  quarter,
  goal,
  canEdit,
  isAdmin,
}: {
  workers: Worker[];
  /** 会計年度12ヶ月ぶんの週次実績（グリッドは monthCols の3ヶ月ぶんだけ描画） */
  entries: Entry[];
  monthCols: MonthCol[];
  fyMonths: FyMonth[];
  fy: number;
  quarter: number;
  goal: { targetReplyRate: number; targetSent: number | null } | null;
  canEdit: boolean; // user 以上：週次入力可
  isAdmin: boolean; // admin：ワーカー追加・KPI目標編集可
}) {
  const router = useRouter();

  // entries を高速参照できる Map に
  const entryMap = useMemo(() => {
    const m = new Map<string, Entry>();
    for (const e of entries) m.set(entryKey(e.workerId, e.year, e.month, e.weekOfMonth), e);
    return m;
  }, [entries]);

  // 表示するメトリクスの切替（4指標 + アポ率）
  const [metric, setMetric] = useState<MetricKey | "replyRate">("sent");

  // セル編集ダイアログ用の state
  const [editing, setEditing] = useState<{
    workerId: string;
    workerName: string;
    year: number;
    month: number;
    week: number;
  } | null>(null);

  function getCell(workerId: string, year: number, month: number, week: number): Cell {
    const e = entryMap.get(entryKey(workerId, year, month, week));
    if (!e) return EMPTY_CELL;
    return {
      sent: e.sent,
      appointments: e.appointments,
      listOrders: e.listOrders,
      inquiryOrders: e.inquiryOrders,
    };
  }

  // ワーカー×月の月計
  function monthTotalForWorker(workerId: string, col: MonthCol): Cell {
    const acc = { ...EMPTY_CELL };
    for (const w of WEEKS) {
      const c = getCell(workerId, col.year, col.month, w);
      acc.sent += c.sent;
      acc.appointments += c.appointments;
      acc.listOrders += c.listOrders;
      acc.inquiryOrders += c.inquiryOrders;
    }
    return acc;
  }

  // ワーカーの四半期計
  function quarterTotalForWorker(workerId: string): Cell {
    const acc = { ...EMPTY_CELL };
    for (const col of monthCols) {
      const m = monthTotalForWorker(workerId, col);
      acc.sent += m.sent;
      acc.appointments += m.appointments;
      acc.listOrders += m.listOrders;
      acc.inquiryOrders += m.inquiryOrders;
    }
    return acc;
  }

  // 全ワーカーの四半期合計（KPIサマリ用）
  const quarterGrandTotal = useMemo(() => {
    const acc = { ...EMPTY_CELL };
    for (const wk of workers) {
      const q = quarterTotalForWorker(wk.id);
      acc.sent += q.sent;
      acc.appointments += q.appointments;
      acc.listOrders += q.listOrders;
      acc.inquiryOrders += q.inquiryOrders;
    }
    return acc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workers, entryMap, monthCols]);

  // 全ワーカー合算の月次集計（年度12ヶ月ぶん）。表示中のアクティブワーカーのみを対象にする。
  const monthTotals = useMemo(() => {
    const activeIds = new Set(workers.map((w) => w.id));
    const m = new Map<string, Cell>();
    for (const e of entries) {
      if (!activeIds.has(e.workerId)) continue;
      const k = monthKey(e.year, e.month);
      const acc = m.get(k) ?? { ...EMPTY_CELL };
      addCell(acc, e);
      m.set(k, acc);
    }
    return m;
  }, [entries, workers]);

  function monthGrandTotal(col: MonthCol): Cell {
    return monthTotals.get(monthKey(col.year, col.month)) ?? EMPTY_CELL;
  }

  // 全ワーカー合算の週セル（グリッド最下段の「全体」行）
  function weekGrandTotal(col: MonthCol, week: number): Cell {
    return sumCells(workers.map((wk) => getCell(wk.id, col.year, col.month, week)));
  }

  // KPIサマリの集計範囲: "quarter"（四半期計）or "YYYY-M"（単月）
  const [scope, setScope] = useState<string>("quarter");
  const scopeMonth = monthCols.find((c) => monthKey(c.year, c.month) === scope) ?? null;
  // 四半期を切り替えた時に、前の四半期の月が選ばれたままにならないよう自動で四半期計に戻す
  const scopeTotal = scopeMonth ? monthGrandTotal(scopeMonth) : quarterGrandTotal;
  const scopeLabel = scopeMonth ? `${scopeMonth.month}月` : `${quarter}Q`;

  const actualReplyRate = replyRate(scopeTotal.sent, scopeTotal.appointments);
  const achievement =
    goal && goal.targetReplyRate > 0 && actualReplyRate !== null
      ? actualReplyRate / goal.targetReplyRate
      : null;

  function goToQuarter(q: number) {
    router.push(`?year=${fy}&q=${q}`);
  }

  // セル表示値の整形
  function renderCellValue(c: Cell): string {
    if (metric === "replyRate") {
      const r = replyRate(c.sent, c.appointments);
      return r === null ? "—" : pct(r);
    }
    const v = c[metric];
    return v === 0 ? "" : String(v);
  }

  return (
    <div className="space-y-5">
      {/* 集計範囲（四半期計 or 単月）*/}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">集計範囲</span>
        <div className="inline-flex rounded-md bg-zinc-100 p-1 text-xs">
          <button
            onClick={() => setScope("quarter")}
            className={
              "px-3 py-1 rounded-sm transition-all " +
              (scopeMonth === null ? "bg-white shadow font-medium text-zinc-900" : "text-zinc-600")
            }
          >
            {quarter}Q 計
          </button>
          {monthCols.map((c) => {
            const key = monthKey(c.year, c.month);
            return (
              <button
                key={key}
                onClick={() => setScope(key)}
                className={
                  "px-3 py-1 rounded-sm transition-all " +
                  (scope === key ? "bg-white shadow font-medium text-zinc-900" : "text-zinc-600")
                }
              >
                {c.month}月
              </button>
            );
          })}
        </div>
      </div>

      {/* KPIサマリ */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">{scopeLabel} 送信数合計</div>
            <div className="text-2xl font-bold mt-1">{scopeTotal.sent.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">{scopeLabel} アポ数合計</div>
            <div className="text-2xl font-bold mt-1">
              {scopeTotal.appointments.toLocaleString()}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">{scopeLabel} アポ率（＝返信率）</div>
            <div className="text-2xl font-bold mt-1">{pct(actualReplyRate)}</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">アポ数 ÷ 送信数</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center justify-between">
              <div className="text-xs text-zinc-500">達成率</div>
              <MsKpiGoalEditor fy={fy} goal={goal} isAdmin={isAdmin} onSaved={() => router.refresh()} />
            </div>
            <div className="text-2xl font-bold mt-1">
              {achievement === null ? "—" : `${(achievement * 100).toFixed(0)}%`}
            </div>
            <div className="text-[11px] text-zinc-400 mt-0.5">
              目標返信率 {goal ? pct(goal.targetReplyRate) : "未設定"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* メトリクス切替＋ワーカー追加 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-md bg-zinc-100 p-1 text-sm">
          {METRICS.map((m) => (
            <button
              key={m.key}
              onClick={() => setMetric(m.key)}
              className={
                "px-3 py-1 rounded-sm transition-all " +
                (metric === m.key ? "bg-white shadow font-medium text-zinc-900" : "text-zinc-600")
              }
            >
              {m.label}
            </button>
          ))}
          <button
            onClick={() => setMetric("replyRate")}
            className={
              "px-3 py-1 rounded-sm transition-all " +
              (metric === "replyRate" ? "bg-white shadow font-medium text-zinc-900" : "text-zinc-600")
            }
          >
            アポ率
          </button>
        </div>
        {isAdmin && (
          <MsWorkerManager onSaved={() => router.refresh()} />
        )}
      </div>

      {/* 週次グリッド */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-amber-600" />
            週次グリッド（{quarter}Q ／ {METRICS.find((m) => m.key === metric)?.label ?? "アポ率"}）
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {workers.length === 0 ? (
            <p className="text-sm text-zinc-500 py-6 text-center">
              ワーカーが未登録です。{isAdmin ? "右上の「ワーカー追加」から登録してください。" : "管理者にワーカー登録を依頼してください。"}
            </p>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className="sticky left-0 bg-white z-10 text-left px-2 py-2 font-semibold min-w-[140px]">
                    ワーカー
                  </th>
                  {monthCols.map((col) => (
                    <th
                      key={`${col.year}-${col.month}`}
                      colSpan={WEEKS.length + 1}
                      className="text-center px-1 py-2 font-semibold border-l border-zinc-200 bg-zinc-50"
                    >
                      {col.year}年{col.month}月
                    </th>
                  ))}
                  <th className="text-center px-2 py-2 font-semibold border-l-2 border-zinc-300 bg-amber-50">
                    四半期計
                  </th>
                </tr>
                <tr className="border-b border-zinc-200 text-[10px] text-zinc-500">
                  <th className="sticky left-0 bg-white z-10" />
                  {monthCols.map((col) => (
                    <Fragment key={`h-${col.year}-${col.month}`}>
                      {WEEKS.map((w) => (
                        <th
                          key={`h-${col.year}-${col.month}-${w}`}
                          className="px-1 py-1 font-normal border-l border-zinc-100 first:border-l-zinc-200"
                        >
                          {w}w
                        </th>
                      ))}
                      <th className="px-1 py-1 font-semibold border-l border-zinc-200 bg-zinc-50">
                        月計
                      </th>
                    </Fragment>
                  ))}
                  <th className="border-l-2 border-zinc-300 bg-amber-50" />
                </tr>
              </thead>
              <tbody>
                {workers.map((wk) => {
                  const qTotal = quarterTotalForWorker(wk.id);
                  return (
                    <tr key={wk.id} className="border-b border-zinc-100 hover:bg-zinc-50/50">
                      <td className="sticky left-0 bg-white z-10 px-2 py-1.5 whitespace-nowrap">
                        <span className="font-medium">{wk.name}</span>
                        {wk.code && <span className="ml-1 text-[10px] text-zinc-400">#{wk.code}</span>}
                        {wk.isAgency && (
                          <Badge variant="secondary" className="ml-1 text-[9px]">
                            代理店
                          </Badge>
                        )}
                      </td>
                      {monthCols.map((col) => {
                        const mTotal = monthTotalForWorker(wk.id, col);
                        return (
                          <Fragment key={`r-${wk.id}-${col.year}-${col.month}`}>
                            {WEEKS.map((w) => {
                              const c = getCell(wk.id, col.year, col.month, w);
                              const val = renderCellValue(c);
                              return (
                                <td
                                  key={`c-${wk.id}-${col.year}-${col.month}-${w}`}
                                  className={
                                    "px-1 py-1 text-center border-l border-zinc-100 first:border-l-zinc-200 " +
                                    (canEdit ? "cursor-pointer hover:bg-amber-50" : "")
                                  }
                                  onClick={
                                    canEdit
                                      ? () =>
                                          setEditing({
                                            workerId: wk.id,
                                            workerName: wk.name,
                                            year: col.year,
                                            month: col.month,
                                            week: w,
                                          })
                                      : undefined
                                  }
                                  title={canEdit ? "クリックで入力" : undefined}
                                >
                                  {val || <span className="text-zinc-300">·</span>}
                                </td>
                              );
                            })}
                            <td className="px-1 py-1 text-center font-semibold border-l border-zinc-200 bg-zinc-50">
                              {metric === "replyRate"
                                ? pct(replyRate(mTotal.sent, mTotal.appointments))
                                : mTotal[metric] || "—"}
                            </td>
                          </Fragment>
                        );
                      })}
                      <td className="px-2 py-1 text-center font-bold border-l-2 border-zinc-300 bg-amber-50">
                        {metric === "replyRate"
                          ? pct(replyRate(qTotal.sent, qTotal.appointments))
                          : qTotal[metric] || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-zinc-300 font-semibold bg-white">
                  <td className="sticky left-0 bg-white z-10 px-2 py-1.5 whitespace-nowrap">全体</td>
                  {monthCols.map((col) => {
                    const mTotal = monthGrandTotal(col);
                    return (
                      <Fragment key={`f-${col.year}-${col.month}`}>
                        {WEEKS.map((w) => {
                          const c = weekGrandTotal(col, w);
                          return (
                            <td
                              key={`f-${col.year}-${col.month}-${w}`}
                              className="px-1 py-1.5 text-center border-l border-zinc-100 first:border-l-zinc-200"
                            >
                              {metric === "replyRate"
                                ? pct(replyRate(c.sent, c.appointments))
                                : num(c[metric])}
                            </td>
                          );
                        })}
                        <td className="px-1 py-1.5 text-center border-l border-zinc-200 bg-zinc-100">
                          {metric === "replyRate"
                            ? pct(replyRate(mTotal.sent, mTotal.appointments))
                            : num(mTotal[metric])}
                        </td>
                      </Fragment>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center font-bold border-l-2 border-zinc-300 bg-amber-100">
                    {metric === "replyRate"
                      ? pct(replyRate(quarterGrandTotal.sent, quarterGrandTotal.appointments))
                      : num(quarterGrandTotal[metric])}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>

      {/* 月次サマリ（会計年度12ヶ月・全ワーカー合算） */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4 text-amber-600" />
            月次サマリ（FY{fy} 全12ヶ月）
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500">
                <th className="text-left px-2 py-2 font-semibold min-w-[110px]">月</th>
                <th className="text-right px-2 py-2 font-semibold">送信数</th>
                <th className="text-right px-2 py-2 font-semibold">アポ数</th>
                <th className="text-right px-2 py-2 font-semibold">アポ率</th>
                <th className="text-right px-2 py-2 font-semibold">リスト発注</th>
                <th className="text-right px-2 py-2 font-semibold">問合せ発注</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4].map((q) => {
                const months = fyMonths.filter((m) => m.quarter === q);
                const qTotal = sumCells(months.map((m) => monthGrandTotal(m)));
                const selected = q === quarter;
                return (
                  <Fragment key={`sum-q${q}`}>
                    {months.map((m) => {
                      const t = monthGrandTotal(m);
                      return (
                        <tr
                          key={`sum-${m.year}-${m.month}`}
                          onClick={() => goToQuarter(q)}
                          title={`${q}Qの週次グリッドを開く`}
                          className={
                            "border-b border-zinc-100 cursor-pointer hover:bg-amber-50 " +
                            (selected ? "bg-amber-50/40" : "")
                          }
                        >
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {m.year}年{m.month}月
                            <span className="ml-1 text-[10px] text-zinc-400">{q}Q</span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{num(t.sent)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {num(t.appointments)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {pct(replyRate(t.sent, t.appointments))}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {num(t.listOrders)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {num(t.inquiryOrders)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="border-b border-zinc-200 bg-zinc-50 font-semibold">
                      <td className="px-2 py-1.5 whitespace-nowrap">{q}Q 計</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{num(qTotal.sent)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {num(qTotal.appointments)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {pct(replyRate(qTotal.sent, qTotal.appointments))}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {num(qTotal.listOrders)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {num(qTotal.inquiryOrders)}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
              {(() => {
                const fyTotal = sumCells(fyMonths.map((m) => monthGrandTotal(m)));
                return (
                  <tr className="bg-amber-50 font-bold">
                    <td className="px-2 py-2 whitespace-nowrap">FY{fy} 通期</td>
                    <td className="px-2 py-2 text-right tabular-nums">{num(fyTotal.sent)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {num(fyTotal.appointments)}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {pct(replyRate(fyTotal.sent, fyTotal.appointments))}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{num(fyTotal.listOrders)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {num(fyTotal.inquiryOrders)}
                    </td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
          <p className="text-[11px] text-zinc-400 mt-2">
            行をクリックするとその四半期の週次グリッドに切り替わります。アポ率＝アポ数÷送信数。
          </p>
        </CardContent>
      </Card>

      {editing && (
        <CellEditDialog
          editing={editing}
          initial={getCell(editing.workerId, editing.year, editing.month, editing.week)}
          initialNotes={
            entryMap.get(entryKey(editing.workerId, editing.year, editing.month, editing.week))
              ?.notes ?? ""
          }
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------
// セル編集ダイアログ（4指標 + メモ）
// ---------------------------------------------------------------
function CellEditDialog({
  editing,
  initial,
  initialNotes,
  onClose,
  onSaved,
}: {
  editing: { workerId: string; workerName: string; year: number; month: number; week: number };
  initial: Cell;
  initialNotes: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Cell>(initial);
  const [notes, setNotes] = useState(initialNotes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rate = replyRate(form.sent, form.appointments);

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/ms-weekly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: editing.workerId,
        year: editing.year,
        month: editing.month,
        weekOfMonth: editing.week,
        sent: form.sent,
        appointments: form.appointments,
        listOrders: form.listOrders,
        inquiryOrders: form.inquiryOrders,
        notes: notes || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error ?? "保存に失敗しました");
      return;
    }
    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="font-bold text-base">{editing.workerName} の週次実績</h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {editing.year}年{editing.month}月 第{editing.week}週
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {METRICS.map((m) => (
            <label key={m.key} className="text-sm space-y-1">
              <span className="text-zinc-600">{m.label}</span>
              <Input
                type="number"
                min={0}
                value={form[m.key]}
                onChange={(e) =>
                  setForm((f) => ({ ...f, [m.key]: Math.max(0, Number(e.target.value) || 0) }))
                }
              />
            </label>
          ))}
        </div>
        <div className="text-xs text-zinc-500">
          アポ率（自動）：<span className="font-semibold text-zinc-800">{pct(rate)}</span>
        </div>
        <label className="text-sm space-y-1 block">
          <span className="text-zinc-600">メモ（任意）</span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            キャンセル
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// ワーカー管理（admin）
//   活用中 / 未活用 を分離表示し、新規登録・状態変更(トグル)・
//   ナンバリング(code)・情報編集・削除を一括で行う管理モーダル。
//   ・活用/未活用は MsWorker.active フラグで管理（true=活用中 / false=未活用）。
//     未活用にすると週次グリッド（KPI集計）から外れる（履歴データは保持）。
//   ・ナンバリング(code)は手入力だが、新規登録時に「既存の最大番号+1」を
//     初期値として自動提案する（＝手動連番、初期値だけ自動採番）。
// ---------------------------------------------------------------
type ManagerWorker = {
  id: string;
  code: string | null;
  name: string;
  isAgency: boolean;
  active: boolean;
  sortOrder: number;
};

// 既存 code から次の連番を提案（数値codeの最大+1を3桁ゼロ詰め）。
function suggestNextCode(workers: ManagerWorker[]): string {
  let max = 0;
  for (const w of workers) {
    const n = Number(w.code);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(3, "0");
}

function MsWorkerManager({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [workers, setWorkers] = useState<ManagerWorker[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // いずれかの変更があったら閉じる時に grid を更新
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ms-workers?includeInactive=true", { cache: "no-store" });
      if (!res.ok) throw new Error(`一覧の取得に失敗しました (HTTP ${res.status})`);
      const j = (await res.json()) as { workers: ManagerWorker[] };
      setWorkers(j.workers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "一覧の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  function close() {
    setOpen(false);
    if (dirty) {
      setDirty(false);
      onSaved();
    }
  }

  async function mutate(fn: () => Promise<Response>): Promise<boolean> {
    setError(null);
    const res = await fn();
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error ?? `操作に失敗しました (HTTP ${res.status})`);
      return false;
    }
    setDirty(true);
    await reload();
    return true;
  }

  const activeWorkers = workers.filter((w) => w.active);
  const inactiveWorkers = workers.filter((w) => !w.active);

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="h-4 w-4 mr-1" />
        ワーカー管理
      </Button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={close}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8 p-5 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-600" />
            ワーカー管理
          </h3>
          <button onClick={close} className="text-zinc-400 hover:text-zinc-700" title="閉じる">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 新規登録 */}
        <MsWorkerAddForm
          nextCode={suggestNextCode(workers)}
          onCreate={(payload) =>
            mutate(() =>
              fetch("/api/ms-workers", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }),
            )
          }
        />

        {error && <p className="text-xs text-red-600">{error}</p>}
        {loading && <p className="text-xs text-zinc-400">読み込み中…</p>}

        {/* 活用中 */}
        <WorkerSection
          title="活用中"
          countVariant="success"
          workers={activeWorkers}
          emptyText="活用中のワーカーがいません。"
          onToggle={(w) =>
            mutate(() =>
              fetch(`/api/ms-workers/${w.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: false }),
              }),
            )
          }
          onEdit={(id, payload) =>
            mutate(() =>
              fetch(`/api/ms-workers/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }),
            )
          }
          onDelete={(w) =>
            mutate(() => fetch(`/api/ms-workers/${w.id}`, { method: "DELETE" }))
          }
        />

        {/* 未活用 */}
        <WorkerSection
          title="未活用"
          countVariant="secondary"
          dimmed
          workers={inactiveWorkers}
          emptyText="未活用のワーカーはいません。"
          onToggle={(w) =>
            mutate(() =>
              fetch(`/api/ms-workers/${w.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active: true }),
              }),
            )
          }
          onEdit={(id, payload) =>
            mutate(() =>
              fetch(`/api/ms-workers/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }),
            )
          }
          onDelete={(w) =>
            mutate(() => fetch(`/api/ms-workers/${w.id}`, { method: "DELETE" }))
          }
        />

        <p className="text-[11px] text-zinc-400 leading-relaxed">
          「未活用」にしたワーカーは週次グリッド（KPI集計）から外れますが、過去の実績データは保持されます。活用/未活用はいつでも切り替えできます。
        </p>
      </div>
    </div>
  );
}

// 新規登録フォーム
function MsWorkerAddForm({
  nextCode,
  onCreate,
}: {
  nextCode: string;
  onCreate: (payload: {
    code: string | null;
    name: string;
    isAgency: boolean;
    sortOrder: number;
  }) => Promise<boolean>;
}) {
  const [code, setCode] = useState(nextCode);
  const [name, setName] = useState("");
  const [isAgency, setIsAgency] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // モーダルを開き直した/一覧が変わった時に次番号を反映
  useEffect(() => {
    setCode(nextCode);
  }, [nextCode]);

  async function submit() {
    if (!name.trim()) {
      setLocalError("名前は必須です");
      return;
    }
    setSaving(true);
    setLocalError(null);
    // sortOrder は code の数値（無ければ0）に揃え、番号順に並ぶようにする
    const n = Number(code);
    const ok = await onCreate({
      code: code.trim() || null,
      name: name.trim(),
      isAgency,
      sortOrder: Number.isFinite(n) ? n : 0,
    });
    setSaving(false);
    if (ok) {
      setName("");
      setIsAgency(false);
      // code は親から nextCode 更新が来るので触らない
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 space-y-3">
      <div className="text-sm font-semibold text-zinc-700 flex items-center gap-1.5">
        <Plus className="h-4 w-4 text-amber-600" />
        新規登録
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[100px_1fr_auto] gap-3 items-end">
        <label className="text-xs space-y-1 block">
          <span className="text-zinc-500">番号</span>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="005" />
        </label>
        <label className="text-xs space-y-1 block">
          <span className="text-zinc-500">名前</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="○○さん"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <Button onClick={submit} disabled={saving} className="whitespace-nowrap">
          {saving ? "登録中…" : "登録"}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-600">
        <input type="checkbox" checked={isAgency} onChange={(e) => setIsAgency(e.target.checked)} />
        代理店経由
      </label>
      {localError && <p className="text-xs text-red-600">{localError}</p>}
    </div>
  );
}

// 活用中/未活用 セクション
function WorkerSection({
  title,
  countVariant,
  workers,
  emptyText,
  dimmed = false,
  onToggle,
  onEdit,
  onDelete,
}: {
  title: string;
  countVariant: "success" | "secondary";
  workers: ManagerWorker[];
  emptyText: string;
  dimmed?: boolean;
  onToggle: (w: ManagerWorker) => Promise<boolean>;
  onEdit: (
    id: string,
    payload: { code: string | null; name: string; isAgency: boolean },
  ) => Promise<boolean>;
  onDelete: (w: ManagerWorker) => Promise<boolean>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-zinc-700">{title}</span>
        <Badge variant={countVariant}>{workers.length}</Badge>
      </div>
      {workers.length === 0 ? (
        <p className="text-xs text-zinc-400 py-2">{emptyText}</p>
      ) : (
        <ul className="space-y-1.5">
          {workers.map((w) => (
            <WorkerRow
              key={w.id}
              worker={w}
              dimmed={dimmed}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// 1行（表示 or 編集）
function WorkerRow({
  worker,
  dimmed,
  onToggle,
  onEdit,
  onDelete,
}: {
  worker: ManagerWorker;
  dimmed: boolean;
  onToggle: (w: ManagerWorker) => Promise<boolean>;
  onEdit: (
    id: string,
    payload: { code: string | null; name: string; isAgency: boolean },
  ) => Promise<boolean>;
  onDelete: (w: ManagerWorker) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState(worker.code ?? "");
  const [name, setName] = useState(worker.name);
  const [isAgency, setIsAgency] = useState(worker.isAgency);

  async function run(action: () => Promise<boolean>) {
    setBusy(true);
    await action();
    setBusy(false);
  }

  async function saveEdit() {
    if (!name.trim()) return;
    setBusy(true);
    const ok = await onEdit(worker.id, {
      code: code.trim() || null,
      name: name.trim(),
      isAgency,
    });
    setBusy(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <li className="rounded-md border border-amber-300 bg-amber-50 p-2.5">
        <div className="grid grid-cols-1 sm:grid-cols-[90px_1fr] gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="番号" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名前" />
        </div>
        <div className="flex items-center justify-between mt-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input
              type="checkbox"
              checked={isAgency}
              onChange={(e) => setIsAgency(e.target.checked)}
            />
            代理店経由
          </label>
          <div className="flex gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setCode(worker.code ?? "");
                setName(worker.name);
                setIsAgency(worker.isAgency);
              }}
              disabled={busy}
            >
              キャンセル
            </Button>
            <Button size="sm" onClick={saveEdit} disabled={busy || !name.trim()}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li
      className={
        "flex items-center gap-2 rounded-md border px-3 py-2 " +
        (dimmed ? "border-zinc-200 bg-zinc-50/60" : "border-zinc-200 bg-white")
      }
    >
      <span
        className={
          "text-[11px] tabular-nums w-9 shrink-0 " + (dimmed ? "text-zinc-400" : "text-zinc-500")
        }
      >
        {worker.code ? `#${worker.code}` : "—"}
      </span>
      <span className={"text-sm flex-1 truncate " + (dimmed ? "text-zinc-500" : "text-zinc-900")}>
        {worker.name}
      </span>
      {worker.isAgency && (
        <Badge variant="secondary" className="text-[9px] shrink-0">
          代理店
        </Badge>
      )}
      {/* 活用/未活用トグル */}
      <button
        onClick={() => run(() => onToggle(worker))}
        disabled={busy}
        title={worker.active ? "未活用にする" : "活用中にする"}
        className={
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 shrink-0 " +
          (worker.active
            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
            : "bg-zinc-200 text-zinc-600 hover:bg-zinc-300")
        }
      >
        {worker.active ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
        {worker.active ? "活用中" : "未活用"}
      </button>
      <button
        onClick={() => setEditing(true)}
        disabled={busy}
        title="編集"
        className="text-zinc-400 hover:text-zinc-700 disabled:opacity-50 shrink-0"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => {
          if (confirm(`「${worker.name}」を削除しますか？\n（週次実績がある場合は未活用に切り替わり、履歴は保持されます）`))
            run(() => onDelete(worker));
        }}
        disabled={busy}
        title="削除"
        className="text-zinc-400 hover:text-red-600 disabled:opacity-50 shrink-0"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------
// KPI目標（目標返信率）編集（admin）
// ---------------------------------------------------------------
function MsKpiGoalEditor({
  fy,
  goal,
  isAdmin,
  onSaved,
}: {
  fy: number;
  goal: { targetReplyRate: number; targetSent: number | null } | null;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  // 入力は % 表記（0.50 → 内部 0.005）
  const [ratePct, setRatePct] = useState<string>(
    goal ? (goal.targetReplyRate * 100).toString() : "0.5",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isAdmin) return null;

  async function save() {
    const num = Number(ratePct);
    if (Number.isNaN(num) || num < 0 || num > 100) {
      setError("0〜100 の数値（％）で入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/ms-kpi-goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fy, targetReplyRate: num / 100 }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error ?? "保存に失敗しました");
      return;
    }
    setOpen(false);
    onSaved();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-zinc-400 hover:text-zinc-700"
        title="目標返信率を編集"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-base flex items-center gap-2">
              <Target className="h-4 w-4 text-amber-600" />
              目標返信率（FY{fy}）
            </h3>
            <p className="text-xs text-zinc-500">
              アポ率（＝返信率）に対する目標値。達成率＝実績アポ率 ÷ 目標返信率 で表示します。
            </p>
            <label className="text-sm space-y-1 block">
              <span className="text-zinc-600">目標返信率（％）</span>
              <Input
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={ratePct}
                onChange={(e) => setRatePct(e.target.value)}
                placeholder="0.50"
              />
            </label>
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                キャンセル
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
