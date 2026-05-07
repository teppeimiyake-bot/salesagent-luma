"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles, MessageCircle, Lightbulb, ShieldAlert, FileText, ChevronDown, ChevronUp } from "lucide-react";

interface Preparation {
  hearing_questions: string[];
  hypotheses: string[];
  talking_points: string[];
  common_concerns: string[];
  recommended_materials: string[];
}

export function PreparationPanel({ dealId, status }: { dealId: string; status: string }) {
  const [data, setData] = useState<Preparation | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const [fallback, setFallback] = useState(false);

  // 商談前ステータスのときだけ表示
  const isPreStage = ["LEAD", "HEARING"].includes(status);
  if (!isPreStage) return null;

  async function generate() {
    setLoading(true);
    const r = await fetch(`/api/deals/${dealId}/preparation`, { method: "POST" });
    const j = await r.json();
    setData(j.preparation);
    setFallback(j.fallback);
    setLoading(false);
  }

  return (
    <Card className="border-amber-200 bg-gradient-to-br from-amber-50/60 via-white to-orange-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white p-1.5 shadow-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            商談前 AI事前準備
            <Badge variant="warning" className="ml-1">
              {status === "LEAD" ? "リード" : "ヒアリング段階"}
            </Badge>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={generate} disabled={loading}>
              <Sparkles className="h-3.5 w-3.5" />
              {loading ? "生成中..." : data ? "再生成" : "AI準備"}
            </Button>
            {data && (
              <button onClick={() => setOpen(!open)} className="text-zinc-400 hover:text-zinc-600">
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      {open && data && (
        <CardContent className="space-y-4">
          {fallback && (
            <p className="text-xs text-amber-700 bg-amber-100 px-3 py-1.5 rounded">
              ⚠ AIキー未設定のためフォールバック生成。設定後は案件特化の精緻な準備が可能です。
            </p>
          )}
          <Section icon={MessageCircle} color="text-sky-600 bg-sky-50" title="ヒアリング項目（必ず聞く）">
            <ul className="space-y-1.5">
              {data.hearing_questions.map((q, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-sky-500 font-bold">Q{i + 1}.</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={Lightbulb} color="text-green-600 bg-green-50" title="顧客の本音・仮説">
            <ul className="space-y-1.5">
              {data.hypotheses.map((h, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-green-500">•</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={Sparkles} color="text-emerald-600 bg-emerald-50" title="想定論点（こちらから切り出す）">
            <ul className="space-y-1.5">
              {data.talking_points.map((p, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-emerald-500">→</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={ShieldAlert} color="text-red-600 bg-red-50" title="想定される顧客の懸念">
            <ul className="space-y-1.5">
              {data.common_concerns.map((c, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-red-500">!</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section icon={FileText} color="text-emerald-600 bg-emerald-50" title="持参/事前送付すべき資料">
            <ul className="space-y-1.5">
              {data.recommended_materials.map((m, i) => (
                <li key={i} className="text-sm text-zinc-800 flex gap-2">
                  <span className="text-emerald-500">📄</span>
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          </Section>
        </CardContent>
      )}
      {!data && (
        <CardContent>
          <p className="text-sm text-zinc-500 text-center py-4">
            商談前です。AIが企業情報・業界・既存議事録から、ヒアリング項目／仮説／想定論点／懸念／推奨資料を生成します。
          </p>
        </CardContent>
      )}
    </Card>
  );
}

function Section({
  icon: Icon,
  color,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`rounded-md p-1 ${color}`}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="font-semibold text-sm">{title}</span>
      </div>
      {children}
    </div>
  );
}
