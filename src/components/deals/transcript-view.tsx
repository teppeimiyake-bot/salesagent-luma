"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FileText, Save, Sparkles } from "lucide-react";

export function TranscriptView({
  meetingId,
  initial,
}: {
  meetingId: string;
  initial: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: text }),
    });
    setSaving(false);
    setEdit(false);
    router.refresh();
  }

  async function reanalyze() {
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
            <FileText className="h-4 w-4" /> 議事録
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEdit(!edit)}>
              {edit ? "プレビュー" : "編集"}
            </Button>
            <Button size="sm" variant="primary" onClick={reanalyze} disabled={analyzing}>
              <Sparkles className="h-3.5 w-3.5" />
              {analyzing ? "分析中..." : "AI再分析"}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {edit ? (
          <div className="space-y-2">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={20} className="font-mono text-xs" />
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={save} disabled={saving}>
                <Save className="h-3.5 w-3.5" /> 保存
              </Button>
            </div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed max-h-[480px] overflow-y-auto font-sans">
            {text || "（議事録なし）"}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
