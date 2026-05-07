"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mic, MonitorSpeaker, Square, Sparkles, Headphones, Upload } from "lucide-react";

type RecorderMode = "mic" | "tab";

export function MeetingRecorder({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<RecorderMode>("mic");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => stopAll(), []);

  function stopAll() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* noop */ }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  async function start() {
    setMsg(null);
    try {
      let stream: MediaStream;
      if (mode === "mic") {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        // タブ音声（画面共有のうち audio のみ抜き取る）
        const ds = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1, height: 1 },
          audio: true,
        });
        const audioTracks = ds.getAudioTracks();
        if (audioTracks.length === 0) {
          ds.getTracks().forEach((t) => t.stop());
          setMsg("タブ音声が取得できません。共有時に「タブの音声を共有」をオンにしてください（Chrome系のみ）");
          return;
        }
        stream = new MediaStream(audioTracks);
        // ビデオトラックは即停止
        ds.getVideoTracks().forEach((t) => t.stop());
      }
      streamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => upload();
      rec.start(500);
      recorderRef.current = rec;
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (e) {
      setMsg(`録音開始失敗: ${(e as Error).message}`);
    }
  }

  function stop() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  async function upload() {
    setAnalyzing(true);
    setMsg("録音をアップロード中...");
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    const file = new File([blob], `recording_${Date.now()}.webm`, { type: "audio/webm" });
    const fd = new FormData();
    fd.append("dealId", dealId);
    fd.append("file", file);
    const r = await fetch("/api/meetings", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok || !j.meeting?.id) {
      setMsg(`アップロード失敗: ${j.error ?? "unknown"}`);
      setAnalyzing(false);
      return;
    }
    setMsg("Whisper文字起こし＋AI 7段分析を実行中...");
    await fetch(`/api/meetings/${j.meeting.id}/analyze`, { method: "POST" });
    setMsg("✓ 完了");
    setAnalyzing(false);
    router.refresh();
    setTimeout(() => setMsg(null), 3000);
  }

  function fmtTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  return (
    <Card className="border-rose-200 bg-gradient-to-br from-rose-50/50 via-white to-pink-50/30">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 text-white p-1.5 shadow-sm">
              <Headphones className="h-4 w-4" />
            </div>
            ライブ商談録音
            {recording && (
              <Badge variant="danger" className="animate-pulse">
                録音中 {fmtTime(seconds)}
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Button
            variant={mode === "mic" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("mic")}
            disabled={recording}
          >
            <Mic className="h-3.5 w-3.5" />
            マイク
          </Button>
          <Button
            variant={mode === "tab" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("tab")}
            disabled={recording}
          >
            <MonitorSpeaker className="h-3.5 w-3.5" />
            タブ音声（Zoom等）
          </Button>
        </div>

        <p className="text-xs text-zinc-600 leading-relaxed">
          {mode === "mic"
            ? "🎙 マイクから録音します。商談相手の音声も取りたい場合は「タブ音声」を選んでください。"
            : "🖥 ブラウザのタブ音声をキャプチャします（Chrome系）。共有ダイアログで「Zoom等のタブ」を選び、必ず「タブの音声を共有」をONにしてください。"}
        </p>

        {!recording ? (
          <Button variant="primary" onClick={start} disabled={analyzing}>
            <Mic className="h-4 w-4" />
            {analyzing ? "処理中..." : "録音開始"}
          </Button>
        ) : (
          <Button variant="destructive" onClick={stop}>
            <Square className="h-4 w-4" />
            停止して文字起こし
          </Button>
        )}

        {analyzing && (
          <div className="flex items-center gap-2 text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-md">
            <Sparkles className="h-4 w-4 animate-pulse" />
            <span className="flex-1">{msg}</span>
          </div>
        )}
        {!analyzing && msg && (
          <p className="text-xs text-zinc-600 bg-zinc-50 px-3 py-2 rounded">{msg}</p>
        )}
      </CardContent>
    </Card>
  );
}
