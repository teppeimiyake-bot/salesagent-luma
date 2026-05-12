"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload, FileText, Sparkles } from "lucide-react";

export function UploadRecording({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function uploadAndAnalyze() {
    setLoading(true);
    setMsg("議事録を保存中...");
    let meetingId: string | null = null;
    try {
      if (mode === "file" && file) {
        const fd = new FormData();
        fd.append("dealId", dealId);
        fd.append("file", file);
        const res = await fetch("/api/meetings", { method: "POST", body: fd });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          setMsg(`保存に失敗しました: ${j?.error ?? `HTTP ${res.status}`}`);
          return;
        }
        meetingId = j?.meeting?.id ?? null;
      } else if (mode === "text" && text.trim()) {
        const res = await fetch("/api/meetings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId, transcript: text }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok) {
          setMsg(`保存に失敗しました: ${j?.error ?? `HTTP ${res.status}`}`);
          return;
        }
        meetingId = j?.meeting?.id ?? null;
      }
      if (!meetingId) {
        setMsg("保存に失敗しました");
        return;
      }
      setLoading(false);
      setAnalyzing(true);
      setMsg("AIが7段推論で分析中...（30秒〜90秒）");
      const a = await fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
      const aj = await a.json().catch(() => null);
      if (!a.ok) {
        setMsg(`保存はできましたが分析に失敗: ${aj?.error ?? `HTTP ${a.status}`}`);
        router.refresh();
        return;
      }
      setMsg("✓ 完了。ページを更新します");
      router.refresh();
      setTimeout(() => setMsg(null), 2000);
    } finally {
      setLoading(false);
      setAnalyzing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-4 w-4" /> 商談録画／議事録を取り込む
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-3">
          <Button
            variant={mode === "file" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("file")}
          >
            <Upload className="h-3.5 w-3.5" />
            録画ファイル
          </Button>
          <Button
            variant={mode === "text" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("text")}
          >
            <FileText className="h-3.5 w-3.5" />
            議事録テキスト
          </Button>
        </div>

        {mode === "file" ? (
          <div className="space-y-3">
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-emerald-600 file:px-4 file:py-2 file:text-white hover:file:bg-emerald-700"
            />
            <p className="text-xs text-zinc-500">
              対応：mp3/m4a/wav/mp4 等。Whisperで文字起こし→AI多段推論で次の一手を生成。
            </p>
          </div>
        ) : (
          <Textarea
            placeholder="商談の議事録／文字起こしを貼り付け..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
          />
        )}

        <div className="flex items-center gap-3 mt-4">
          <Button
            variant="primary"
            onClick={uploadAndAnalyze}
            disabled={loading || analyzing || (mode === "file" ? !file : !text.trim())}
          >
            <Sparkles className="h-4 w-4" />
            {analyzing ? "AI分析中..." : loading ? "保存中..." : "保存してAI分析"}
          </Button>
          {msg && <p className="text-xs text-zinc-600">{msg}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
