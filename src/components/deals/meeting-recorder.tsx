"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  Headphones,
  Mic,
  MonitorSpeaker,
  RotateCcw,
  Square,
  Upload,
} from "lucide-react";
import { uploadMeetingMedia } from "./meeting-upload";

const subscribeBrowser = () => () => {};
function isChromeLike() {
  const ua = navigator.userAgent;
  return (/Chrome|Chromium/.test(ua) || /Edg\//.test(ua)) && !/Firefox/.test(ua);
}

type RecorderMode = "mic" | "tab";
type BackupMeta = {
  dealId: string;
  mode: RecorderMode;
  mimeType: string;
  startedAt: number;
  updatedAt: number;
  seconds: number;
  chunkCount: number;
  totalBytes: number;
};
type BackupChunk = {
  key: string;
  dealId: string;
  seq: number;
  blob: Blob;
  size: number;
};

type ProcessingSnapshot = {
  processingStatus?: string;
  processingError?: string | null;
  hasTranscript?: boolean;
};

const AUDIO_BITS_PER_SECOND = 32_000;
const BACKUP_DB_NAME = "reeasy-meeting-recorder";
const BACKUP_DB_VERSION = 1;
const BACKUP_META_STORE = "recordings";
const BACKUP_CHUNK_STORE = "chunks";

async function waitForTranscript(
  meetingId: string,
  onTick: (elapsedSec: number, status: string | null) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const started = Date.now();
  const timeoutMs = 15 * 60 * 1000;

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`/api/meetings/${meetingId}/status`, { cache: "no-store" });
    const json = await response.json().catch(() => null);
    const meeting = json?.meeting as ProcessingSnapshot | undefined;

    if (meeting?.hasTranscript) return { ok: true };
    if (meeting?.processingStatus === "error") {
      return { ok: false, error: meeting.processingError ?? "文字起こしに失敗しました" };
    }

    onTick(Math.round((Date.now() - started) / 1000), meeting?.processingStatus ?? null);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return {
    ok: false,
    error: "文字起こしがタイムアウトしました。商談履歴から「文字起こし再実行」を試してください。",
  };
}

/**
 * ライブ商談録音（マイク／タブ音声）。対面・先方Meet／Zoom・会議種別未選択の例外経路と、自動記録が OFF
 * （FEATURE_MEET_AUTO_RECORD 未設定・切り戻し時）の自社発行Meetで使う。
 * 自動記録が動く自社発行Meetの商談ページには置かない（T16 AC8。救済は手動添付だけ）。
 */
export function MeetingRecorder({ dealId }: { dealId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<RecorderMode>("mic");
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(false);
  const backupWrites = useRef<Promise<void>>(Promise.resolve());
  const [seconds, setSeconds] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [backup, setBackup] = useState<BackupMeta | null>(null);
  const [restoring, setRestoring] = useState(false);
  const chromeLike = useSyncExternalStore(subscribeBrowser, isChromeLike, () => true);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqRef = useRef(0);
  const activeMimeRef = useRef("audio/webm");
  const durationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    refreshBackup();
    return () => { mountedRef.current = false; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  function stopAll() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      } catch {
        // noop
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  async function refreshBackup() {
    try {
      const meta = await getBackupMeta(dealId);
      if (mountedRef.current) setBackup(meta);
    } catch {
      if (mountedRef.current) setMsg("録音バックアップを読み込めません。ブラウザーの保存領域を確認してください。");
    }
  }

  async function start(nextMode = mode) {
    if (startingRef.current || recording || analyzing || restoring) return;
    setMsg(null);
    if (!ensureRecordingSupport(nextMode)) return;
    if (backup?.chunkCount) {
      setMsg("前回の録音を復元して送信するか、破棄してから新しく録音してください。");
      return;
    }
    startingRef.current = true;
    setStarting(true);

    try {
      const stream = nextMode === "mic" ? await getMicStream() : await getTabAudioStream();

      streamRef.current = stream;
      if (!mountedRef.current) { stopAll(); return; }
      const previous = await getBackupMeta(dealId);
      if (previous?.chunkCount) throw new Error("前回の録音を復元または破棄してから開始してください。");
      await clearBackup(dealId);
      setBackup(null);
      seqRef.current = 0;
      chunksRef.current = [];

      streamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      activeMimeRef.current = mime;

      await initBackup({
        dealId,
        mode: nextMode,
        mimeType: mime,
        startedAt: Date.now(),
      });

      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      rec.ondataavailable = (e) => {
        if (e.data.size <= 0) return;
        chunksRef.current.push(e.data);
        const seq = seqRef.current++;
        backupWrites.current = backupWrites.current
          .then(() => appendBackupChunk(dealId, seq, e.data))
          .then(refreshBackup)
          .catch(() => { if (mountedRef.current) setMsg("バックアップの保存に失敗しました。この画面を閉じずに停止して送信してください。"); });
      };
      rec.onstop = async () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        setRecording(false);
        setAnalyzing(true);
        await backupWrites.current;
        if (mountedRef.current) await uploadFromChunks(chunksRef.current, activeMimeRef.current);
      };
      rec.start(500);

      recorderRef.current = rec;
      setMode(nextMode);
      setRecording(true);
      setSeconds(0);
      durationRef.current = 0;
      timerRef.current = setInterval(
        () =>
          setSeconds((s) => {
            const next = s + 1;
            durationRef.current = next;
            return next;
          }),
        1000,
      );
    } catch (e) {
      stopAll();
      setMsg(`録音開始に失敗しました: ${(e as Error).message}`);
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }

  async function getMicStream() {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  async function getTabAudioStream() {
    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error("このブラウザはタブ音声録音に対応していません。Chrome / Edge を使ってください。");
    }
    const ds = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1, height: 1 },
      audio: true,
    });
    const audioTracks = ds.getAudioTracks();
    if (audioTracks.length === 0) {
      ds.getTracks().forEach((t) => t.stop());
      throw new Error("タブ音声を取得できませんでした。共有時に「タブの音声を共有」をオンにしてください。");
    }
    ds.getVideoTracks().forEach((t) => t.stop());
    return new MediaStream(audioTracks);
  }

  function ensureRecordingSupport(nextMode: RecorderMode) {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMsg("この環境では録音が使えません。localhost または https:// で Chrome / Edge から開いてください。");
      return false;
    }
    if (typeof MediaRecorder === "undefined") {
      setMsg("このブラウザはMediaRecorderに対応していません。Chrome / Edge を使ってください。");
      return false;
    }
    if (nextMode === "tab" && !navigator.mediaDevices.getDisplayMedia) {
      setMsg("このブラウザはタブ音声共有に対応していません。Chrome / Edge を使ってください。");
      return false;
    }
    return true;
  }

  function stop() {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  async function restoreAndUpload() {
    if (startingRef.current || recording || analyzing || restoring) return;
    setRestoring(true);
    setMsg("前回の録音を復元しています...");
    try {
      const restored = await readBackup(dealId);
      if (!restored || restored.chunks.length === 0) {
        setMsg("復元できる録音がありません。");
        setBackup(null);
        return;
      }
      await uploadFromChunks(restored.chunks, restored.meta.mimeType, true, restored.meta.seconds);
    } catch (e) {
      setMsg(`復元に失敗しました: ${(e as Error).message}`);
    } finally {
      setRestoring(false);
    }
  }

  async function discardBackup() {
    try {
      await clearBackup(dealId);
      setBackup(null);
      setMsg("前回の録音バックアップを破棄しました。");
    } catch { setMsg("バックアップを破棄できませんでした。再試行してください。"); }
  }

  async function uploadFromChunks(
    chunks: Blob[],
    mimeType: string,
    restored = false,
    durationSec = durationRef.current,
  ) {
    setAnalyzing(true);
    try {
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size === 0) {
        setMsg("録音データが空でした。マイクやタブ音声の共有設定を確認して、もう一度試してください。");
        setAnalyzing(false);
        return;
      }
      const uploadLabel = `${restored ? "復元した録音" : "録音"}をアップロード中... (${(blob.size / 1024).toFixed(0)} KB)`;
      setMsg(uploadLabel);
      const file = new File([blob], `recording_${Date.now()}.webm`, { type: mimeType || "audio/webm" });
      const uploaded = await uploadMeetingMedia({
        dealId,
        file,
        durationSec,
        onPartProgress: (sent, total) => setMsg(`${uploadLabel} ${sent}/${total}`),
      });
      const j = uploaded.ok ? uploaded.json as { meeting?: Record<string, unknown> & { id?: string }; transcriptionMode?: string } : null;
      if (!uploaded.ok || typeof j?.meeting?.id !== "string") {
        setMsg(`アップロード失敗: ${uploaded.ok ? "サーバーエラー" : uploaded.error}`);
        setAnalyzing(false);
        await refreshBackup();
        return;
      }

      // 受付済みの時点でバックアップを消す。以後の失敗は商談履歴から再開・再実行でき、再送による重複を防ぐ。
      await clearBackup(dealId);
      setBackup(null);
      const meetingId = j.meeting.id;
      router.refresh();

      if (j.transcriptionMode === "job") {
        // T04: Cloud Run では受付だけ即時に返る。区間ごとの文字起こしと議事録・BANTの分析は、
        // 商談履歴が継続処理で進める。ここで待たないので、続けて次の録音を始められる。
        setMsg("受付完了。文字起こしと議事録・BANTの作成は自動で進みます。この画面を閉じても処理は続き、進捗と結果は下の「商談履歴」に表示されます。");
        return;
      }

      const initialStatus = j.meeting as ProcessingSnapshot;
      if (initialStatus.processingStatus === "error") {
        setMsg(`文字起こしに失敗しました: ${initialStatus.processingError ?? "unknown"}`);
        return;
      }

      if (!initialStatus.hasTranscript && !j.meeting.transcript) {
        setMsg("文字起こし中...（完了後に議事録を自動生成します）");
        const transcript = await waitForTranscript(meetingId, (elapsedSec, status) => {
          const label = status === "uploaded" ? "処理開始待ち" : "文字起こし中";
          setMsg(`${label}...（${elapsedSec}秒）完了後に議事録を自動生成します`);
        });
        if (!transcript.ok) {
          setMsg(`文字起こしに失敗しました: ${transcript.error}`);
          router.refresh();
          return;
        }
      }

      setMsg("文字起こし完了。議事録を分析中...");
      const analysisRequest = fetch(`/api/meetings/${meetingId}/analyze`, { method: "POST" });
      router.refresh();
      const analysisResponse = await analysisRequest;
      const analysisJson = await analysisResponse.json().catch(() => null);
      if (!analysisResponse.ok) {
        setMsg(`文字起こしは完了しましたが分析に失敗: ${analysisJson?.error ?? `HTTP ${analysisResponse.status}`}`);
        router.refresh();
        return;
      }

      setMsg("録音処理が完了しました。文字起こしと議事録を確認できます。");
      router.refresh();
      setTimeout(() => setMsg(null), 3000);
    } catch (e) {
      setMsg(`アップロード中にエラー: ${(e as Error).message}`);
      await refreshBackup();
    } finally {
      setAnalyzing(false);
    }
  }

  function fmtTime(s: number) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <div className="rounded-lg bg-zinc-100 p-1.5 text-zinc-500">
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
        {backup && !recording && !analyzing && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-2">
                <p className="font-semibold">
                  前回の録音バックアップがあります（{fmtTime(backup.seconds)} / {(backup.totalBytes / 1024).toFixed(0)} KB）。
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="outline" onClick={restoreAndUpload} disabled={starting || restoring}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {restoring ? "復元中..." : "復元して送信"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={discardBackup} disabled={starting || restoring}>
                    破棄
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant={mode === "mic" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("mic")}
            disabled={recording}
          >
            <Mic className="h-3.5 w-3.5" />
            マイクのみ
          </Button>
          <Button
            variant={mode === "tab" ? "primary" : "outline"}
            size="sm"
            onClick={() => setMode("tab")}
            disabled={recording}
          >
            <MonitorSpeaker className="h-3.5 w-3.5" />
            タブ音声
          </Button>
        </div>

        <p className="text-[13px] text-zinc-600 leading-relaxed">
          {mode === "mic"
            ? "マイクのみで録音します。オンライン会議で相手の声も録る場合はタブ音声を使ってください。"
            : "Chrome / Edge推奨です。共有ダイアログで録音したいタブを選び、「タブの音声を共有」をオンにしてください。"}
          {!chromeLike && " タブ音声録音はChrome / Edge以外では動かない場合があります。"}
        </p>
        <p className="text-[12.5px] text-zinc-500">
          録音は32kbpsで保存します。録音中は約0.5秒ごとにブラウザ内へバックアップします。
        </p>

        {!recording ? (
          <Button variant="primary" onClick={() => start(mode)} disabled={starting || analyzing || restoring || Boolean(backup?.chunkCount)}>
            <Mic className="h-4 w-4" />
            {starting ? "録音準備中..." : analyzing ? "処理中..." : "録音開始"}
          </Button>
        ) : (
          <Button variant="destructive" onClick={stop}>
            <Square className="h-4 w-4" />
            停止して送信
          </Button>
        )}

        {(analyzing || restoring) && (
          <div className="flex items-center gap-2 text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-md">
            <Upload className="h-4 w-4 animate-pulse" />
            <span className="flex-1">{msg}</span>
          </div>
        )}
        {!analyzing && !restoring && msg && (
          <p className="text-[13px] text-zinc-600 bg-zinc-50 px-3 py-2 rounded">{msg}</p>
        )}
      </CardContent>
    </Card>
  );
}

function openBackupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BACKUP_META_STORE)) {
        db.createObjectStore(BACKUP_META_STORE, { keyPath: "dealId" });
      }
      if (!db.objectStoreNames.contains(BACKUP_CHUNK_STORE)) {
        const chunks = db.createObjectStore(BACKUP_CHUNK_STORE, { keyPath: "key" });
        chunks.createIndex("dealId", "dealId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function initBackup(input: { dealId: string; mode: RecorderMode; mimeType: string; startedAt: number }) {
  const db = await openBackupDb();
  await runStore(db, BACKUP_META_STORE, "readwrite", (store) => {
    store.put({
      dealId: input.dealId,
      mode: input.mode,
      mimeType: input.mimeType,
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      seconds: 0,
      chunkCount: 0,
      totalBytes: 0,
    } satisfies BackupMeta);
  });
  db.close();
}

async function appendBackupChunk(dealId: string, seq: number, blob: Blob) {
  const db = await openBackupDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([BACKUP_META_STORE, BACKUP_CHUNK_STORE], "readwrite");
    const metaStore = tx.objectStore(BACKUP_META_STORE);
    const chunkStore = tx.objectStore(BACKUP_CHUNK_STORE);
    chunkStore.put({ key: `${dealId}:${seq}`, dealId, seq, blob, size: blob.size } satisfies BackupChunk);
    const metaReq = metaStore.get(dealId);
    metaReq.onsuccess = () => {
      const meta = metaReq.result as BackupMeta | undefined;
      if (!meta) return;
      const now = Date.now();
      meta.updatedAt = now;
      meta.seconds = Math.max(0, Math.round((now - meta.startedAt) / 1000));
      meta.chunkCount += 1;
      meta.totalBytes += blob.size;
      metaStore.put(meta);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("録音の保存が中断されました"));
  });
  db.close();
}

async function getBackupMeta(dealId: string): Promise<BackupMeta | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openBackupDb();
  const meta = await getFromStore<BackupMeta>(db, BACKUP_META_STORE, dealId);
  db.close();
  return meta ?? null;
}

async function readBackup(dealId: string): Promise<{ meta: BackupMeta; chunks: Blob[] } | null> {
  const db = await openBackupDb();
  const meta = await getFromStore<BackupMeta>(db, BACKUP_META_STORE, dealId);
  if (!meta) {
    db.close();
    return null;
  }
  const chunks = await new Promise<BackupChunk[]>((resolve, reject) => {
    const tx = db.transaction(BACKUP_CHUNK_STORE, "readonly");
    const req = tx.objectStore(BACKUP_CHUNK_STORE).index("dealId").getAll(dealId);
    req.onsuccess = () => resolve((req.result as BackupChunk[]).sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
  db.close();
  return { meta, chunks: chunks.map((c) => c.blob) };
}

async function clearBackup(dealId: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openBackupDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([BACKUP_META_STORE, BACKUP_CHUNK_STORE], "readwrite");
    tx.objectStore(BACKUP_META_STORE).delete(dealId);
    const indexReq = tx.objectStore(BACKUP_CHUNK_STORE).index("dealId").getAllKeys(dealId);
    indexReq.onsuccess = () => {
      const chunkStore = tx.objectStore(BACKUP_CHUNK_STORE);
      for (const key of indexReq.result) chunkStore.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("録音の保存が中断されました"));
  });
  db.close();
}

function getFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function runStore(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("録音の保存が中断されました"));
  });
}
