/**
 * Meet会議記録の選定規則（T16）。純関数のみ。
 *
 * googleapis / prisma を import しない。取り込み（src/lib/meetings/meet-ingest.ts の
 * ingestDealMeetArtifacts）と状態表示（同 dealMeetStatus）が同じ規則で判断するよう、
 * 「どの会議記録・商談履歴をこの商談の予定の会議とみなすか」をここに一本化している。
 * Meet API 側（src/lib/google/meet-artifacts.ts）は会議記録を一覧するだけで、選定はしない。
 */

/** 予定開始より前に始まった記録も拾う（ホストの早め入室・前倒し開始）。 */
export const CONFERENCE_WINDOW_BEFORE_MS = 60 * 60 * 1000;
/** 予定終了より後の記録も拾う（延長・遅れての開始）。 */
export const CONFERENCE_WINDOW_AFTER_MS = 3 * 60 * 60 * 1000;

/** 時間区間 [fromMs, toMs]。toMs が Infinity なら終わりのない区間。 */
export type ConferenceWindow = { fromMs: number; toMs: number };

/** Meet API の conferenceRecord のうち、選定に使う部分だけ。 */
export type ConferenceRecordLike = {
  name?: string | null;
  startTime?: string | null;
  endTime?: string | null;
};

export type SelectedConferenceRecord = {
  name: string;
  startTime: string | null;
  endTime: string | null;
};

/** 取り込み済みの商談履歴（meetingDate＝会議記録の開始、durationSec＝所要秒）。 */
export type IngestedMeetingLike = {
  meetingDate: Date;
  durationSec: number | null;
  meetConferenceRecordId?: string | null;
};

/**
 * この予定の会議の候補。
 * - import: 終了済みで、まだ取り込んでいない会議記録
 * - in_progress: 進行中（endTime なし）の会議記録。終わるまで文字起こしは揃わない
 * - ingested: 取り込み済みの会議（商談履歴）
 */
export type ConferenceCandidate<T> =
  | { kind: "import"; record: SelectedConferenceRecord }
  | { kind: "in_progress"; record: SelectedConferenceRecord }
  | { kind: "ingested"; meeting: T };

/** chooseConferenceRecord の結果。候補が1件も無ければ none。 */
export type ConferenceRecordDecision<T> = ConferenceCandidate<T> | { kind: "none" };

type Span = { startMs: number; endMs: number };

type RankedCandidate<T> = { candidate: ConferenceCandidate<T>; span: Span; name: string };

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function dateMs(value: Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 予定そのものの区間 [開始, 終了]。終了が未設定なら [開始, ∞)。
 * 開始が未設定なら null（＝予定が無い）。
 */
export function scheduledInterval(
  start: Date | null | undefined,
  end: Date | null | undefined,
): ConferenceWindow | null {
  const startMs = dateMs(start);
  if (startMs === null) return null;
  const endMs = dateMs(end);
  return { fromMs: startMs, toMs: endMs ?? Number.POSITIVE_INFINITY };
}

/**
 * 商談日時から会議記録の時間窓 [開始-60分, 終了+3時間] を作る。
 * 開始だけ分かっている（終了未設定の）ときは [開始-60分, ∞) の片側だけの窓にする。
 * 開始も未設定なら null（＝時間で絞り込まない）。
 */
export function conferenceRecordWindow(
  start: Date | null | undefined,
  end: Date | null | undefined,
): ConferenceWindow | null {
  const scheduled = scheduledInterval(start, end);
  if (!scheduled) return null;
  return {
    fromMs: scheduled.fromMs - CONFERENCE_WINDOW_BEFORE_MS,
    toMs: scheduled.toMs + CONFERENCE_WINDOW_AFTER_MS,
  };
}

/** 区間が予定そのもの [開始, 終了] に重なるか（端点で接するものも含む）。 */
function overlapsScheduled(span: Span, scheduled: ConferenceWindow): boolean {
  return span.startMs <= scheduled.toMs && span.endMs >= scheduled.fromMs;
}

/**
 * 区間がこの予定の会議とみなせるか。次のどちらかなら対象にする。
 * - 予定そのもの [開始, 終了] に重なる（予定より早く始まって予定にかかった会議も含む）
 * - 時間窓 [開始-60分, 終了+3時間] の中で始まった（早め入室のマイクテスト・遅れての開始・終了後の入り直し）
 * 時間窓より前に始まり、予定にかからないまま時間窓へはみ出しただけの区間
 * （同じ日の前の会議が延びたもの）は対象にしない。予定が無ければ常に対象。
 */
function belongsToSchedule(
  span: Span,
  scheduled: ConferenceWindow | null,
  window: ConferenceWindow | null,
): boolean {
  if (!scheduled || !window) return true;
  const startsInWindow = span.startMs >= window.fromMs && span.startMs <= window.toMs;
  return startsInWindow || overlapsScheduled(span, scheduled);
}

/**
 * 会議記録が予定そのもの [開始, 終了]（終了が未設定なら [開始, ∞)）に重なるか。予定が無ければ true。
 * 区間の作り方は rankConferenceCandidates と同じ（進行中は [開始, ∞)、開始が欠けていれば終了の一点）。
 * 商談の開始前の取得で、予定にかからない記録（早め入室のマイクテストなど）を本番の代わりに
 * 取り込まないために使う（meet-ingest.ts の ingestDealMeetArtifacts）。
 */
export function recordOverlapsSchedule(
  record: ConferenceRecordLike,
  start: Date | null | undefined,
  end: Date | null | undefined,
): boolean {
  const scheduled = scheduledInterval(start, end);
  if (!scheduled) return true;
  const endMs = toMs(record.endTime) ?? Number.POSITIVE_INFINITY;
  const startMs = toMs(record.startTime) ?? endMs;
  return overlapsScheduled({ startMs, endMs }, scheduled);
}

/** 区間が時間窓に重なっている長さ（ミリ秒）。窓が無ければ 0。 */
function overlapMs(span: Span, window: ConferenceWindow | null): number {
  if (!window) return 0;
  return Math.max(0, Math.min(span.endMs, window.toMs) - Math.max(span.startMs, window.fromMs));
}

/** 大きい方を先にする比較。Infinity 同士も同順位として扱う（引き算だと NaN になるため）。 */
function descending(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

/**
 * 「この予定の会議らしさ」の順に並べる比較関数（負なら a が先）。
 * 1. 予定そのもの [開始, 終了] に重なる時間が長いもの
 *    （本番の会議を、早め入室のマイクテストや終了後の入り直しのような短い記録より先にする）
 * 2. 同じなら時間窓 [開始-60分, 終了+3時間] に重なる時間が長いもの
 *    （予定から大きくずれて開かれた会議でも、短い断片より長い本体を先にする）
 * 3. さらに同じなら開始が新しいもの、次に終了が新しいもの
 * 予定が無いときは 1・2 が常に 0 なので、開始が新しい順になる。
 */
function compareScheduleFit(
  a: Span,
  b: Span,
  scheduled: ConferenceWindow | null,
  window: ConferenceWindow | null,
): number {
  return (
    descending(overlapMs(a, scheduled), overlapMs(b, scheduled)) ||
    descending(overlapMs(a, window), overlapMs(b, window)) ||
    descending(a.startMs, b.startMs) ||
    descending(a.endMs, b.endMs)
  );
}

/**
 * 同じ順位の候補の並び。取り込み済みの会議を先にして（冪等）、進行中の記録を
 * 未取り込みの記録より先にする（取り込まずに待つ側へ倒す）。最後は name 昇順で固定する。
 */
const KIND_ORDER: Record<ConferenceCandidate<unknown>["kind"], number> = {
  ingested: 0,
  in_progress: 1,
  import: 2,
};

/** 商談履歴を区間にする。日付が壊れていれば null。 */
function meetingSpan(meeting: IngestedMeetingLike): Span | null {
  const startMs = dateMs(meeting.meetingDate);
  if (startMs === null) return null;
  return { startMs, endMs: startMs + Math.max(0, meeting.durationSec ?? 0) * 1000 };
}

/**
 * この予定の会議の候補を「この予定の会議らしさ」の順に並べて返す。
 * - 会議記録（終了済み）: 予定の会議とみなせるもの（belongsToSchedule）。取り込み済みの記録は
 *   ingested として、記録そのものの区間で比べる
 * - 会議記録（進行中）: 終わりが分からないので [開始, ∞) の区間で比べる。終了したときに
 *   今の最有力より上位になり得るなら、in_progress が先頭に来る（下位の記録を取り込まずに待つ）
 * - 一覧に出てこない取り込み済みの会議（30日で消えた記録、発行し直す前のスペースの記録など）は、
 *   商談履歴の区間（meetingDate からの durationSec）で比べる
 * 予定が無いときは開始が新しい順になる（最新の会議が取り込み済みなら ingested が先頭）。
 */
export function rankConferenceCandidates<T extends IngestedMeetingLike>(
  records: ReadonlyArray<ConferenceRecordLike>,
  opts: {
    start?: Date | null;
    end?: Date | null;
    ingested?: ReadonlyArray<T>;
  } = {},
): ConferenceCandidate<T>[] {
  const scheduled = scheduledInterval(opts.start, opts.end);
  const window = conferenceRecordWindow(opts.start, opts.end);
  const ingested = opts.ingested ?? [];
  const ingestedByRecord = new Map<string, T>();
  for (const meeting of ingested) {
    const id = meeting.meetConferenceRecordId;
    if (id && !ingestedByRecord.has(id)) ingestedByRecord.set(id, meeting);
  }

  const listed = new Set<string>();
  const ranked: RankedCandidate<T>[] = [];
  for (const record of records) {
    const name = record.name;
    if (!name || listed.has(name)) continue;
    listed.add(name);
    const startMs = toMs(record.startTime);
    const endMs = toMs(record.endTime);
    const selected: SelectedConferenceRecord = {
      name,
      startTime: record.startTime ?? null,
      endTime: record.endTime ?? null,
    };

    if (endMs === null) {
      // 開始も分からない進行中の記録は時間の上で位置づけられないので扱わない
      if (startMs === null) continue;
      const span = { startMs, endMs: Number.POSITIVE_INFINITY };
      if (belongsToSchedule(span, scheduled, window)) {
        ranked.push({ candidate: { kind: "in_progress", record: selected }, span, name });
      }
      continue;
    }

    // 開始時刻が欠けている記録は終了時刻の一点として扱う
    const span = { startMs: startMs ?? endMs, endMs };
    if (!belongsToSchedule(span, scheduled, window)) continue;
    const meeting = ingestedByRecord.get(name);
    ranked.push({
      candidate: meeting ? { kind: "ingested", meeting } : { kind: "import", record: selected },
      span,
      name,
    });
  }

  for (const meeting of ingested) {
    const id = meeting.meetConferenceRecordId ?? "";
    if (id && listed.has(id)) continue;
    const span = meetingSpan(meeting);
    if (span && belongsToSchedule(span, scheduled, window)) {
      ranked.push({ candidate: { kind: "ingested", meeting }, span, name: id });
    }
  }

  return ranked
    .sort(
      (a, b) =>
        compareScheduleFit(a.span, b.span, scheduled, window) ||
        KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .map(({ candidate }) => candidate);
}

/**
 * 取り込みで次に何をするかを、この予定の会議として最有力の候補1件で決める。
 * - import: その記録の文字起こしを取り込む（文字起こしが未生成でも、下位の断片へは進まない）
 * - in_progress: 最有力の会議がまだ進行中。下位の終了済みの記録は取り込まずに待つ
 * - ingested: 最有力の会議は取り込み済み（冪等）。取り込み済みの会議が時間窓に重なるだけでは
 *   ここにならず、それより予定に合う終了済みの記録（遅れて終わった本番・同じ日の次の会議）があれば import になる
 * - none: この予定の会議とみなせる記録がまだ無い
 * 予定が無いときは最新の会議記録で判断する（取り込み済みなら ingested、未取り込みなら import）。
 */
export function chooseConferenceRecord<T extends IngestedMeetingLike>(
  records: ReadonlyArray<ConferenceRecordLike>,
  opts: {
    start?: Date | null;
    end?: Date | null;
    ingested?: ReadonlyArray<T>;
  } = {},
): ConferenceRecordDecision<T> {
  return rankConferenceCandidates(records, opts)[0] ?? { kind: "none" };
}

/**
 * 取り込み済みの商談履歴から「現在の予定の会議」を1件選ぶ（無ければ null）。
 * 会議記録の選定と同じ規則（予定の会議とみなせるもの・予定に重なる時間が長い順→開始が新しい順）で比べるので、
 * 作成日時の新しい断片（入り直し・マイクテスト）が本番の会議を押しのけることはなく、
 * 同じ日の前の会議が延びて時間窓にはみ出しただけの履歴を、組み直した予定の会議として扱うこともない。
 * 予定が無いときは開始が最も新しいものを返す。
 */
export function pickScheduledMeeting<T extends IngestedMeetingLike>(
  meetings: ReadonlyArray<T>,
  start: Date | null | undefined,
  end: Date | null | undefined,
): T | null {
  const top = chooseConferenceRecord([], { start, end, ingested: meetings });
  return top.kind === "ingested" ? top.meeting : null;
}
