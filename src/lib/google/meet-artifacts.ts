/**
 * Google Meet 成果物（自動録画・自動文字起こし）連携（T16）
 *
 * Calendar API で Meet URL を発行する `./meet.ts` の上に乗る層。
 * Meet REST v2（`google.meet({version:"v2"})`）を使い、
 *   1) Meet URL → スペース解決
 *   2) スペースの自動録画・自動文字起こしをON（設定後に読み戻して確認）
 *   3) 会議終了後の会議記録・文字起こしを取得して1本のテキストに整形
 * までを担当する。認証は `./meet.ts` の createMeetOAuthClient を使い回す
 * （同じ OAuth クライアント／リフレッシュトークンで動かすため、複製しない）。
 */
import { google, type meet_v2 } from "googleapis";
import { GoogleMeetOperationError, createMeetOAuthClient } from "./meet";
import type { SelectedConferenceRecord } from "@/lib/meetings/conference-record-selection";
import { normalizeMeetTranscriptSpacing } from "@/lib/meetings/timed-transcript";

/**
 * Meet連携に必要なOAuthスコープ一式。
 * scripts/google-meet-auth.ts から参照する（同じ配列を二か所に書かないため）。
 * calendar.events だけだった頃のリフレッシュトークンでは足りないので、
 * このリストを増やしたら必ず再同意（トークン再発行）が要る。
 * Drive は使わない（文字起こしは Meet API の発言一覧、ドキュメントの URL も Meet API の応答から取る）。
 * Drive 全体を読める drive.readonly は Gmail の読み取りと同じ区分の広い権限なので要求しない（2026-09-30、T23）。
 */
export const MEET_OAUTH_SCOPES: string[] = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "https://www.googleapis.com/auth/meetings.space.readonly",
];

export type MeetArtifactConfigResult = {
  spaceName: string;
  recordingOn: boolean;
  transcriptionOn: boolean;
};

export type NormalizedTranscriptSegment = {
  speaker: string;
  startAt: string | null;
  endAt: string | null;
  text: string;
};

export type FetchedMeetTranscript = {
  conferenceRecordId: string;
  transcriptName: string;
  docUrl: string | null;
  segments: NormalizedTranscriptSegment[];
  text: string;
  startTime: string | null;
  endTime: string | null;
};

/** Meet REST v2 クライアント。呼び出しのたびに遅延生成する（モジュール読み込み時に env を要求しないため）。 */
function meetClient() {
  const auth = createMeetOAuthClient(true);
  return google.meet({ version: "v2", auth });
}

/** Google 由来の例外を日本語メッセージの GoogleMeetOperationError に包む。 */
function wrap(error: unknown, context: string): never {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  throw new GoogleMeetOperationError(`${context}（Google Meet API エラー: ${detail}）`);
}

/**
 * `https://meet.google.com/abc-mnop-xyz` → `abc-mnop-xyz`
 * クエリ文字列・末尾スラッシュを許容し、Meet以外のURLは null を返す。
 */
export function meetingCodeFromMeetUrl(meetUrl: string | null | undefined): string | null {
  if (!meetUrl || typeof meetUrl !== "string") return null;
  const trimmed = meetUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/(^|\.)meet\.google\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const code = segments[segments.length - 1];
  if (!code) return null;
  // 会議コードは英字とハイフンのみ（lookup などのパスを弾く）
  if (!/^[a-z]{3,}(-[a-z]{3,}){1,}$/i.test(code)) return null;
  return code;
}

/** Meet URL から正規のスペース名（"spaces/xxx"）を解決する。 */
export async function resolveMeetSpace(
  meetUrl: string,
): Promise<{ name: string; meetingCode: string | null }> {
  const code = meetingCodeFromMeetUrl(meetUrl);
  if (!code) {
    throw new GoogleMeetOperationError(
      `Meet URL から会議コードを取得できませんでした（${meetUrl}）。`,
    );
  }

  try {
    const res = await meetClient().spaces.get({ name: `spaces/${code}` });
    const name = res.data.name;
    if (!name) {
      throw new GoogleMeetOperationError("Meetスペース名が取得できませんでした。");
    }
    return { name, meetingCode: res.data.meetingCode ?? code };
  } catch (error) {
    if (error instanceof GoogleMeetOperationError) throw error;
    return wrap(error, "Meetスペースの解決に失敗しました");
  }
}

/**
 * スペースの自動録画・自動文字起こしをONにする。
 * patch しただけでは「設定できたつもり」になり得るので、必ず読み戻して ON を確認する。
 */
export async function enableAutoArtifacts(spaceName: string): Promise<MeetArtifactConfigResult> {
  const meet = meetClient();
  const updateMask = [
    "config.artifactConfig.recordingConfig.autoRecordingGeneration",
    "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration",
  ].join(",");

  try {
    await meet.spaces.patch({
      name: spaceName,
      updateMask,
      requestBody: {
        config: {
          artifactConfig: {
            recordingConfig: { autoRecordingGeneration: "ON" },
            transcriptionConfig: { autoTranscriptionGeneration: "ON" },
          },
        },
      },
    });
  } catch (error) {
    return wrap(error, "Meetの自動録画・自動文字起こし設定に失敗しました");
  }

  let recordingOn = false;
  let transcriptionOn = false;
  try {
    const res = await meet.spaces.get({ name: spaceName });
    const artifact = res.data.config?.artifactConfig;
    recordingOn = artifact?.recordingConfig?.autoRecordingGeneration === "ON";
    transcriptionOn = artifact?.transcriptionConfig?.autoTranscriptionGeneration === "ON";
  } catch (error) {
    return wrap(error, "Meet設定の確認（読み戻し）に失敗しました");
  }

  if (!recordingOn || !transcriptionOn) {
    throw new GoogleMeetOperationError(
      "Meet設定を反映できませんでした（自動録画: " +
        (recordingOn ? "ON" : "OFF") +
        " / 自動文字起こし: " +
        (transcriptionOn ? "ON" : "OFF") +
        "）。Google Workspace のエディションと管理コンソールの録画・文字起こし許可を確認してください。",
    );
  }

  return { spaceName, recordingOn, transcriptionOn };
}

/**
 * スペースの会議記録を一覧する。進行中（endTime なし）の記録も含めて返す。
 * どれをこの商談の会議とみなすか（予定との重なり・進行中の記録の扱い・取り込み済みの会議との比較）は
 * conference-record-selection.ts の chooseConferenceRecord に一本化しているので、ここでは絞り込まない。
 * 会議記録は会議終了から30日で消えるため、見つからない＝まだ終わっていない、とは限らない。
 */
export async function listConferenceRecords(spaceName: string): Promise<SelectedConferenceRecord[]> {
  try {
    const res = await meetClient().conferenceRecords.list({
      filter: `space.name = "${spaceName}"`,
    });
    return (res.data.conferenceRecords ?? []).flatMap((record) =>
      record.name
        ? [{ name: record.name, startTime: record.startTime ?? null, endTime: record.endTime ?? null }]
        : [],
    );
  } catch (error) {
    return wrap(error, "Meet会議記録の取得に失敗しました");
  }
}

/** transcripts.entries.list が返す発言1件のうち、正規化に必要な部分だけ。 */
export type RawTranscriptEntry = {
  name?: string | null;
  participant?: string | null;
  text?: string | null;
  languageCode?: string | null;
  startTime?: string | null;
  endTime?: string | null;
};

/**
 * 発言配列を「話者名: 本文」の素テキストと構造化配列に正規化する（純関数・テスト対象）。
 * 話者名が解決できない参加者には、出現順に 話者1 / 話者2 … の安定ラベルを割り当てる。
 * 本文が空の発言は捨てる（AIパイプラインに空行を渡さないため）。
 * 本文は数字と日本語の間などの空白を詰める（normalizeMeetTranscriptSpacing）。保存する文字起こしと発言配列は同じ本文になる。
 */
export function normalizeTranscriptEntries(
  entries: RawTranscriptEntry[],
  participantNames: Map<string, string>,
): { segments: NormalizedTranscriptSegment[]; text: string } {
  const fallbackLabels = new Map<string, string>();
  const segments: NormalizedTranscriptSegment[] = [];

  for (const entry of entries) {
    const text = normalizeMeetTranscriptSpacing((entry.text ?? "").trim());
    if (!text) continue;

    const participant = entry.participant ?? "";
    let speaker = participant ? participantNames.get(participant) : undefined;
    if (!speaker) {
      const known = participant ? fallbackLabels.get(participant) : undefined;
      if (known) {
        speaker = known;
      } else {
        const label = `話者${fallbackLabels.size + 1}`;
        if (participant) fallbackLabels.set(participant, label);
        speaker = label;
      }
    }

    segments.push({
      speaker,
      startAt: entry.startTime ?? null,
      endAt: entry.endTime ?? null,
      text,
    });
  }

  const text = segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  return { segments, text };
}

/**
 * 文字起こしの完成（Google ドキュメントの生成、FILE_GENERATED）の前に読むと、発言の一覧がまだそろっていないことがある
 * （2026-09-30 の実 Meet で、会議の終了の約2.5分後に読んだら最後の発言が無かった。後で9件中8件と分かった）。
 * 文字起こしは停止・再開のたびに別になる（Meet の仕様）ため、会議のすべての文字起こしがそろってから読む。
 * そろったとは、それぞれが完成しているか、終了（終了時刻が無ければ会議の終了）から30分たっていること。
 * 30分たっても完成しない（ドキュメントの生成に失敗したなど）ときは、その時点の本文を使う。
 */
export const TRANSCRIPT_COMPLETION_GRACE_MS = 30 * 60 * 1000;

export function transcriptsReady<T extends { state?: string | null; endTime?: string | null }>(
  transcripts: T[],
  conferenceEndTime: string | null | undefined,
  now: number = Date.now(),
): boolean {
  return transcripts.length > 0 && transcripts.every((t) => {
    if (t.state === "FILE_GENERATED") return true;
    const endedAt = Date.parse(t.endTime ?? conferenceEndTime ?? "");
    return Number.isFinite(endedAt) && now - endedAt >= TRANSCRIPT_COMPLETION_GRACE_MS;
  });
}

/**
 * 会議記録の文字起こしを取得する。
 * - 会議のすべての文字起こしがそろってから（transcriptsReady）、一覧の順（開始時刻の昇順）に発言をつなげて読む
 * - 文字起こしの一覧・entries はページを最後まで辿る
 * - 参加者表示名は participants.get をキャッシュしながら解決する
 * まだ文字起こしが存在しない・そろっていない場合は null（＝待ち）を返す。
 */
export async function fetchMeetTranscript(
  conferenceRecordName: string,
  conferenceEndTime?: string | null,
): Promise<FetchedMeetTranscript | null> {
  const meet = meetClient();

  const transcripts: meet_v2.Schema$Transcript[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const res = await meet.conferenceRecords.transcripts.list({ parent: conferenceRecordName, pageSize: 100, pageToken });
      transcripts.push(...(res.data.transcripts ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (error) {
    return wrap(error, "Meet文字起こし一覧の取得に失敗しました");
  }
  // 原因の切り分け用に、読む前の状態を残す（本文は出さない）。
  const states = transcripts.map((t) => ({ state: t.state ?? null, endTime: t.endTime ?? null }));
  if (!transcriptsReady(transcripts, conferenceEndTime)) {
    console.log("[meet-transcript] waiting", { conferenceRecord: conferenceRecordName, transcripts: states });
    return null;
  }

  const rawEntries: RawTranscriptEntry[] = [];
  const entryCounts: number[] = [];
  try {
    for (const transcript of transcripts) {
      if (!transcript.name) continue;
      const before = rawEntries.length;
      let pageToken: string | undefined;
      do {
        const res = await meet.conferenceRecords.transcripts.entries.list({
          parent: transcript.name,
          pageSize: 100,
          pageToken,
        });
        rawEntries.push(...(res.data.transcriptEntries ?? []));
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      entryCounts.push(rawEntries.length - before);
    }
  } catch (error) {
    return wrap(error, "Meet文字起こし本文の取得に失敗しました");
  }
  console.log("[meet-transcript] read", { conferenceRecord: conferenceRecordName, transcripts: states, entries: entryCounts });

  // 参加者表示名の解決（同じ参加者を何度も引かないようキャッシュする）
  const participantNames = new Map<string, string>();
  const unresolved = new Set(
    rawEntries.map((e) => e.participant).filter((p): p is string => Boolean(p)),
  );
  for (const participant of unresolved) {
    try {
      const res = await meet.conferenceRecords.participants.get({ name: participant });
      const displayName =
        res.data.signedinUser?.displayName ??
        res.data.anonymousUser?.displayName ??
        res.data.phoneUser?.displayName ??
        null;
      if (displayName) participantNames.set(participant, displayName);
    } catch {
      // 表示名が引けなくても文字起こし自体は使える。話者N のラベルにフォールバックする。
    }
  }

  const { segments, text } = normalizeTranscriptEntries(rawEntries, participantNames);
  if (segments.length === 0) return null;

  const named = transcripts.filter((t) => t.name);
  const first = named[0];
  return {
    conferenceRecordId: conferenceRecordName,
    transcriptName: first.name!,
    docUrl: named.map((t) => t.docsDestination?.exportUri ?? t.docsDestination?.document ?? null).find(Boolean) ?? null,
    segments,
    text,
    startTime: first.startTime ?? null,
    endTime: named[named.length - 1].endTime ?? null,
  };
}
