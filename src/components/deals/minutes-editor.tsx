"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FileText, Save, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function MinutesEditor({
  meetingId,
  initialMinutes,
  initialTranscript,
  meetingDate,
}: {
  meetingId: string;
  initialMinutes: string;
  initialTranscript: string;
  meetingDate: Date | string;
}) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(initialMinutes);
  const [edit, setEdit] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes }),
    });
    setSaving(false);
    setEdit(false);
    router.refresh();
  }

  async function analyze() {
    setAnalyzing(true);
    await fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
    setAnalyzing(false);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-emerald-600" /> 商談要約（議事録）
            <span className="text-[10px] text-zinc-400 font-normal">
              {formatDate(meetingDate)}
            </span>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEdit(!edit)}>
              {edit ? "プレビュー" : "編集"}
            </Button>
            <Button size="sm" variant="primary" onClick={analyze} disabled={analyzing}>
              <Sparkles className="h-3.5 w-3.5" />
              {analyzing ? "分析中..." : "AI再分析"}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {edit ? (
          <div className="space-y-2">
            <Textarea
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              rows={16}
              className="font-mono text-xs"
              placeholder="商談の要約を Markdown で記述..."
            />
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={save} disabled={saving}>
                <Save className="h-3.5 w-3.5" /> 保存
              </Button>
            </div>
          </div>
        ) : minutes ? (
          <pre className="whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed max-h-[480px] overflow-y-auto font-sans">
            {minutes}
          </pre>
        ) : (
          <p className="text-sm text-zinc-500 text-center py-6">
            商談要約がまだありません。「編集」から手書き、または「AI再分析」で文字起こしから自動生成できます。
          </p>
        )}

        {/* 録画文字起こし（折りたたみ） */}
        {initialTranscript && (
          <div className="mt-4 pt-4 border-t border-zinc-100">
            <button
              onClick={() => setShowTranscript(!showTranscript)}
              className="text-xs text-zinc-500 hover:text-zinc-700 inline-flex items-center gap-1"
            >
              {showTranscript ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              録画の文字起こし（生データ）
            </button>
            {showTranscript && (
              <pre className="whitespace-pre-wrap text-[11px] text-zinc-500 leading-relaxed max-h-[300px] overflow-y-auto mt-2 p-3 bg-zinc-50 rounded font-sans">
                {initialTranscript}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
