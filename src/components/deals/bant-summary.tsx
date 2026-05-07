"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Target,
  Sparkles,
  Save,
  RefreshCw,
  Wallet,
  Crown,
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

type BantValue = {
  budget?: string;
  authority?: string;
  need?: string;
  timeline?: string;
  summary?: string;
  confidence?: number;
};

export function BantSummary({
  dealId,
  initial,
  bantUpdatedAt,
  meetingsCount,
  canEdit,
}: {
  dealId: string;
  initial: BantValue | null;
  bantUpdatedAt: Date | string | null;
  meetingsCount: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState<BantValue>({
    budget: initial?.budget ?? "",
    authority: initial?.authority ?? "",
    need: initial?.need ?? "",
    timeline: initial?.timeline ?? "",
    summary: initial?.summary ?? "",
    confidence: initial?.confidence,
  });
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [generating, setGenerating] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);

  const isEmpty = !v.budget && !v.authority && !v.need && !v.timeline && !v.summary;

  function regenerate() {
    setGenerating(true);
    start(async () => {
      const r = await fetch(`/api/deals/${dealId}/summarize-bant`, { method: "POST" });
      const j = await r.json();
      if (j.bant) {
        setV({
          budget: j.bant.budget ?? "",
          authority: j.bant.authority ?? "",
          need: j.bant.need ?? "",
          timeline: j.bant.timeline ?? "",
          summary: j.bant.summary ?? "",
          confidence: j.bant.confidence,
        });
        setUsedFallback(!!j.fallback);
        router.refresh();
      }
      setGenerating(false);
    });
  }

  function save() {
    start(async () => {
      await fetch(`/api/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bant: {
            budget: v.budget,
            authority: v.authority,
            need: v.need,
            timeline: v.timeline,
            summary: v.summary,
          },
        }),
      });
      setEditing(false);
      router.refresh();
    });
  }

  const fields = [
    { key: "budget", label: "B / Budget（予算）", icon: Wallet, color: "text-emerald-600 bg-emerald-50" },
    { key: "authority", label: "A / Authority（決裁）", icon: Crown, color: "text-amber-600 bg-amber-50" },
    { key: "need", label: "N / Need（必要性）", icon: AlertCircle, color: "text-rose-600 bg-rose-50" },
    { key: "timeline", label: "T / Timeline（時期）", icon: CalendarClock, color: "text-sky-600 bg-sky-50" },
  ] as const;

  const conf = v.confidence ?? 0;
  const confColor =
    conf >= 70 ? "emerald" : conf >= 40 ? "sky" : conf >= 20 ? "amber" : "red";

  return (
    <Card className="border-orange-200 bg-gradient-to-br from-orange-50/40 via-white to-amber-50/30 shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base flex-wrap">
          <div className="rounded-lg bg-gradient-to-br from-orange-500 to-amber-500 text-white p-1.5 shadow-sm">
            <Target className="h-4 w-4" />
          </div>
          BANT情報
          <Badge variant="info" className="text-[10px]">
            案件全体の集約サマリ
          </Badge>
          {bantUpdatedAt && (
            <span className="text-xs text-zinc-500 inline-flex items-center gap-1">
              <RefreshCw className="h-3 w-3" />
              {formatDate(bantUpdatedAt)} 更新
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5">
            {canEdit && (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={regenerate}
                  disabled={generating || pending || meetingsCount === 0}
                  title={meetingsCount === 0 ? "商談記録がまだありません" : "全商談記録からAIで再集約"}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {generating ? "AI集約中..." : "AI再集約"}
                </Button>
                <Button
                  size="sm"
                  variant={editing ? "outline" : "ghost"}
                  onClick={() => setEditing(!editing)}
                >
                  {editing ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" /> 閉じる
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" /> 手動編集
                    </>
                  )}
                </Button>
              </>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {usedFallback && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 inline-flex items-center gap-1.5">
            <AlertCircle className="h-3 w-3" />
            AIキー未設定のため簡易集約で表示しています。手動編集で精度を上げてください。
          </p>
        )}

        {isEmpty ? (
          <div className="text-center py-6 rounded-lg border-2 border-dashed border-orange-200 bg-white/60">
            <Target className="h-8 w-8 text-orange-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-600">
              まだBANT情報が集約されていません。
            </p>
            <p className="text-xs text-zinc-500 mt-1">
              商談記録があれば「AI再集約」、無ければ「手動編集」から登録してください。
            </p>
          </div>
        ) : (
          <>
            {/* サマリ */}
            {v.summary && (
              <div className="rounded-lg bg-gradient-to-br from-orange-500/95 to-amber-500/95 text-white p-4 shadow-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-white/80 mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" />
                  総合所感（AI集約）
                </p>
                <p className="text-sm leading-relaxed">{v.summary}</p>
                {typeof v.confidence === "number" && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[11px] text-white/80">情報確度</span>
                    <div className="flex-1 h-1.5 bg-white/20 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white"
                        style={{ width: `${conf}%` }}
                      />
                    </div>
                    <Badge
                      variant={confColor === "emerald" ? "success" : confColor === "sky" ? "info" : confColor === "amber" ? "warning" : "danger"}
                      className="text-[10px] bg-white/95 text-zinc-800 border-0"
                    >
                      {conf}%
                    </Badge>
                  </div>
                )}
              </div>
            )}

            {/* 4項目 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {fields.map((f) => {
                const Icon = f.icon;
                const val = v[f.key];
                return (
                  <div
                    key={f.key}
                    className="rounded-lg border border-zinc-200 bg-white p-3"
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className={`rounded-md p-1 ${f.color}`}>
                        <Icon className="h-3 w-3" />
                      </div>
                      <p className="text-xs font-semibold text-zinc-700">{f.label}</p>
                    </div>
                    {val ? (
                      <p className="text-sm text-zinc-800 leading-snug whitespace-pre-wrap">
                        {val}
                      </p>
                    ) : (
                      <p className="text-xs text-zinc-400 italic">未確認</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* 手動編集 */}
        {editing && canEdit && (
          <div className="space-y-3 pt-3 border-t border-orange-100">
            <p className="text-xs text-zinc-500 inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-orange-500" />
              手動編集（AI集約結果を上書きできます）
            </p>
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label className="text-xs text-zinc-600">{f.label}</Label>
                <Textarea
                  value={v[f.key] ?? ""}
                  onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
                  rows={2}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-xs text-zinc-600">総合所感</Label>
              <Textarea
                value={v.summary ?? ""}
                onChange={(e) => setV({ ...v, summary: e.target.value })}
                rows={3}
                placeholder="案件全体のBANT総合所感と次に取りに行くべき情報"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                キャンセル
              </Button>
              <Button size="sm" variant="primary" onClick={save} disabled={pending}>
                <Save className="h-3.5 w-3.5" />
                {pending ? "保存中..." : "BANTを保存"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
