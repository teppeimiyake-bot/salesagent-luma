"use client";
import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Pencil, Plus, Target, Users } from "lucide-react";

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
  fy,
  quarter,
  goal,
  canEdit,
  isAdmin,
}: {
  workers: Worker[];
  entries: Entry[];
  monthCols: MonthCol[];
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

  const actualReplyRate = replyRate(quarterGrandTotal.sent, quarterGrandTotal.appointments);
  const achievement =
    goal && goal.targetReplyRate > 0 && actualReplyRate !== null
      ? actualReplyRate / goal.targetReplyRate
      : null;

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
      {/* KPIサマリ */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">四半期 送信数合計</div>
            <div className="text-2xl font-bold mt-1">{quarterGrandTotal.sent.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">四半期 アポ数合計</div>
            <div className="text-2xl font-bold mt-1">
              {quarterGrandTotal.appointments.toLocaleString()}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-zinc-500">アポ率（＝返信率）</div>
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
          <MsWorkerAdder onSaved={() => router.refresh()} />
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
            </table>
          )}
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
// ワーカー追加（admin）
// ---------------------------------------------------------------
function MsWorkerAdder({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [isAgency, setIsAgency] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("名前は必須です");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/ms-workers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code || null, name: name.trim(), isAgency }),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error ?? "追加に失敗しました");
      return;
    }
    setOpen(false);
    setCode("");
    setName("");
    setIsAgency(false);
    onSaved();
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 mr-1" />
        ワーカー追加
      </Button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-base">ワーカー追加</h3>
        <label className="text-sm space-y-1 block">
          <span className="text-zinc-600">コード（任意・例: 005）</span>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="005" />
        </label>
        <label className="text-sm space-y-1 block">
          <span className="text-zinc-600">名前</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="○○さん" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isAgency} onChange={(e) => setIsAgency(e.target.checked)} />
          代理店経由
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            キャンセル
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "追加中…" : "追加"}
          </Button>
        </div>
      </div>
    </div>
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
