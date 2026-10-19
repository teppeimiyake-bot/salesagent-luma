"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload, FileText, Sparkles } from "lucide-react";
import {
  fileExtension,
  isMediaAttachmentExtension,
  isTextAttachmentExtension,
  unsupportedAttachmentMessage,
  UPLOAD_RECORDING_ACCEPT,
} from "@/lib/meetings/upload-formats";
import { uploadMeetingMedia } from "./meeting-upload";

type Phase = "idle" | "saving" | "transcribing" | "analyzing";

async function waitForTranscript(
  meetingId: string,
  onTick: (elapsedSec: number, status: string | null) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;

  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/api/meetings/${meetingId}/status`, { cache: "no-store" });
    if (!res.ok) return { ok: false, error: `状態を取得できませんでした（HTTP ${res.status}）。商談履歴から確認してください。` };
    const j = await res.json().catch(() => null);
    const m = j?.meeting as
      | {
          hasTranscript?: boolean;
          processingStatus?: string;
          processingError?: string | null;
        }
      | undefined;

    if (m?.hasTranscript) return { ok: true };
    if (m?.processingStatus === "error") {
      return {
        ok: false,
        error: m.processingError ?? "文字起こしに失敗しました",
      };
    }

    onTick(Math.round((Date.now() - started) / 1000), m?.processingStatus ?? null);
    await new Promise((r) => setTimeout(r, 3000));
  }

  return {
    ok: false,
    error: "文字起こしがタイムアウトしました。商談履歴から「文字起こし再実行」を試してください。",
  };
}

export function UploadRecording({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState<string | null>(null);

  const savedMeeting = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // 同じイベント内の2回目のクリックは、再描画前で disabled がまだ効かない。Meet発行（meetInFlight）と同じく ref で止める。
  const submitInFlight = useRef(false);
  const busy = phase !== "idle";

  async function uploadAndAnalyze() {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setPhase("saving");
    setMsg("議事録を保存中...");
    let meetingId: string | null = savedMeeting.current;
    try {
      if (!meetingId) {
      if (mode === "file" && file) {
        const extension = fileExtension(file.name);
        const textAttachment = isTextAttachmentExtension(extension);
        setPhase(textAttachment ? "saving" : "transcribing");
        setMsg(
          textAttachment
            ? "議事録ファイルから本文を取り込み中..."
            : "保存と文字起こし中...（数分かかることがあります）",
        );
        const uploaded = await uploadMeetingMedia({
          dealId,
          file,
          onPartProgress: (sent, total) => setMsg(`録画を分割して送信中...（${sent}/${total}）`),
        });
        if (!uploaded.ok) {
          setMsg(`保存に失敗しました: ${uploaded.error}`);
          return;
        }
        const j = uploaded.json as { meeting?: { id?: string; processingStatus?: string; processingError?: string | null; transcript?: string | null }; transcriptionMode?: string };
        meetingId = j?.meeting?.id ?? null;
        if (meetingId && j.transcriptionMode === "job") {
          // T04/T22: Cloud Run では受付だけ即時に返る。区間ごとの文字起こしと分析は商談履歴が継続処理で進める。
          // 保存済みのファイルを選んだまま再度押して、同じ録画を二重に送らないよう選択を解除する。
          savedMeeting.current = null;
          setFile(null);
          if (fileInput.current) fileInput.current.value = "";
          setMsg("受付完了。文字起こしと議事録・BANTの作成は自動で進みます。この画面を閉じても処理は続き、進捗と結果は下の「商談履歴」に表示されます。");
          router.refresh();
          return;
        }
        // ローカルでは POST 内で文字起こしまで await するため、ここで完了判定できる
        if (j?.meeting?.processingStatus === "error") {
          setMsg(
            `保存はできましたが文字起こしに失敗: ${j?.meeting?.processingError ?? "unknown"}`,
          );
          router.refresh();
          return;
        }
        if (j?.meeting?.transcript) {
          // 一発完走（保存+文字起こし済み）→ 分析へ
        } else if (meetingId) {
          setPhase("transcribing");
          setMsg("文字起こし中...（完了後にAI分析します）");
          const waited = await waitForTranscript(meetingId, (elapsedSec, status) => {
            const label =
              status === "transcribing"
                ? "文字起こし中"
                : status === "uploaded"
                  ? "処理開始待ち"
                  : "処理中";
            setMsg(`${label}...（${elapsedSec}秒）完了後にAI分析します`);
          });
          if (!waited.ok) {
            setMsg(`保存はできましたが文字起こしに失敗: ${waited.error}`);
            router.refresh();
            return;
          }
        }
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
      }
      if (!meetingId) {
        setMsg("保存に失敗しました");
        return;
      }

      savedMeeting.current = meetingId;
      setPhase("analyzing");
      setMsg("AIが7段推論で分析中...（30秒〜90秒）");
      const a = await fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
      const aj = await a.json().catch(() => null);
      if (!a.ok) {
        setMsg(`保存はできましたが分析に失敗: ${aj?.error ?? `HTTP ${a.status}`}`);
        router.refresh();
        return;
      }
      if (a.status === 202 && aj?.accepted) {
        // T04/T22: 長い記録は原文抜粋の抽出ジョブとして受け付けられた。進捗は商談履歴が表示・継続する。
        setMsg("受付完了。長い記録のため、関係する発言を原文のまま抜粋して分析します。進捗と結果は下の「商談履歴」に表示されます。");
        savedMeeting.current = null;
        setFile(null);
        setText("");
        if (fileInput.current) fileInput.current.value = "";
        router.refresh();
        return;
      }
      setMsg("✓ 完了。ページを更新します");
      savedMeeting.current = null;
      setFile(null);
      setText("");
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
      setTimeout(() => setMsg(null), 2000);
    } catch {
      setMsg(savedMeeting.current
        ? "保存済みの記録の分析で通信に失敗しました。再度押すと同じ記録から分析を再試行します。"
        : "通信に失敗しました。商談履歴に保存済みでないか確認してから再度お試しください。");
    } finally {
      submitInFlight.current = false;
      setPhase("idle");
    }
  }

  const buttonLabel =
    phase === "analyzing"
      ? "AI分析中..."
      : phase === "transcribing"
        ? "文字起こし中..."
        : phase === "saving"
          ? "保存中..."
          : "保存してAI分析";

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
            disabled={busy}
            onClick={() => { setMode("file"); savedMeeting.current = null; setMsg(null); }}
          >
            <Upload className="h-3.5 w-3.5" />
            ファイル添付
          </Button>
          <Button
            variant={mode === "text" ? "primary" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => { setMode("text"); savedMeeting.current = null; setMsg(null); }}
          >
            <FileText className="h-3.5 w-3.5" />
            議事録テキスト
          </Button>
        </div>

        {mode === "file" ? (
          <div className="space-y-3">
            <input
              type="file"
              ref={fileInput}
              disabled={busy}
              aria-label="商談記録の添付ファイル"
              accept={UPLOAD_RECORDING_ACCEPT}
              onChange={(e) => {
                savedMeeting.current = null;
                const next = e.target.files?.[0] ?? null;
                if (next) {
                  const extension = fileExtension(next.name);
                  if (
                    !isTextAttachmentExtension(extension) &&
                    !isMediaAttachmentExtension(extension)
                  ) {
                    setFile(null);
                    setMsg(unsupportedAttachmentMessage(next.name));
                    e.target.value = "";
                    return;
                  }
                }
                setMsg(null);
                setFile(next);
              }}
              className="block w-full text-sm file:mr-4 file:rounded-md file:border-0 file:bg-orange-600 file:px-4 file:py-2 file:text-white hover:file:bg-orange-700"
            />
            <p className="text-[13px] text-zinc-500">
              対応：.txt / .md / .docx（本文を直接分析）、mp3 / m4a / wav / webm / mp4
              等（文字起こし後に分析）。貼り付けテキストも利用できます。
            </p>
            <p className="text-[13px] text-zinc-500">
              非対応：.pdf、実行ファイル等。PDFは文字配置や画像化で抽出品質が変わるため、.txt / .md
              / .docx に書き出して添付してください。
            </p>
          </div>
        ) : (
          <Textarea
            placeholder="商談の議事録／文字起こしを貼り付け..."
            value={text}
            disabled={busy}
            onChange={(e) => { setText(e.target.value); savedMeeting.current = null; }}
            rows={6}
          />
        )}

        <div className="flex items-center gap-3 mt-4">
          <Button
            variant="primary"
            onClick={uploadAndAnalyze}
            disabled={busy || (mode === "file" ? !file : !text.trim())}
          >
            <Sparkles className="h-4 w-4" />
            {buttonLabel}
          </Button>
          {msg && <p role="status" className="text-[13px] text-zinc-600">{msg}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
