/**
 * ストレージ抽象化レイヤー（Luma版）
 *
 * 環境によって保存先を自動切り替え：
 *   - 本番（BLOB_READ_WRITE_TOKEN がある）→ Vercel Blob（**プライベートアクセス**）
 *   - dev（トークンなし）→ ローカル ./uploads/<dir>/<filename>
 *
 * 戻り値 / DB（`fileUrl` / `recordingUrl` / `avatarUrl`）に保存する値（= ストレージキー）：
 *   - Blob: "<dir>/<filename>"            ← blob の pathname。public URL ではない（プライベートストアなので URL 直アクセスは 401）
 *   - Local: "/uploads/<dir>/<filename>"  ← ローカル配信ルートのパス
 *
 * ファイル本体の取得（ダウンロード）は必ずアプリ側プロキシ（/api/.../download など）経由：
 *   - Blob: get(key, { access: 'private', token }) でストリーム取得
 *   - Local: ./uploads/<dir>/<filename> を fs.readFile
 *
 * 削除：
 *   - Blob: del(key, { token })（pathname 指定で削除可）
 *   - Local: 拡張子付きパスを fs.unlink
 *
 * 旧データ（public URL "https://...vercel-storage.com/..." が入っているレコード）も
 * 一応 fetchStored() / deleteFile() で扱えるようにしているが、ストアが private に切り替わったため
 * これらは認証なしでは取得できない（= 元々壊れている）。新規アップロード分が正しく動けば OK。
 */
import path from "node:path";
import fs from "node:fs/promises";

export interface PutOptions {
  /** 保存先サブディレクトリ（"avatars" / "documents" / "recordings"） */
  dir: string;
  /** 保存ファイル名（拡張子付き、ユニーク化済み） */
  filename: string;
  /** Bufferデータ */
  buffer: Buffer;
  /** Content-Type（Blobに渡す） */
  contentType?: string;
}

export interface PutResult {
  /** DB保存用のストレージキー（blob: pathname / local: /uploads/...） */
  url: string;
  /** ストレージ種別（デバッグ用） */
  storage: "blob" | "local";
}

/** BLOB_READ_WRITE_TOKEN を正規化して取得（前後空白・誤って付いた引用符を除去）。 */
export function blobToken(): string | undefined {
  const raw = process.env.BLOB_READ_WRITE_TOKEN;
  if (!raw) return undefined;
  const t = raw.trim().replace(/^["']|["']$/g, "");
  return t.length > 0 ? t : undefined;
}

/**
 * 本番モード判定。
 * BLOB_READ_WRITE_TOKEN が設定されていれば Vercel Blob を使う。
 * VERCEL=1 だけでもトークンが無ければ local fallback（ただし永続化されない）。
 */
export function isBlobEnabled(): boolean {
  return !!blobToken();
}

/** Vercel サーバレス環境で動いているか（ファイルシステムが読み取り専用 = /tmp 以外書けない）。 */
function isServerlessRuntime(): boolean {
  return !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

/** 呼び出し側で「設定不足によるアップロード不可」を判別できるエラー型。 */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

const BLOB_REQUIRED_MESSAGE =
  "ファイルストレージ（Vercel Blob）が未設定のため、本番環境ではアップロードできません。" +
  "Vercel ダッシュボード > Storage > Blob を作成し、BLOB_READ_WRITE_TOKEN を環境変数に注入してから再デプロイしてください。";

/** ストレージキーがローカル配信パスか（"/uploads/..."）。 */
export function isLocalKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith("/uploads/");
}

/** ストレージキーが旧 public blob URL か（"https://...vercel-storage.com/..."）。 */
export function isLegacyBlobUrl(key: string | null | undefined): boolean {
  return !!key && /^https?:\/\/.+\.vercel-storage\.com\//.test(key);
}

/**
 * ファイルを保存し、DB保存用のストレージキーを返す。
 *
 * - Blob トークンあり → Vercel Blob（access: 'private'）に保存。返り値 url は **pathname**（"documents/xxx.pdf"）
 * - Blob トークンなし & ローカル開発 → ./uploads/<dir>/<filename> に保存。返り値 url は "/uploads/<dir>/<filename>"
 * - Blob トークンなし & Vercel/サーバレス → StorageConfigError を投げる
 *   （/tmp 以外は読み取り専用で、書けても永続化・配信できないため。
 *    黙ってフォールバックすると「保存できたように見えて後で消える」最悪のUXになる）
 */
export async function putFile(opts: PutOptions): Promise<PutResult> {
  const { dir, filename, buffer, contentType } = opts;

  const token = blobToken();
  if (token) {
    // Vercel Blob（プライベートストア）
    const { put } = await import("@vercel/blob");
    const key = `${dir}/${filename}`;
    try {
      await put(key, buffer, {
        access: "private",
        contentType: contentType || "application/octet-stream",
        // 同名キーが既にあるケースに備えて一応 false（filename側でユニーク化済み）
        addRandomSuffix: false,
        token,
      });
      // private blob の url（https://...vercel-storage.com/...）は認証なしでは 401 になるため
      // DB には pathname（= ストレージキー）を保存し、取得は fetchStored() 経由で行う
      return { url: key, storage: "blob" };
    } catch (e) {
      const err = e as Error;
      // Blob API のエラーをそのまま投げると呼び出し側で詳細表示できる
      throw new Error(
        `Vercel Blob への書き込みに失敗しました [${err?.name ?? "Error"}]: ${err?.message ?? "unknown error"}`,
      );
    }
  }

  if (isServerlessRuntime()) {
    throw new StorageConfigError(BLOB_REQUIRED_MESSAGE);
  }

  // ローカル開発：./uploads/<dir>/<filename>
  const localDir = path.join(process.cwd(), "uploads", dir);
  try {
    await fs.mkdir(localDir, { recursive: true });
    const filepath = path.join(localDir, filename);
    await fs.writeFile(filepath, buffer);
  } catch (e) {
    throw new StorageConfigError(
      `ローカルストレージへの保存に失敗しました（${localDir}）: ${(e as Error).message}`,
    );
  }
  return { url: `/uploads/${dir}/${filename}`, storage: "local" };
}

/** 取得結果（プロキシでストリーム返却するための素材）。 */
export interface FetchedFile {
  buffer: Buffer;
  contentType: string | null;
  /** 取得元（デバッグ用） */
  source: "blob" | "local";
}

/**
 * DB保存済みのストレージキーからファイル本体を取得する（ダウンロードプロキシ用）。
 *
 * - "/uploads/..."          → ローカル FS から読む
 * - "https://...vercel-storage.com/..."（旧 public URL）→ 直 fetch（トークンがあれば Authorization 付き）
 * - それ以外（= blob pathname）→ get(key, { access: 'private', token })
 *
 * 見つからない / 取得失敗時は null（呼び出し側で 404）。
 */
export async function fetchStored(key: string | null | undefined): Promise<FetchedFile | null> {
  if (!key) return null;

  // ローカル配信パス
  if (isLocalKey(key)) {
    try {
      const safe = key
        .replace(/^\/uploads\//, "")
        .split("/")
        .map((p) => p.replace(/\.\.+/g, ""))
        .join("/");
      const filepath = path.join(process.cwd(), "uploads", safe);
      const buffer = await fs.readFile(filepath);
      return { buffer, contentType: null, source: "local" };
    } catch {
      return null;
    }
  }

  const token = blobToken();

  // 旧 public blob URL（ストア private 化前に保存されたもの）
  if (isLegacyBlobUrl(key)) {
    try {
      const res = await fetch(key, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
      if (!res.ok) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType: res.headers.get("content-type"), source: "blob" };
    } catch {
      return null;
    }
  }

  // blob pathname（"documents/xxx.pdf" 等）→ private get
  if (!token) return null;
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(key, { access: "private", token, useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const chunks: Uint8Array[] = [];
    const reader = result.stream.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { buffer, contentType: result.blob?.contentType ?? null, source: "blob" };
  } catch {
    return null;
  }
}

/**
 * 保存済みファイルを削除する。
 * key が "/uploads/..." ならローカル削除、"https://...vercel-storage.com/..." または blob pathname なら Blob削除。
 * 失敗しても例外は投げず警告のみ（レアケースで他要因と分かるため）。
 */
export async function deleteFile(key: string | null | undefined): Promise<void> {
  if (!key) return;
  // 旧仕様の "(リンク未登録)" 等は無視
  if (!isLocalKey(key) && !isLegacyBlobUrl(key) && key.includes(" ")) return;
  try {
    if (isLocalKey(key)) {
      const safe = key
        .replace(/^\/uploads\//, "")
        .split("/")
        .map((p) => p.replace(/\.\.+/g, ""))
        .join("/");
      const filepath = path.join(process.cwd(), "uploads", safe);
      await fs.unlink(filepath).catch(() => {});
      return;
    }
    // Blob削除（public URL でも pathname でも del() は受け付ける）
    const token = blobToken();
    if (!token) return;
    const { del } = await import("@vercel/blob");
    await del(key, { token });
  } catch (e) {
    console.warn("[storage.deleteFile] failed:", key, e);
  }
}

/**
 * 一時ファイルとして OS の tmp に書き出し、パスを返す。
 * Whisper / Gemini など「ローカルファイルパス」を要求するライブラリ向け。
 * 呼び出し側で削除する責任を持つ（cleanupTempFile を使う）。
 */
export async function writeTempFile(
  filename: string,
  buffer: Buffer,
): Promise<string> {
  const os = await import("node:os");
  const tmpDir = path.join(os.tmpdir(), "salesagent-luma");
  await fs.mkdir(tmpDir, { recursive: true });
  const filepath = path.join(tmpDir, `${Date.now()}_${filename}`);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

export async function cleanupTempFile(filepath: string): Promise<void> {
  try {
    await fs.unlink(filepath);
  } catch {
    /* ignore */
  }
}
