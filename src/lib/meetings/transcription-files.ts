/** T04/T22: 継続処理の作業ファイル（正規化音声・区間）の置き場所。 */
import path from "node:path";
import { localStoragePath } from "@/lib/storage";
import type { TranscriptionJob } from "./transcription-job";

export const NORMALIZED_AUDIO_FILE = "normalized.mp3";

/** Cloud Run では GCS FUSE 上に置き、インスタンスをまたいで再開できるようにする。 */
export function transcriptionWorkDir(meetingId: string) {
  const dir = /^[0-9a-zA-Z-]+$/.test(meetingId) ? localStoragePath(`/uploads/recordings/segments/${meetingId}`) : null;
  if (!dir) throw new Error("文字起こしの作業領域を確認できませんでした。");
  return dir;
}

/** 動画・分割アップロード・大容量の録音は、正規化した音声を再生用に使う。 */
export function playbackAudioPath(meetingId: string, job: TranscriptionJob | null) {
  return job?.playbackFile ? path.join(transcriptionWorkDir(meetingId), job.playbackFile) : null;
}
