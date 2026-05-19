"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Target,
  Save,
  Crown,
  CalendarRange,
  Lock,
  Info,
} from "lucide-react";
import { formatJPY } from "@/lib/utils";
import {
  monthPeriodLabel,
  getFiscalMonth,
  getFiscalQuarterMonths,
} from "@/lib/config";

type Goal = {
  id: string;
  ownerUserId: string | null;
  period: string;
  targetAmount: number;
};
type SalesUser = { id: string; name: string; avatarColor: string | null };

/**
 * KPI目標管理（admin専用）
 *
 * 設計（2026-05 社長指示）：
 *   月次目標がマスタ（入力源）。adminは各月の目標金額を入力する。
 *   四半期目標・年間KGI は月次目標の合計として自動算出（読み取り専用）。
 */
export function GoalsAdmin({
  year, // 会計年度（FY2026 → 2026）
  users,
}: {
  year: number;
  users: SalesUser[];
}) {
  const router = useRouter();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 編集対象（組織全体 or 個人）
  const [owner, setOwner] = useState<string>("__org__");
  const ownerUserId = owner === "__org__" ? null : owner;

  async function load() {
    setLoading(true);
    const r = await fetch(`/api/goals`);
    const j = await r.json();
    setGoals(j.goals ?? []);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  // FY内の12ヶ月（暦月 YYYY-MM）と表示ラベル
  const months = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => {
        const { year: y, month } = getFiscalMonth(year, i);
        return { period: monthPeriodLabel(y, month), label: `${month}月`, y, month };
      }),
    [year],
  );

  // 現在の編集対象（owner）の月次目標 period → 金額 マップ
  const monthAmounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of goals) {
      if ((g.ownerUserId ?? null) !== ownerUserId) continue;
      if (/^\d{4}-\d{2}$/.test(g.period)) map.set(g.period, g.targetAmount);
    }
    return map;
  }, [goals, ownerUserId]);

  function upsertMonth(period: string, targetAmount: number) {
    setError(null);
    return new Promise<void>((resolve) => {
      start(async () => {
        const r = await fetch(`/api/goals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ period, targetAmount, ownerUserId }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          setError(j.error ?? "保存に失敗しました");
          resolve();
          return;
        }
        await load();
        router.refresh();
        resolve();
      });
    });
  }

  // 四半期合計（FY内 Q1〜Q4）
  const quarters = useMemo(() => {
    return [0, 1, 2, 3].map((qi) => {
      const qMonths = getFiscalQuarterMonths(year, qi).map((m) =>
        monthPeriodLabel(m.year, m.month),
      );
      const total = qMonths.reduce((s, p) => s + (monthAmounts.get(p) ?? 0), 0);
      return { label: `Q${qi + 1}`, total };
    });
  }, [year, monthAmounts]);

  // 年間KGI = 12ヶ月合計
  const yearTotal = useMemo(
    () => months.reduce((s, m) => s + (monthAmounts.get(m.period) ?? 0), 0),
    [months, monthAmounts],
  );

  return (
    <Card className="border-rose-200 bg-gradient-to-br from-rose-50/40 via-white to-pink-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 text-white p-1.5 shadow-sm">
            <Target className="h-4 w-4" />
          </div>
          KPI目標管理
          <Badge variant="danger" className="ml-2">
            管理者専用
          </Badge>
          <span className="text-xs text-zinc-500 ml-auto">
            月次目標を入力 → 四半期・年間KGIを自動算出
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 仕様ノート */}
        <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-4 py-2.5 text-xs text-sky-800 flex items-start gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong className="font-bold">月次目標がマスタ</strong>です。各月の目標金額を入力すると、
            <strong className="font-bold">四半期目標</strong>（3ヶ月合計）と
            <strong className="font-bold">年間KGI</strong>（12ヶ月合計）が自動算出されます。
            四半期・年間は編集できません。
          </span>
        </div>

        {/* 編集対象セレクタ */}
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs">編集対象</Label>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="h-9 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__org__">
                  <span className="inline-flex items-center gap-1.5">
                    <Crown className="h-3 w-3 text-rose-500" />
                    組織全体
                  </span>
                </SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="text-xs text-zinc-500 pb-2">
            会計年度 FY{year}（{months[0]?.label}〜{months[11]?.label}）
          </span>
        </div>

        {error && (
          <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
        )}

        {/* ============ 月次目標 入力グリッド ============ */}
        {loading ? (
          <p className="text-sm text-zinc-500 text-center py-4">読み込み中...</p>
        ) : (
          <div className="rounded-lg border border-rose-200 bg-white overflow-hidden">
            <div className="px-4 py-2 bg-rose-50/60 border-b border-rose-100 text-xs font-semibold text-rose-700 flex items-center gap-1.5">
              <CalendarRange className="h-3.5 w-3.5" />
              月次目標（入力）
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-100">
              {months.map((m) => (
                <MonthInput
                  key={m.period}
                  label={m.label}
                  period={m.period}
                  amount={monthAmounts.get(m.period) ?? 0}
                  onSave={(v) => upsertMonth(m.period, v)}
                  pending={pending}
                />
              ))}
            </div>
          </div>
        )}

        {/* ============ 自動算出：四半期目標 ============ */}
        <div className="rounded-lg border border-orange-200 bg-orange-50/30 overflow-hidden">
          <div className="px-4 py-2 bg-orange-50/70 border-b border-orange-100 text-xs font-semibold text-orange-700 flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" />
            四半期目標（自動算出・編集不可）
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-zinc-100">
            {quarters.map((q) => (
              <div key={q.label} className="bg-white px-4 py-3">
                <p className="text-xs font-semibold text-zinc-600">{q.label}</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-orange-700">
                  {formatJPY(q.total)}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ============ 自動算出：年間KGI ============ */}
        <div className="rounded-lg border border-rose-300 bg-gradient-to-br from-rose-50 to-pink-50/50 px-5 py-4 flex items-center gap-3 flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 text-white p-1.5 shadow-sm">
            <Crown className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs text-rose-700 font-semibold flex items-center gap-1">
              年間KGI（自動算出・編集不可）
              <Lock className="h-3 w-3" />
            </p>
            <p className="text-2xl font-bold tabular-nums text-rose-700 leading-tight">
              {formatJPY(yearTotal)}
            </p>
          </div>
          <span className="text-[11px] text-zinc-500 ml-auto">
            = FY{year} の12ヶ月分の月次目標合計
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function MonthInput({
  label,
  period,
  amount,
  onSave,
  pending,
}: {
  label: string;
  period: string;
  amount: number;
  onSave: (n: number) => Promise<void>;
  pending: boolean;
}) {
  const [value, setValue] = useState<string>(amount ? String(amount) : "");
  // 親state（goals再読込）が変わったら同期
  useEffect(() => {
    setValue(amount ? String(amount) : "");
  }, [amount]);

  const parsed = value.trim() === "" ? 0 : Math.round(Number(value));
  const valid = !Number.isNaN(parsed) && parsed >= 0;
  const dirty = valid && parsed !== amount;

  return (
    <div className="bg-white px-4 py-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-zinc-700">{label}</span>
        <span className="text-[10px] text-zinc-400">{period}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0"
          min={0}
          className="h-8 text-right tabular-nums"
        />
        <Button
          size="sm"
          variant={dirty ? "primary" : "outline"}
          disabled={!dirty || pending}
          onClick={() => dirty && onSave(parsed)}
          title="保存"
        >
          <Save className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
