"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Target,
  Plus,
  Trash2,
  Save,
  Crown,
  CalendarRange,
  CalendarDays,
  Calendar as CalendarIcon,
} from "lucide-react";
import { formatJPY } from "@/lib/utils";
import {
  fyPeriodLabel,
  fyQuarterPeriodLabel,
  monthPeriodLabel,
  getFiscalMonth,
} from "@/lib/config";

type Goal = {
  id: string;
  ownerUserId: string | null;
  period: string;
  targetAmount: number;
  owner?: { id: string; name: string; avatarColor: string | null } | null;
};
type SalesUser = { id: string; name: string; avatarColor: string | null };

type PeriodTab = "year" | "quarter" | "month";

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
  const [tab, setTab] = useState<PeriodTab>("year");

  // 新規追加フォーム
  const [newOwner, setNewOwner] = useState<string>("__org__");
  const [newPeriod, setNewPeriod] = useState<string>(fyPeriodLabel(year));
  const [newAmount, setNewAmount] = useState<string>("");

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

  // タブ切替時に新規追加フォームの期間プレースホルダ更新
  useEffect(() => {
    if (tab === "year") setNewPeriod(fyPeriodLabel(year));
    else if (tab === "quarter") setNewPeriod(fyQuarterPeriodLabel(year, 1));
    else {
      const { year: y, month } = getFiscalMonth(year, 0);
      setNewPeriod(monthPeriodLabel(y, month));
    }
  }, [tab, year]);

  function upsert(payload: { period: string; targetAmount: number; ownerUserId: string | null }) {
    setError(null);
    start(async () => {
      const r = await fetch(`/api/goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "保存に失敗しました");
        return;
      }
      await load();
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm("この目標を削除しますか？")) return;
    start(async () => {
      const r = await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error ?? "削除に失敗しました");
        return;
      }
      await load();
      router.refresh();
    });
  }

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!newPeriod.trim() || !newAmount) return;
    upsert({
      period: newPeriod.trim(),
      targetAmount: Math.round(Number(newAmount)),
      ownerUserId: newOwner === "__org__" ? null : newOwner,
    });
    setNewAmount("");
  }

  // タブごとに目標を分類
  const filtered = useMemo(() => {
    return goals.filter((g) => classifyPeriod(g.period) === tab);
  }, [goals, tab]);

  // クイック追加：会計年度/会計四半期/会計年度内の各月の候補を提示
  const quickAddCandidates = useMemo(() => {
    if (tab === "year") return [fyPeriodLabel(year)];
    if (tab === "quarter") return [1, 2, 3, 4].map((q) => fyQuarterPeriodLabel(year, q));
    return Array.from({ length: 12 }, (_, i) => {
      const { year: y, month } = getFiscalMonth(year, i);
      return monthPeriodLabel(y, month);
    });
  }, [tab, year]);

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
            年間KGI / 四半期KPI / 月次KPI を個人・組織別に設定
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as PeriodTab)}>
          <TabsList className="grid grid-cols-3 max-w-md">
            <TabsTrigger value="year">
              <Crown className="h-3.5 w-3.5 mr-1" />
              年間KGI
            </TabsTrigger>
            <TabsTrigger value="quarter">
              <CalendarRange className="h-3.5 w-3.5 mr-1" />
              四半期
            </TabsTrigger>
            <TabsTrigger value="month">
              <CalendarDays className="h-3.5 w-3.5 mr-1" />
              月次
            </TabsTrigger>
          </TabsList>
          {(["year", "quarter", "month"] as const).map((t) => (
            <TabsContent key={t} value={t} className="space-y-4 mt-4">
              {/* 新規追加 */}
              <form
                onSubmit={submitNew}
                className="grid grid-cols-1 md:grid-cols-12 gap-2 p-4 rounded-lg border border-rose-200 bg-rose-50/30"
              >
                <div className="md:col-span-3 space-y-1">
                  <Label className="text-xs">対象</Label>
                  <Select value={newOwner} onValueChange={setNewOwner}>
                    <SelectTrigger className="h-9">
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
                <div className="md:col-span-3 space-y-1">
                  <Label className="text-xs">
                    期間（{t === "year" ? "例: FY2026" : t === "quarter" ? "例: FY2026-Q2" : "例: 2026-06"}）
                  </Label>
                  <Select value={newPeriod} onValueChange={setNewPeriod}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {quickAddCandidates.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-4 space-y-1">
                  <Label className="text-xs">目標金額（円）</Label>
                  <Input
                    type="number"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    placeholder={
                      t === "year"
                        ? "例: 200000000"
                        : t === "quarter"
                          ? "例: 50000000"
                          : "例: 15000000"
                    }
                    min={0}
                  />
                </div>
                <div className="md:col-span-2 flex items-end">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={pending || !newAmount || !newPeriod.trim()}
                    className="w-full"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    追加 / 更新
                  </Button>
                </div>
              </form>

              {error && (
                <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>
              )}

              {/* 既存目標一覧 */}
              {loading ? (
                <p className="text-sm text-zinc-500 text-center py-4">読み込み中...</p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-zinc-500 text-center py-4">
                  この粒度（{t === "year" ? "年間" : t === "quarter" ? "四半期" : "月次"}）の目標はまだ設定されていません。
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100 border border-zinc-200 rounded-lg bg-white">
                  {filtered.map((g) => (
                    <GoalRow
                      key={g.id}
                      goal={g}
                      onSave={(targetAmount) =>
                        upsert({
                          period: g.period,
                          targetAmount,
                          ownerUserId: g.ownerUserId,
                        })
                      }
                      onRemove={() => remove(g.id)}
                      pending={pending}
                    />
                  ))}
                </ul>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function classifyPeriod(period: string): PeriodTab | "other" {
  if (/^FY\d{4}$/i.test(period)) return "year";
  if (/^FY\d{4}-Q[1-4]$/i.test(period)) return "quarter";
  if (/^\d{4}-\d{2}$/.test(period)) return "month";
  // 後方互換
  if (/^\d{4}$/.test(period)) return "year";
  if (/^\d{4}-Q[1-4]$/i.test(period)) return "quarter";
  return "other";
}

function GoalRow({
  goal,
  onSave,
  onRemove,
  pending,
}: {
  goal: Goal;
  onSave: (n: number) => void;
  onRemove: () => void;
  pending: boolean;
}) {
  const [amount, setAmount] = useState<string>(String(goal.targetAmount));
  const dirty = Number(amount) !== goal.targetAmount;
  const isOrg = !goal.ownerUserId;
  const cls = classifyPeriod(goal.period);

  return (
    <li className="px-4 py-3 flex items-center gap-3 flex-wrap">
      {isOrg ? (
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-rose-700">
          <Crown className="h-3.5 w-3.5" /> 組織全体
        </span>
      ) : (
        <span className="inline-flex items-center gap-2 text-sm">
          <span
            className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
            style={{ background: goal.owner?.avatarColor ?? "#6366f1" }}
          >
            {goal.owner?.name.charAt(0) ?? "?"}
          </span>
          <span className="font-semibold">{goal.owner?.name ?? "(削除済)"}</span>
        </span>
      )}
      <Badge
        variant={cls === "year" ? "danger" : cls === "quarter" ? "info" : "secondary"}
        className="inline-flex items-center gap-1"
      >
        {cls === "year" && <Crown className="h-3 w-3" />}
        {cls === "quarter" && <CalendarRange className="h-3 w-3" />}
        {cls === "month" && <CalendarIcon className="h-3 w-3" />}
        {goal.period}
      </Badge>
      <span className="ml-auto text-xs text-zinc-500">現在: {formatJPY(goal.targetAmount)}</span>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-8 w-36 text-right tabular-nums"
        />
        <Button
          size="sm"
          variant={dirty ? "primary" : "outline"}
          disabled={!dirty || pending}
          onClick={() => onSave(Math.round(Number(amount)))}
        >
          <Save className="h-3 w-3" />
          保存
        </Button>
        <button
          onClick={onRemove}
          disabled={pending}
          className="text-zinc-300 hover:text-red-500 px-1"
          title="削除"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
