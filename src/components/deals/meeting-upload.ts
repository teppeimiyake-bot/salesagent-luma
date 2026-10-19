/**
 * 録音・録画の送信（録音カードと添付取り込みで共有）。
 * 24MBを超える音声・動画は、Cloud Run の1リクエスト上限を避けるため8MiBずつ分割して送る。
 * 分割アップロードを使えない環境（ローカル開発など）では従来の1回送信に戻る。
 */
import { DIRECT_UPLOAD_MAX_BYTES, fileExtension, isMediaAttachmentExtension } from "@/lib/meetings/upload-formats";

export type MeetingUploadResult =
  | { ok: true; status: number; json: Record<string, unknown> & { meeting?: Record<string, unknown>; transcriptionMode?: string } }
  | { ok: false; status: number; error: string };

const PART_RETRY_DELAYS_MS = [1000, 3000, 5000];
const RETRYABLE_STATUS = new Set([408, 429]);

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorText(json: unknown, status: number) {
  const record = json && typeof json === "object" ? json as { error?: unknown; debug?: { errorMessage?: unknown } } : null;
  if (typeof record?.error === "string") return record.error;
  if (typeof record?.debug?.errorMessage === "string") return record.debug.errorMessage;
  return `サーバーエラー (HTTP ${status})`;
}

async function directUpload(dealId: string, file: File, durationSec?: number): Promise<MeetingUploadResult> {
  const form = new FormData();
  form.append("dealId", dealId);
  form.append("file", file);
  if (durationSec && durationSec > 0) form.append("durationSec", String(durationSec));
  const response = await fetch("/api/meetings", { method: "POST", body: form });
  const json = await response.json().catch(() => null);
  return response.ok ? { ok: true, status: response.status, json: json ?? {} } : { ok: false, status: response.status, error: errorText(json, response.status) };
}

export async function uploadMeetingMedia({
  dealId,
  file,
  durationSec,
  onPartProgress,
  sleep = wait,
}: {
  dealId: string;
  file: File;
  durationSec?: number;
  onPartProgress?: (sentParts: number, totalParts: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MeetingUploadResult> {
  if (file.size <= DIRECT_UPLOAD_MAX_BYTES || !isMediaAttachmentExtension(fileExtension(file.name))) {
    return directUpload(dealId, file, durationSec);
  }

  const init = await fetch("/api/meetings/upload-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dealId, filename: file.name, size: file.size, ...(durationSec && durationSec > 0 ? { durationSec } : {}) }),
  });
  const session = await init.json().catch(() => null);
  if (init.status === 409 && session?.code === "UPLOAD_SESSION_UNAVAILABLE") return directUpload(dealId, file, durationSec);
  if (!init.ok || typeof session?.uploadId !== "string") return { ok: false, status: init.status, error: errorText(session, init.status) };

  const { uploadId, partBytes, totalParts } = session as { uploadId: string; partBytes: number; totalParts: number };
  for (let index = 0; index < totalParts; index++) {
    const part = file.slice(index * partBytes, Math.min(file.size, (index + 1) * partBytes));
    let sent = false;
    let lastError = "";
    // 一時的な回線断・混雑は間隔をあけて同じパートを送り直す（再送は上書き）。
    for (let attempt = 0; attempt <= PART_RETRY_DELAYS_MS.length && !sent; attempt++) {
      if (attempt > 0) await sleep(PART_RETRY_DELAYS_MS[attempt - 1]);
      try {
        const response = await fetch(`/api/meetings/upload-sessions/${uploadId}/parts/${index}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: part,
        });
        if (response.ok) sent = true;
        else {
          lastError = errorText(await response.json().catch(() => null), response.status);
          if (response.status < 500 && !RETRYABLE_STATUS.has(response.status)) break;
        }
      } catch {
        lastError = "通信に失敗しました。";
      }
    }
    if (!sent) return { ok: false, status: 0, error: `分割アップロードに失敗しました（${index + 1}/${totalParts}）: ${lastError}` };
    onPartProgress?.(index + 1, totalParts);
  }

  // 完了は同じ uploadId なら何度呼んでも記録は1件（サーバー側で冪等）。応答が失われた場合も再送する。
  let lastStatus = 0;
  let lastError = "通信に失敗しました。";
  for (let attempt = 0; attempt <= PART_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(PART_RETRY_DELAYS_MS[attempt - 1]);
    try {
      const complete = await fetch(`/api/meetings/upload-sessions/${uploadId}/complete`, { method: "POST" });
      const json = await complete.json().catch(() => null);
      if (complete.ok) return { ok: true, status: complete.status, json: json ?? {} };
      lastStatus = complete.status;
      lastError = errorText(json, complete.status);
      // 同時に届いた別の完了処理が記録を作成中の場合は、待って再送すれば作成済みの記録を受け取れる。
      const completing = complete.status === 409 && json?.code === "UPLOAD_COMPLETING";
      if (complete.status < 500 && !RETRYABLE_STATUS.has(complete.status) && !completing) break;
    } catch {
      lastStatus = 0;
      lastError = "通信に失敗しました。";
    }
  }
  return { ok: false, status: lastStatus, error: lastError };
}
