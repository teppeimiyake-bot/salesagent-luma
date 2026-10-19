/**
 * T22: Cloud Run の1リクエスト上限（32MiB）を超える録画を、8MiBずつのパートで受け取る。
 *
 * パートは /uploads/recordings/parts/<uploadId>/ に置き、1つのファイルへは連結しない。
 * GCS FUSE に大きなファイルを書くとメモリ上に一時保存されるため、ffmpeg の concat
 * 入力で順に読み、文字起こし用の音声だけを作る。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { localStoragePath } from "@/lib/storage";

/** ミドルウェアが複製する本文の上限（10MB）より小さくする。 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
/** DB の audio_size_bytes（int4）に収まり、1時間超の会議録画も受け取れる上限。 */
export const UPLOAD_SESSION_MAX_BYTES = 2000 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MANIFEST_KEY = /^\/uploads\/recordings\/parts\/([0-9a-f-]{36})\/manifest\.json$/;

export type UploadSessionManifest = {
  version: 1;
  uploadId: string;
  dealId: string;
  userId: string;
  filename: string;
  extension: string;
  size: number;
  partBytes: number;
  totalParts: number;
  durationSec: number | null;
  createdAt: string;
  completedMeetingId?: string;
};

export function isUploadId(value: string) {
  return UPLOAD_ID.test(value);
}

export function uploadManifestKey(uploadId: string) {
  return `/uploads/recordings/parts/${uploadId}/manifest.json`;
}

export function isUploadManifestKey(key: string | null | undefined): boolean {
  return !!key && MANIFEST_KEY.test(key) && isUploadId(MANIFEST_KEY.exec(key)![1]);
}

function sessionDir(uploadId: string) {
  if (!isUploadId(uploadId)) throw new Error("invalid upload id");
  const dir = localStoragePath(`/uploads/recordings/parts/${uploadId}`);
  if (!dir) throw new Error("upload storage unavailable");
  return dir;
}

export function uploadPartPath(uploadId: string, index: number) {
  return path.join(sessionDir(uploadId), `part-${String(index).padStart(5, "0")}`);
}

export function expectedPartBytes(manifest: UploadSessionManifest, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.totalParts) return null;
  return index === manifest.totalParts - 1 ? manifest.size - manifest.partBytes * index : manifest.partBytes;
}

export function createUploadManifest(input: Omit<UploadSessionManifest, "version" | "partBytes" | "totalParts" | "createdAt">, now: Date): UploadSessionManifest {
  return {
    version: 1,
    ...input,
    partBytes: UPLOAD_PART_BYTES,
    totalParts: Math.ceil(input.size / UPLOAD_PART_BYTES),
    createdAt: now.toISOString(),
  };
}

export async function writeUploadManifest(manifest: UploadSessionManifest) {
  const dir = sessionDir(manifest.uploadId);
  await fs.mkdir(dir, { recursive: true });
  // 一時ファイルに書いてから置き換え、読み手が書きかけのマニフェストを読まないようにする。
  const temp = path.join(dir, `manifest.${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(manifest));
  await fs.rename(temp, path.join(dir, "manifest.json"));
}

export async function readUploadManifest(uploadId: string): Promise<UploadSessionManifest | null> {
  if (!isUploadId(uploadId)) return null;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(sessionDir(uploadId), "manifest.json"), "utf8")) as UploadSessionManifest;
    if (manifest?.version !== 1 || manifest.uploadId !== uploadId || !Number.isSafeInteger(manifest.size) || manifest.size < 1
      || manifest.size > UPLOAD_SESSION_MAX_BYTES || manifest.partBytes !== UPLOAD_PART_BYTES
      || manifest.totalParts !== Math.ceil(manifest.size / UPLOAD_PART_BYTES)) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function uploadSessionExpired(manifest: UploadSessionManifest, now = Date.now()) {
  const created = Date.parse(manifest.createdAt);
  return !Number.isFinite(created) || now - created > UPLOAD_SESSION_TTL_MS;
}

/** 全パートがそろい、サイズが宣言どおりか。欠けているパート番号を返す。 */
export async function missingUploadParts(manifest: UploadSessionManifest): Promise<number[]> {
  const missing: number[] = [];
  for (let index = 0; index < manifest.totalParts; index++) {
    try {
      const stat = await fs.stat(uploadPartPath(manifest.uploadId, index));
      if (!stat.isFile() || stat.size !== expectedPartBytes(manifest, index)) missing.push(index);
    } catch {
      missing.push(index);
    }
  }
  return missing;
}

/** 分割アップロードの録音キーから、ffmpeg に順に渡すパートのパスを得る。 */
export async function uploadPartPathsForKey(key: string): Promise<{ paths: string[]; manifest: UploadSessionManifest } | null> {
  const match = MANIFEST_KEY.exec(key);
  if (!match) return null;
  const manifest = await readUploadManifest(match[1]);
  if (!manifest) return null;
  return { manifest, paths: Array.from({ length: manifest.totalParts }, (_, index) => uploadPartPath(manifest.uploadId, index)) };
}

/**
 * 商談記録の削除時に、分割アップロードのフォルダ（パート・マニフェスト・完了ロック）をまとめて消す。
 * 分割アップロードの録音キーでなければ何もせず false を返す。
 */
export async function removeUploadSessionForKey(key: string): Promise<boolean> {
  const match = MANIFEST_KEY.exec(key);
  if (!match || !isUploadId(match[1])) return false;
  await fs.rm(sessionDir(match[1]), { recursive: true, force: true });
  return true;
}

/**
 * 完了処理の排他。同じ uploadId の完了が同時に来ても、商談記録を1件だけ作る。
 * 取得できなければ false（別の完了処理が進行中か完了済み）。
 */
export async function acquireUploadCompletion(uploadId: string) {
  try {
    const handle = await fs.open(path.join(sessionDir(uploadId), "complete.lock"), "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function releaseUploadCompletion(uploadId: string) {
  await fs.rm(path.join(sessionDir(uploadId), "complete.lock"), { force: true }).catch(() => {});
}

/**
 * 期限（24時間）を過ぎて完了しなかった分割アップロードのパートを消す。
 * 消すのは、マニフェストを正しく読めて、未完了・期限切れ・完了処理のロックなしの場合だけ。
 * 読めない・検証に落ちるものは、完了済みの録音本体かもしれないので消さない（GCS FUSE はディレクトリの
 * 更新時刻を持たないため、時刻での推定もしない）。確認は毎回少数だけ、開始位置を変えて行う。
 */
export async function removeExpiredUploadSessions(now = Date.now(), maxChecks = 30, start = Math.random()) {
  const root = localStoragePath("/uploads/recordings/parts");
  if (!root) return 0;
  let removed = 0;
  const names = (await fs.readdir(root).catch(() => [] as string[])).filter(isUploadId);
  const offset = Math.floor(start * names.length);
  for (let i = 0; i < Math.min(maxChecks, names.length); i++) {
    const name = names[(offset + i) % names.length];
    if (await fs.stat(path.join(root, name, "complete.lock")).then(() => true, () => false)) continue;
    const manifest = await readUploadManifest(name);
    if (!manifest || manifest.completedMeetingId || !uploadSessionExpired(manifest, now)) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}
