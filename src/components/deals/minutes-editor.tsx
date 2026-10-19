"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FileText, Save, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toReadableText } from "@/lib/text-format";

export function MinutesEditor({
  meetingId,
  initialMinutes,
  initialTranscript,
  meetingDate,
  canEdit = true,
}: {
  meetingId: string;
  initialMinutes: string;
  initialTranscript: string;
  meetingDate: Date | string;
  /** 操作中の会社で利用者以上か。閲覧のみなら「編集」「AI再分析」を出さない（API も 403 で止める）。 */
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const minutes = draft && (edit || draft.base === initialMinutes) ? draft.value : initialMinutes;
  const [showTranscript, setShowTranscript] = useState(false);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // 同じイベント内の2回目のクリックは、再描画前で disabled がまだ効かない。Meet発行（meetInFlight）と同じく ref で止める。
  const analyzeInFlight = useRef(false);

  async function save() {
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes }),
      });
      if (!res.ok) throw new Error("議事録を保存できませんでした。内容を保持しているので再試行してください。");
      setEdit(false); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "保存に失敗しました。"); }
    finally { setSaving(false); }
  }

  async function analyze() {
    if (analyzeInFlight.current) return;
    analyzeInFlight.current = true;
    setAnalyzing(true); setError(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? "AI分析に失敗しました。再試行してください。");
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "AI分析に失敗しました。"); }
    finally { analyzeInFlight.current = false; setAnalyzing(false); }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        {/* 390px 幅などの狭い画面では、見出し・日付・ボタンを1文字ずつ縦に折らず、行ごと折り返す（T05/T24）。 */}
        <CardTitle className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-base">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <FileText className="h-4 w-4 shrink-0 text-orange-600" />
            <span className="whitespace-nowrap">商談要約（議事録）</span>
            <span className="whitespace-nowrap text-[12px] text-zinc-400 font-normal">
              {formatDate(meetingDate)}
            </span>
          </span>
          {canEdit && (
          <div className="ml-auto flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEdit(!edit)} disabled={saving}>
              {edit ? "プレビュー" : "編集"}
            </Button>
            <Button size="sm" variant="primary" onClick={analyze} disabled={analyzing}>
              <Sparkles className="h-3.5 w-3.5" />
              {analyzing ? "分析中..." : "AI再分析"}
            </Button>
          </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="mb-3 text-sm text-rose-600">{error}</p>}
        {canEdit && edit ? (
          <div className="space-y-2">
            <Textarea
              value={minutes}
              aria-label="議事録"
              onChange={(e) => setDraft({ base: initialMinutes, value: e.target.value })}
              rows={16}
              className="font-mono text-[13px]"
              placeholder="商談の要約を記述（「・」「①」で箇条書き、「■」で見出し。Markdown記法も表示時に自動整形されます）"
            />
            <div className="flex justify-end">
              <Button size="sm" variant="primary" onClick={save} disabled={saving}>
                <Save className="h-3.5 w-3.5" /> 保存
              </Button>
            </div>
          </div>
        ) : minutes ? (
          <pre className="whitespace-pre-wrap text-xs text-zinc-700 leading-relaxed max-h-[480px] overflow-y-auto font-sans">
            {/* 表示は読みやすい体裁（■ 見出し／・箇条書き／①）に整形。保存データは元のまま。 */}
            {toReadableText(minutes)}
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
              className="text-[13px] text-zinc-500 hover:text-zinc-700 inline-flex items-center gap-1"
            >
              {showTranscript ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              録画の文字起こし（生データ）
            </button>
            {showTranscript && (
              <pre className="whitespace-pre-wrap text-[12.5px] text-zinc-500 leading-relaxed max-h-[300px] overflow-y-auto mt-2 p-3 bg-zinc-50 rounded font-sans">
                {initialTranscript}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
