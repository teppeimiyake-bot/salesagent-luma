"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Plus, AlertTriangle, Lightbulb, Trophy, Shield, CheckCircle2 } from "lucide-react";
import type { NextAction } from "@/lib/ai/pipeline";
import { toReadableText } from "@/lib/text-format";

type Json = Record<string, unknown> | null;

/**
 * AI生成物の表示を防御的に行うヘルパー。
 * - 文字列ならそのまま
 * - null/undefined は ""
 * - オブジェクト/配列なら整形 JSON 文字列に
 * いったん AI が想定外のネスト構造（例: closing_plan が phase1/phase2 ネスト）を
 * 返してきたケースでも React の "Objects are not valid as a React child" を踏まずに
 * 表示し切るための保険。長期的には pipeline.ts 側で normalize する。
 */
function asText(v: unknown): string {
  if (v == null) return "";
  // AIが文字列内でMarkdown記法（**強調**・- 箇条書き）を使うことがあるため、
  // 表示直前に日本語の体裁（・／①）へ整形する（社長判断 2026-08）。
  if (typeof v === "string") return toReadableText(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function AiPanel({
  dealId,
  meeting,
}: {
  dealId: string;
  meeting: {
    id: string;
    summary: string | null;
    issues: Json | unknown;
    topSales: Json | unknown;
    strategy: Json | unknown;
    nextActions: Json | unknown;
    scores: Json | unknown;
    meta: Json | unknown;
  } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  if (!meeting || !meeting.summary) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-6 text-center">
          <Sparkles className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-zinc-600">
            録画／議事録を取り込み、「AI分析」を実行すると、ここに勝ち筋とNext Actionが表示されます。
          </p>
        </CardContent>
      </Card>
    );
  }

  // AI生成物は型保証が無いので unknown 経由で受けて asText() でレンダリングする
  const rawIssues = meeting.issues;
  const issues: unknown[] = Array.isArray(rawIssues) ? rawIssues : [];
  const top = (meeting.topSales as {
    real_intent?: unknown;
    decision_structure?: unknown;
    risks?: unknown;
    winning_scenario?: unknown;
  } | null) ?? null;
  const topRisks: unknown[] = Array.isArray(top?.risks) ? (top!.risks as unknown[]) : [];
  const strategy = (meeting.strategy as {
    strategy?: unknown;
    differentiation?: unknown;
    closing_plan?: unknown;
  } | null) ?? null;
  const nextActionsRaw = (meeting.nextActions as { next_actions?: unknown } | null)?.next_actions;
  const nextActions: NextAction[] = Array.isArray(nextActionsRaw) ? (nextActionsRaw as NextAction[]) : [];
  const scores = (meeting.scores as { scores: { actionability: number; specificity: number; impact: number } } | null)?.scores;
  const meta = meeting.meta as { improved?: boolean; fallback?: boolean } | null;

  function addAsTodo(idx: number, a: NextAction) {
    const key = `${meeting!.id}-${idx}`;
    if (addedIds.has(key)) return;
    startTransition(async () => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId,
          title: a.action,
          priority: a.priority,
          impact: a.impact,
          reason: a.reason,
          expectedOutcome: a.expected_outcome,
          isAiGenerated: true,
        }),
      });
      if (res.ok) {
        setAddedIds(new Set(addedIds).add(key));
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* AI要約 */}
      <Card className="border-orange-200 bg-gradient-to-br from-orange-50/40 to-white">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <div className="rounded-md bg-orange-500 text-white p-1">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            AIサマリ
            {meta?.fallback && (
              <Badge variant="warning" className="ml-auto">
                フォールバック
              </Badge>
            )}
            {meta?.improved && (
              <Badge variant="info" className="ml-auto">
                自己改善済
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-zinc-700 whitespace-pre-wrap">
          {meeting.summary}
        </CardContent>
      </Card>

      {/* 課題 */}
      {issues.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              課題
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5">
              {issues.map((it, i) => (
                <li key={i} className="text-sm text-zinc-700 flex gap-2">
                  <span className="text-amber-500">•</span>
                  <span className="whitespace-pre-wrap">{asText(it)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* トップ営業思考 */}
      {top && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb className="h-4 w-4 text-orange-500" />
              本音 / 意思決定構造
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs text-zinc-500 mb-0.5">顧客の本音</p>
              <p className="text-zinc-800 whitespace-pre-wrap">{asText(top.real_intent)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500 mb-0.5">意思決定構造</p>
              <p className="text-zinc-800 whitespace-pre-wrap">{asText(top.decision_structure)}</p>
            </div>
            {topRisks.length > 0 && (
              <div>
                <p className="text-xs text-zinc-500 mb-1 flex items-center gap-1">
                  <Shield className="h-3 w-3" /> 失注リスク
                </p>
                <ul className="space-y-1">
                  {topRisks.map((r, i) => (
                    <li key={i} className="text-zinc-700 flex gap-2">
                      <span className="text-red-500">•</span>
                      <span className="whitespace-pre-wrap">{asText(r)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3">
              <p className="text-xs text-emerald-700 font-medium mb-1 flex items-center gap-1">
                <Trophy className="h-3 w-3" /> 勝ち筋
              </p>
              <p className="text-sm text-emerald-900 whitespace-pre-wrap">{asText(top.winning_scenario)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 戦略 */}
      {strategy && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">戦略 / 差別化 / クロージングプラン</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <p className="text-xs text-zinc-500">戦略</p>
              <p className="whitespace-pre-wrap">{asText(strategy.strategy)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">差別化</p>
              <p className="whitespace-pre-wrap">{asText(strategy.differentiation)}</p>
            </div>
            <div>
              <p className="text-xs text-zinc-500">クロージング</p>
              <p className="whitespace-pre-wrap">{asText(strategy.closing_plan)}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Next Actions */}
      {nextActions.length > 0 && (
        <Card className="border-orange-200">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-orange-600" />
              Next Action
              {scores && (
                <span className="ml-auto text-xs text-zinc-500 font-normal">
                  品質: A{scores.actionability}/S{scores.specificity}/I{scores.impact}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {nextActions.map((a, i) => {
              const key = `${meeting.id}-${i}`;
              const added = addedIds.has(key);
              return (
                <div
                  key={i}
                  className="rounded-lg border border-zinc-200 p-3 hover:border-orange-300 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Badge
                      variant={
                        a.priority === "high"
                          ? "danger"
                          : a.priority === "medium"
                            ? "warning"
                            : "secondary"
                      }
                    >
                      優先 {a.priority}
                    </Badge>
                    <Badge variant="outline">インパクト {a.impact}</Badge>
                  </div>
                  <p className="font-medium text-sm whitespace-pre-wrap">{asText(a.action)}</p>
                  <p className="text-xs text-zinc-500 mt-2 whitespace-pre-wrap">理由: {asText(a.reason)}</p>
                  <p className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap">
                    期待成果: {asText(a.expected_outcome)}
                  </p>
                  <div className="mt-3">
                    {added ? (
                      <span className="text-xs text-orange-600 inline-flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> ToDoに追加済
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => addAsTodo(i, a)}
                        disabled={pending}
                      >
                        <Plus className="h-3.5 w-3.5" /> ToDoに追加
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
