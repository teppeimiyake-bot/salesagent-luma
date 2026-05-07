/**
 * ファイルストレージ抽象レイヤー（Vercel Blob / ローカル fallback）
 *
 * - 本番（Vercel）: 環境変数 BLOB_READ_WRITE_TOKEN が設定されていれば
 *   `@vercel/blob` 経由で Vercel Blob に保存。返り値は CDN 公開URL。
 * - ローカル開発: BLOB_READ_WRITE_TOKEN が空なら ./uploads/ に保存。
 *   返り値は `/uploads/<dir>/<filename>` という相対URL（既存DBデータと互換）。
 *
 * これにより、呼出側コードは「文字列URLが返ってくる」とだけ知っていればよい。
 * DBスキーマ（recordingUrl / fileUrl / avatarUrl の VARCHAR）も無変更で動く。
 *
 * フェーズ2-A 追加。
 */

import path from "node:path";
import fs from "node:fs/promises";

/** Vercel Blob モードが有効か（環境変数 BLOB_READ_WRITE_TOKEN の有無で判定）。 */
export function isBlobEnabled(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export interface PutOptions {
  /** 保存先ディレクトリ（先頭・末尾スラッシュ無し）。例: "recordings", "documents", "avatars"。 */
  dir: string;
  /** 拡張子（先頭ドット無し）。例: "webm", "pdf", "png"。 */
  ext: string;
  /** 元ファイル名（任意。Blob モード時のメタデータに使う） */
  originalName?: string;
  /** Content-Type（任意） */
  contentType?: string;
  /**
   * 公開アクセスにするか。Vercel Blob は現状 "public" のみ正式サポート。
   * 認証付きアクセスが必要なら署名URL方式に切り替える（将来対応）。
   */
  access?: "public";
}

export interface PutResult {
  /** クライアントから参照する URL。Blob 時は https://...blob.vercel-storage.com/...、ローカル時は /uploads/<dir>/<file>。 */
  url: string;
  /** バイト数 */
  size: number;
  /** 内部識別子（Blob 時は pathname、ローカル時は相対パス）。削除時に使用。 */
  pathname: string;
}

/**
 * ファイルを保存して公開 URL を返す。
 *
 * - Blob 有効時: `put(pathname, body, { access: "public" })` を呼び、CDN URL を返す
 * - 無効時: ./uploads/<dir>/ にファイル書き出し、`/uploads/<dir>/<filename>` を返す
 */
export async function putFile(buf: Buffer, opts: PutOptions): Promise<PutResult> {
  const safeName = `${Date.now()}_${randomHex(4)}.${opts.ext}`;
  const pathname = `${opts.dir}/${safeName}`;

  if (isBlobEnabled()) {
    // Vercel Blob 経由
    const { put } = await import("@vercel/blob");
    const blob = await put(pathname, buf, {
      access: opts.access ?? "public",
      contentType: opts.contentType,
      addRandomSuffix: false,
    });
    return {
      url: blob.url,
      size: buf.byteLength,
      pathname: blob.pathname,
    };
  }

  // ローカル fallback
  const root = process.env.UPLOAD_DIR ?? "./uploads";
  const dir = path.join(root, opts.dir);
  await fs.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, safeName);
  await fs.writeFile(filepath, buf);
  return {
    url: `/uploads/${pathname}`,
    size: buf.byteLength,
    pathname: `/uploads/${pathname}`,
  };
}

/**
 * 保存済みファイルを削除する。
 * - Blob モード: URL ベースで `del(url)`
 * - ローカル: `/uploads/...` 形式の URL or pathname を fs.unlink
 *
 * 失敗時はログ出力のみで例外は飛ばさない（呼出側の主処理を妨げないため）。
 */
export async function deleteFile(urlOrPathname: string): Promise<void> {
  try {
    if (urlOrPathname.startsWith("https://") || urlOrPathname.startsWith("http://")) {
      // Blob URL
      if (isBlobEnabled()) {
        const { del } = await import("@vercel/blob");
        await del(urlOrPathname);
      } else {
        console.warn("[storage] cannot delete remote URL without BLOB_READ_WRITE_TOKEN:", urlOrPathname);
      }
      return;
    }
    if (urlOrPathname.startsWith("/uploads/")) {
      // ローカル相対 URL
      const rel = urlOrPathname.replace(/^\/uploads\//, "");
      const root = process.env.UPLOAD_DIR ?? "./uploads";
      const filepath = path.join(root, rel);
      await fs.unlink(filepath).catch(() => {});
      return;
    }
    console.warn("[storage] unrecognized URL/pathname for delete:", urlOrPathname);
  } catch (e) {
    console.warn("[storage] delete failed:", e);
  }
}

/**
 * 文字起こし用に「ローカルファイルパス」を取得する（Gemini transcribeFile が
 * fs.readFile を期待しているため）。
 *
 * - ローカル URL `/uploads/...`: 物理パスに変換して返す
 * - Blob URL: Buffer をダウンロードして一時ファイルに書き、そのパスを返す
 *
 * 戻り値: { localPath, cleanup }（cleanup は一時ファイル削除関数。dev 時は no-op）
 */
export async function materializeForRead(
  url: string,
): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
  if (url.startsWith("/uploads/")) {
    const rel = url.replace(/^\/uploads\//, "");
    const root = process.env.UPLOAD_DIR ?? "./uploads";
    return {
      localPath: path.join(root, rel),
      cleanup: async () => {},
    };
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
    const ext = path.extname(new URL(url).pathname) || ".bin";
    const tmpPath = path.join(tmpDir, `blob_${Date.now()}_${randomHex(4)}${ext}`);
    await fs.writeFile(tmpPath, buf);
    return {
      localPath: tmpPath,
      cleanup: async () => {
        await fs.unlink(tmpPath).catch(() => {});
      },
    };
  }
  throw new Error(`Unknown URL scheme: ${url}`);
}

function randomHex(bytes: number): string {
  // 簡易ランダム（crypto への依存を分離するため）
  // 既存コードと衝突しない長さなので Math.random で十分
  let out = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < bytes * 2; i++) {
    out += chars[Math.floor(Math.random() * 16)];
  }
  return out;
}
