/** 記録カードに出す録音の長さ・サイズの表示（純粋な関数。画面とテストで共用）。 */

export function fmtBytes(bytes: number | null | undefined): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(sec: number | null | undefined): string | null {
  if (!sec) return null;
  const min = Math.floor(sec / 60);
  const rest = String(sec % 60).padStart(2, "0");
  return `${min}:${rest}`;
}

/**
 * 処理状態欄の「録音時間 2:30 / サイズ 484 KB」。区切りの「/」は両方あるときだけ付ける
 * （テキスト添付のように録音時間が無い記録で「/ サイズ 2 KB」とならないように）。どちらも無ければ null。
 */
export function recordingFactsLabel(durationSec: number | null | undefined, bytes: number | null | undefined): string | null {
  const duration = fmtDuration(durationSec);
  const size = fmtBytes(bytes);
  const parts = [duration && `録音時間 ${duration}`, size && `サイズ ${size}`].filter((part): part is string => !!part);
  return parts.length ? parts.join(" / ") : null;
}
