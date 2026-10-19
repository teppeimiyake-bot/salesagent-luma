/**
 * Meet自動記録（T16）のオーケストレーション。
 *
 * 「Meet発行 → スペースの自動録画・自動文字起こしをON → 商談 → 成果物を取り込み → AI分析」
 * の一連を、失敗しても商談運用を止めない形（例外を外に投げない）でまとめる。
 * 自動（cron）と手動（画面ボタン）の両方から同じ関数を呼ぶ。
 */
import { Prisma } from "@prisma/client";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import {
  enableAutoArtifacts,
  fetchMeetTranscript,
  listConferenceRecords,
  resolveMeetSpace,
} from "@/lib/google/meet-artifacts";
import { MEETING_PROCESSING_STATUS } from "@/lib/meetings/processing";
import { runMeetingAnalysis } from "@/lib/meetings/analysis";
import {
  MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,
  MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE,
  MEET_ARTIFACT_MAX_ATTEMPTS,
  deriveMeetPhase,
  isMeetArtifactAttemptsExhaustedFailure,
  meetArtifactAutoFetchGiveUp,
} from "@/lib/meetings/meet-phase";
import { dealMeetNeedsAttention, deriveDealPhase } from "@/lib/deal-phase";
import {
  chooseConferenceRecord,
  conferenceRecordWindow,
  pickScheduledMeeting,
  recordOverlapsSchedule,
} from "@/lib/meetings/conference-record-selection";

// 試行上限と上限到達の理由は、状態表示（純関数の meet-phase.ts）と同じ値を使うためそちらで定義している。
// cron（src/app/api/cron/meet-artifacts/route.ts）は従来どおりここから import する。
export { deriveMeetPhase, MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE, MEET_ARTIFACT_MAX_ATTEMPTS };
export type { MeetPhase, MeetPhaseInput } from "@/lib/meetings/meet-phase";

/** meet_auto で作られた商談履歴であることを示す sourceType。 */
export const MEETING_SOURCE_MEET_AUTO = "meet_auto";

/** 取得中に商談日時が組み直され、商談側の取得状態を書き換えなかったときに結果へ添える一文。 */
const SCHEDULE_CHANGED_NOTE =
  "（取得中に商談日時が変更されたため、成果物の取得状態は新しい日時のまま残しています）";

/** 上限到達の failed を書く直前に試行回数がリセットされ（Meetの再発行など）、取得状態を書き換えなかったときに結果へ添える一文。 */
const STATE_RESET_NOTE =
  "（取得中にMeetの再発行などで取得状態がリセットされたため、成果物の取得状態はリセット後のまま残しています）";

/** 商談日時が無く、スペースの最新の会議記録で判断したときに結果へ添える一文。 */
const UNSCHEDULED_NOTE = "（商談日時が未設定のため、Meetスペースの最新の会議を対象にしました）";

/** 予定の終了前に取り込んだ（取り込み済みと判断した）ため、取得状態を確定させなかったときに結果へ添える一文。 */
const BEFORE_END_NOTE =
  "（商談の予定終了前のため、予定の終了後にあらためて会議記録を確認し、より予定に合う会議があれば取り込みます）";

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * 商談のMeetスペースに自動録画・自動文字起こしを設定する。
 * Calendar発行が成功していても、ここが失敗したら「設定済み」とは記録しない。
 * 呼び出し側（Meet発行API）を巻き込まないよう、例外は投げずに結果で返す。
 */
export async function configureDealMeetArtifacts(
  dealId: string,
): Promise<{ ok: boolean; status: string; error?: string }> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { id: true, meetUrl: true, meetSpaceName: true },
    });
    if (!deal) return { ok: false, status: "failed", error: "商談が見つかりませんでした。" };
    if (!deal.meetUrl) {
      const message = "Meet URLが未発行のため、自動録画・自動文字起こしを設定できません。";
      await prisma.deal.update({
        where: { id: dealId },
        data: { meetArtifactConfigStatus: "failed", meetArtifactConfigError: message },
      });
      return { ok: false, status: "failed", error: message };
    }

    await prisma.deal.update({
      where: { id: dealId },
      data: { meetArtifactConfigStatus: "configuring", meetArtifactConfigError: null },
    });

    const space = deal.meetSpaceName
      ? { name: deal.meetSpaceName }
      : await resolveMeetSpace(deal.meetUrl);
    const result = await enableAutoArtifacts(space.name);

    await prisma.deal.update({
      where: { id: dealId },
      data: {
        meetSpaceName: result.spaceName,
        meetArtifactConfigStatus: "configured",
        meetArtifactConfigError: null,
        meetArtifactConfiguredAt: new Date(),
      },
    });
    return { ok: true, status: "configured" };
  } catch (e) {
    const message = errorMessage(e, "Meetの自動録画・自動文字起こし設定に失敗しました。");
    try {
      await prisma.deal.update({
        where: { id: dealId },
        data: { meetArtifactConfigStatus: "failed", meetArtifactConfigError: message },
      });
    } catch (persistError) {
      console.error("[meet-ingest] 設定失敗の保存に失敗", persistError);
    }
    return { ok: false, status: "failed", error: message };
  }
}

/** AI分析の起動。本番(Vercel)は after()、それ以外はその場で await（processing.ts と同じ方針）。 */
async function scheduleMeetingAnalysis(meetingId: string): Promise<void> {
  const runInline = process.env.NODE_ENV !== "production" || !process.env.VERCEL;
  if (runInline) {
    await runMeetingAnalysis(meetingId);
    return;
  }
  try {
    after(() => {
      return runMeetingAnalysis(meetingId).catch((e) => {
        console.error("[meet-ingest] AI分析で未処理エラー", {
          meetingId,
          message: errorMessage(e, "unknown"),
        });
      });
    });
  } catch (e) {
    console.warn("[meet-ingest] after() が使えないためインラインで実行します", e);
    await runMeetingAnalysis(meetingId);
  }
}

/**
 * 商談のMeet成果物（会議記録・文字起こし）を取り込み、商談履歴を作ってAI分析まで繋ぐ。
 * 同じ会議記録から二重に商談履歴を作らない（事前チェック＋UNIQUE違反(P2002)の握り）。
 * 取り込むのは「この予定の会議として最有力の記録」1件だけ（chooseConferenceRecord）。
 * 最有力の会議を一度取り込んだら、以降の実行（再度の手動取得・日時の微修正後のcron）は
 * 冪等に「取り込み済み」を返し、同じ時間帯の別の記録（入り直し・マイクテスト）を追加で取り込まない。
 * 最有力の会議がまだ進行中なら、下位の終了済みの記録（早め入室の断片など）は取り込まずに待つ。
 * 商談の開始前は、予定にかからない記録（開始前に終わったマイクテストなど）を取り込まずに待つ。
 * 予定の終了前に取り込んだ（取り込み済みと判断した）ときは取得状態を waiting に留め、
 * 予定の終了後の cron でもう一度選び直す（後から開かれた本番があればそちらを取り込む）。
 * 成果物が無いまま試行上限（MEET_ARTIFACT_MAX_ATTEMPTS）に達したら、cron はもう拾わないので
 * waiting ではなく理由つきの failed で確定する（手動の「成果物を取得」でいつでも取り直せる）。
 */
export async function ingestDealMeetArtifacts(
  dealId: string,
  opts?: { trigger?: string },
): Promise<{ status: string; meetingId?: string; message: string }> {
  const trigger = opts?.trigger ?? "auto";

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      meetUrl: true,
      meetSpaceName: true,
      meetingStartAt: true,
      meetingEndAt: true,
      meetArtifactAttempts: true,
    },
  });
  if (!deal) return { status: "failed", message: "商談が見つかりませんでした。" };

  // 商談側の取得状態は、読み取った時点の予定のままのときだけ書き換える。
  // 取得中に日時が組み直されると PATCH が状態を戻す（null）ので、古い予定の結果
  // （fetched / waiting / failed）で上書きせず、新しい日時の会議をcron・手動取得で取り直せるようにする。
  const scheduleWhere = { id: dealId, meetingStartAt: deal.meetingStartAt, meetingEndAt: deal.meetingEndAt };
  const updateArtifactState = async (
    data: Prisma.DealUpdateManyMutationInput,
    where: Prisma.DealWhereInput = {},
  ): Promise<boolean> => {
    const { count } = await prisma.deal.updateMany({ where: { ...scheduleWhere, ...where }, data });
    if (count === 0) {
      console.warn("[meet-ingest] 取得中に商談日時が変更されたため、取得状態を更新しません", { dealId, trigger });
    }
    return count > 0;
  };
  const withScheduleNote = (message: string, applied: boolean) =>
    applied ? message : `${message}${SCHEDULE_CHANGED_NOTE}`;

  // 成果物がまだ無く「待ち」で終わる試行の締め。上限未満なら waiting にして cron の再試行に任せる。
  // 上限に達していたら cron はもう拾わないので、waiting のまま放置せず理由つきの failed で確定する（要対応）。
  // 上限の判定は読み取り時の回数ではなく保存済みの回数で行う（cron と手動取得が重なっても取りこぼさない）。
  // 終了日時の無い商談はもともと cron の対象外（上限で打ち切られるわけではない）なので、従来どおり waiting にする。
  const settleWaiting = async (): Promise<"waiting" | "exhausted" | "fetched_elsewhere" | "reset" | "schedule_changed"> => {
    const checkedAt = new Date();
    if (!deal.meetingEndAt) {
      const applied = await updateArtifactState({ meetArtifactStatus: "waiting", meetArtifactCheckedAt: checkedAt });
      return applied ? "waiting" : "schedule_changed";
    }
    const { count } = await prisma.deal.updateMany({
      where: { ...scheduleWhere, meetArtifactAttempts: { lt: MEET_ARTIFACT_MAX_ATTEMPTS } },
      data: { meetArtifactStatus: "waiting", meetArtifactCheckedAt: checkedAt },
    });
    if (count > 0) return "waiting";
    // 終端の failed は、2つの更新の間に起きた次の変更を上書きしない。
    // - 試行回数のリセット（Meetの再発行が状態と回数を戻す）：gte の条件で外す（リセット後は cron が拾い直す）。
    // - 同時に走った取得（手動の「成果物を取得」など）が取り込んだ fetched：状態の条件で外す。
    const { count: exhausted } = await prisma.deal.updateMany({
      where: {
        ...scheduleWhere,
        meetArtifactAttempts: { gte: MEET_ARTIFACT_MAX_ATTEMPTS },
        meetArtifactStatus: { not: "fetched" },
      },
      data: {
        meetArtifactStatus: "failed",
        meetArtifactError: MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE,
        meetArtifactCheckedAt: checkedAt,
      },
    });
    if (exhausted > 0) return "exhausted";
    // どちらの更新も当たらなかった理由を、いまの商談から見分けて結果の文に反映する（取得状態は書き換えない）。
    const current = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { meetingStartAt: true, meetingEndAt: true, meetArtifactStatus: true },
    });
    const sameSchedule =
      current != null &&
      current.meetingStartAt?.getTime() === deal.meetingStartAt?.getTime() &&
      current.meetingEndAt?.getTime() === deal.meetingEndAt?.getTime();
    if (!sameSchedule) {
      console.warn("[meet-ingest] 取得中に商談日時が変更されたため、取得状態を更新しません", { dealId, trigger });
      return "schedule_changed";
    }
    if (current.meetArtifactStatus === "fetched") return "fetched_elsewhere";
    console.warn("[meet-ingest] 取得中に取得状態がリセットされたため、上限到達の失敗を書き込みません", { dealId, trigger });
    return "reset";
  };

  // 1) スペース名の確定（未解決ならMeet URLからその場で解決する）
  let spaceName = deal.meetSpaceName;
  if (!spaceName) {
    if (!deal.meetUrl) {
      const message = "Meet URLが未発行のため、成果物を取得できません。";
      await updateArtifactState({ meetArtifactStatus: "failed", meetArtifactError: message, meetArtifactCheckedAt: new Date() });
      return { status: "failed", message };
    }
    try {
      const resolved = await resolveMeetSpace(deal.meetUrl);
      spaceName = resolved.name;
      await prisma.deal.update({ where: { id: dealId }, data: { meetSpaceName: spaceName } });
    } catch (e) {
      const message = errorMessage(e, "Meetスペースを解決できませんでした。");
      await updateArtifactState({ meetArtifactStatus: "failed", meetArtifactError: message, meetArtifactCheckedAt: new Date() });
      return { status: "failed", message };
    }
  }

  // 2) 取得中に遷移（試行回数を進めて、空振りが続く商談をcronから外せるようにする）。
  //    日時が既に組み直されていたら状態は書き換えないが、実際に開かれた会議の取り込み自体は続ける。
  await updateArtifactState({
    meetArtifactStatus: "fetching",
    meetArtifactError: null,
    meetArtifactCheckedAt: new Date(),
    meetArtifactAttempts: { increment: 1 },
  });

  try {
    // 3) 取り込み済みの会議（冪等性の判定と、同じ記録の二重取り込み防止に使う）
    const ingested = await prisma.meeting.findMany({
      where: { dealId, meetConferenceRecordId: { not: null } },
      orderBy: { meetingDate: "desc" },
      select: { id: true, processingStatus: true, meetConferenceRecordId: true, meetingDate: true, durationSec: true },
    });

    // 4) スペースの会議記録（進行中を含む）を一覧し、この予定の会議として最有力の候補を1件決める。
    //    取り込み済みの会議が時間窓に重なるだけでは冪等にせず、それより予定に合う終了済みの記録
    //    （遅れて終わった本番・同じ日の次の会議）があればそちらを取り込む。
    //    予定が無いときは最新の会議記録で判断する（取り込み済みなら冪等、未取り込みなら取り込む）。
    const unscheduled = !deal.meetingStartAt;
    const withContextNote = (message: string, applied: boolean) =>
      withScheduleNote(unscheduled ? `${message}${UNSCHEDULED_NOTE}` : message, applied);
    // 待ちで終わる経路（進行中・記録なし・予定外の記録の保留・文字起こし未生成）の共通の締め。
    const waitingResult = async (message: string): Promise<{ status: string; message: string }> => {
      const settled = await settleWaiting();
      if (settled === "exhausted") {
        console.warn("[meet-ingest] 試行上限に達したため自動取得を終了します", { dealId, trigger });
        return { status: "failed", message: withContextNote(`${message}${MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE}`, true) };
      }
      if (settled === "fetched_elsewhere") {
        // 同時に走った取得が先に取り込んだ。その結果（fetched）を残し、この試行の「まだ無い」は結果の文にだけ出す。
        return {
          status: "fetched",
          message: withContextNote("同時に実行された取得で、この会議の文字起こしは取り込み済みです（重複作成はしていません）。", true),
        };
      }
      if (settled === "reset") return { status: "waiting", message: withContextNote(`${message}${STATE_RESET_NOTE}`, true) };
      return { status: "waiting", message: withContextNote(message, settled === "waiting") };
    };
    const records = await listConferenceRecords(spaceName);
    const decision = chooseConferenceRecord(records, {
      start: deal.meetingStartAt,
      end: deal.meetingEndAt,
      ingested,
    });

    // 予定の開始前・終了前かどうか（一覧を取った後の時刻で判断する）。
    // 終了前に取り込んだ（取り込み済みと判断した）ときは、終端の fetched にせず waiting のままにする。
    // cron は予定の終了後に waiting の商談を拾い直すので、その時点の会議記録で、後から開かれた本番
    // （開始前のマイクテストの後の会議・組み直した予定の次の会議）があれば取り込み、無ければ冪等に fetched で確定する。
    const nowMs = Date.now();
    const beforeStart = deal.meetingStartAt != null && nowMs < deal.meetingStartAt.getTime();
    const beforeEnd = deal.meetingEndAt != null && nowMs < deal.meetingEndAt.getTime();
    const settledStatus = beforeEnd ? "waiting" : "fetched";
    const withSettledNote = (message: string, applied: boolean) =>
      applied && beforeEnd ? `${message}${BEFORE_END_NOTE}` : message;

    if (decision.kind === "ingested") {
      // 最有力の会議は取り込み済み：新しく作らず、止まったAI分析だけ再開する
      const existing = decision.meeting;
      if ([MEETING_PROCESSING_STATUS.TRANSCRIBED, MEETING_PROCESSING_STATUS.ERROR].includes(existing.processingStatus as "transcribed" | "error")) {
        await scheduleMeetingAnalysis(existing.id);
      }
      const applied = await updateArtifactState({
        meetArtifactStatus: settledStatus,
        meetArtifactError: null,
        meetArtifactCheckedAt: new Date(),
      });
      return {
        status: "fetched",
        meetingId: existing.id,
        message: withContextNote(
          withSettledNote("この会議の文字起こしは取り込み済みです（重複作成はしていません）。", applied),
          applied,
        ),
      };
    }

    if (decision.kind === "in_progress") {
      // 最有力の会議がまだ終わっていない（予定より延びた本番など）。下位の終了済みの記録は取り込まない
      return waitingResult("Meet会議がまだ進行中です。会議の終了後に文字起こしを取り込みます。");
    }

    if (decision.kind === "none") {
      return waitingResult(
        "終了済みのMeet会議記録がまだありません。商談終了後しばらく待ってから再度お試しください。",
      );
    }

    const record = decision.record;
    // 予定の時間にかからない記録（開始前に終わったマイクテストなど）は、予定の終了までは取り込まない。
    // 主催者が遅れて入室する場合も、本番が後から開かれうるため。予定の終了後は cron がより合う会議を選び、
    // 無ければその記録を取り込む。終了時刻の無い予定では、開始前に終わった記録は取り込まない（従来どおり）。
    const holdUntilEnd = beforeStart || beforeEnd || (deal.meetingStartAt != null && deal.meetingEndAt == null);
    if (holdUntilEnd && !recordOverlapsSchedule(record, deal.meetingStartAt, deal.meetingEndAt)) {
      return waitingResult(
        beforeStart
          ? "商談の開始前です。開始前に終わったMeet会議（マイクテストなど）は取り込みません。商談終了後に文字起こしを取り込みます。"
          : "予定の時間にかからないMeet会議（開始前に終わったマイクテストなど）は、予定の終了まで取り込みを保留します。商談終了後に文字起こしを取り込みます。",
      );
    }

    // 5) 文字起こし本文。最有力の記録（本番の会議）だけを見る。
    //    null は「まだ生成中」のこともあるので、下位の候補（早め入室の短い記録など）には進まず待つ。
    const transcript = await fetchMeetTranscript(record.name, record.endTime);
    if (!transcript) {
      return waitingResult("文字起こしがまだ生成されていません。生成完了まで数分かかることがあります。");
    }

    // 6) 商談履歴の作成（同時実行でもUNIQUE違反を握って既存行を返す）
    const startMs = record.startTime ? Date.parse(record.startTime) : NaN;
    const endMs = record.endTime ? Date.parse(record.endTime) : NaN;
    const durationSec =
      !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs
        ? Math.round((endMs - startMs) / 1000)
        : null;

    const meetingData = {
      dealId,
      meetingDate: !Number.isNaN(startMs)
        ? new Date(startMs)
        : (deal.meetingStartAt ?? new Date()),
      sourceType: MEETING_SOURCE_MEET_AUTO,
      transcript: transcript.text,
      transcriptSegments: transcript.segments as unknown as Prisma.InputJsonValue,
      meetConferenceRecordId: record.name,
      meetTranscriptName: transcript.transcriptName,
      meetTranscriptDocUrl: transcript.docUrl,
      durationSec,
      // 文字起こしは Meet 側で完了済み。Whisper/Gemini の文字起こしは走らせない。
      processingStatus: MEETING_PROCESSING_STATUS.TRANSCRIBED,
      processingError: null,
      processingCompletedAt: new Date(),
    };

    let meetingId: string;
    try {
      const created = await prisma.meeting.create({ data: meetingData, select: { id: true } });
      meetingId = created.id;
    } catch (e) {
      const isUniqueViolation =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!isUniqueViolation) throw e;
      const raced = await prisma.meeting.findFirst({
        where: { dealId, meetConferenceRecordId: record.name },
        select: { id: true },
      });
      if (!raced) throw e;
      meetingId = raced.id;
    }

    // 7) 商談側の状態を確定（取得中に日時が変わっていたら、作った商談履歴は残しつつ状態は戻したままにする）。
    //    予定の終了前なら確定させず waiting にして、予定の終了後に cron で選び直せるようにする。
    const applied = await updateArtifactState({
      meetArtifactStatus: settledStatus,
      meetArtifactError: null,
      meetArtifactCheckedAt: new Date(),
    });

    // 8) 既存のAIチェーン（7段推論・BANT集約）へ流す
    await scheduleMeetingAnalysis(meetingId);

    console.log("[meet-ingest] 取り込み完了", { dealId, meetingId, trigger });
    return {
      status: "fetched",
      meetingId,
      message: withContextNote(
        withSettledNote(`Meetの文字起こしを取り込み、AI分析を開始しました（発言${transcript.segments.length}件）。`, applied),
        applied,
      ),
    };
  } catch (e) {
    const message = errorMessage(e, "Meet成果物の取得に失敗しました。");
    await updateArtifactState({ meetArtifactStatus: "failed", meetArtifactError: message, meetArtifactCheckedAt: new Date() });
    console.error("[meet-ingest] 取り込み失敗", { dealId, trigger, message });
    return { status: "failed", message };
  }
}

/** 画面（MeetSessionPanel）にそのまま渡せる状態オブジェクト。 */
export type DealMeetStatus = {
  meetUrl: string | null;
  meetSpaceName: string | null;
  configStatus: string | null;
  configError: string | null;
  artifactStatus: string | null;
  artifactError: string | null;
  attempts: number;
  checkedAt: string | null;
  conferenceRecordId: string | null;
  latestMeetingId: string | null;
  phase: ReturnType<typeof deriveMeetPhase>;
};

/**
 * 別経路の記録（T16 AC8 の救済経路）として数える商談履歴の条件。規則は dealMeetStatus の説明のとおり
 * （meet_auto 以外・予定の開始以降に作成・処理失敗でない・本文がある）。商談一覧の要対応判定とも共有する。
 */
function otherRouteMeetingWhere(meetingStartAt: Date) {
  return {
    sourceType: { not: MEETING_SOURCE_MEET_AUTO },
    createdAt: { gte: meetingStartAt },
    processingStatus: { not: MEETING_PROCESSING_STATUS.ERROR },
    OR: [{ recordingUrl: { not: null } }, { transcript: { not: null } }, { minutes: { not: null } }],
  };
}

export async function dealMeetStatus(dealId: string): Promise<DealMeetStatus | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      meetUrl: true,
      meetEventId: true,
      meetSpaceName: true,
      meetingStartAt: true,
      meetingEndAt: true,
      meetArtifactConfigStatus: true,
      meetArtifactConfigError: true,
      meetArtifactStatus: true,
      meetArtifactError: true,
      meetArtifactAttempts: true,
      meetArtifactCheckedAt: true,
    },
  });
  if (!deal) return null;

  // 予定を組み直した後に、前回の会議の結果で「AI分析まで完了」と誤表示しないよう、
  // 現在の予定の会議とみなせる meet_auto の商談履歴だけを見る（会議記録の選定と同じ規則。
  // 同じ日の前の会議が延びて時間窓にはみ出しただけの履歴は含めない）。
  // 作成日時ではなく会議の時間帯（予定に重なる長さ→開始が新しい順）で選ぶので、
  // 後から取り込まれた短い断片が本番の会議の結果を押しのけない（商談ページの meetingDate 順とも揃う）。
  const meetings = await prisma.meeting.findMany({
    where: { dealId, sourceType: MEETING_SOURCE_MEET_AUTO },
    orderBy: { meetingDate: "desc" },
    select: { id: true, processingStatus: true, meetConferenceRecordId: true, meetingDate: true, durationSec: true },
  });
  const latest = pickScheduledMeeting(meetings, deal.meetingStartAt, deal.meetingEndAt);
  const now = new Date();
  const autoFetch = {
    meetUrl: deal.meetUrl,
    meetEventId: deal.meetEventId,
    meetingEndAt: deal.meetingEndAt,
    artifactStatus: deal.meetArtifactStatus,
    artifactError: deal.meetArtifactError,
    attempts: deal.meetArtifactAttempts,
    checkedAt: deal.meetArtifactCheckedAt,
    now,
  };
  // 取り込めないまま自動取得が打ち切られた（試行上限・商談終了から7日の期間切れ）商談は、cron がもう拾わない。
  // DBは書き換えず、ここで「取得失敗＋理由」として出す（フェーズも要対応になる）。手動取得は引き続きできる。
  // この予定の meet_auto の会議を取り込み済みなら、打ち切りで表示を上書きしない（下の latest の扱い）。
  const giveUp = latest ? null : meetArtifactAutoFetchGiveUp(autoFetch);

  // 別経路の記録（T16 AC8 の救済経路）：自動取得が打ち切られても、この予定の会議を別の経路で記録できていれば
  // 要対応にしない。取り違えて要対応を消さないよう、次のすべてに当たる商談履歴だけを数える。
  // - sourceType が meet_auto 以外（upload＝ブラウザ録音・音声/動画の添付、manual_text＝テキスト添付・手入力）。
  //   meet_auto の履歴は上の latest（会議の時間帯で選ぶ）で扱う。
  // - createdAt が予定の開始以降。createdAt はサーバーが付ける作成日時で、後から変えられない。meetingDate は
  //   手入力の記録で任意の日時を指定でき、PATCH /api/meetings/[id] でも変えられるので判断に使わない。
  //   予定の開始より前に作られた履歴（前回の商談の記録など）は、この予定の会議の記録とはみなさない。
  //   救済の添付は打ち切りを見てから後日になることが多いので、上限は設けない。
  // - 処理に失敗していない（processingStatus が error でない）。文字起こしに失敗した録音では、会議を残せたとは言えない。
  // - 本文がある（録音ファイル・文字起こし・議事録のどれか）。本文を後から書く空の下書き（createDraft）は数えない。
  // 予定の開始日時が無い商談は判断できないので数えない（要対応のまま）。
  const otherRouteMeeting =
    giveUp && deal.meetingStartAt
      ? await prisma.meeting.findFirst({
          where: { dealId, ...otherRouteMeetingWhere(deal.meetingStartAt) },
          orderBy: { createdAt: "desc" },
          // summary は AI分析の結果（議事録要約）。手入力の記録は completed でも分析前なので、有無でバッジを分ける。
          select: { processingStatus: true, summary: true },
        })
      : null;

  let artifactStatus = deal.meetArtifactStatus;
  let artifactError = deal.meetArtifactError;
  if (latest) {
    // 予定の終了前に取り込んだ会議は、終了後の再確認のため内部では waiting のまま。画面には取得済みとして出す。
    // 上限到達の failed も「待ち」の打ち切りにすぎないので、取り込み済みの会議があれば同じく取得済みとして出す
    // （フェーズは取り込んだ会議の分析状況になる。本物の取得エラーの failed はそのまま出す）。
    if (deal.meetArtifactStatus === "waiting") {
      artifactStatus = "fetched";
    } else if (isMeetArtifactAttemptsExhaustedFailure(autoFetch)) {
      artifactStatus = "fetched";
      artifactError = null;
    }
  } else if (giveUp && otherRouteMeeting) {
    // Meetの文字起こしは取れていない（未取得）が、別経路の記録があるので失敗や理由は出さない。
    artifactStatus = null;
    artifactError = null;
  } else if (giveUp) {
    artifactStatus = "failed";
    artifactError =
      giveUp === "lookback_expired" ? MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE : MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE;
  }

  return {
    meetUrl: deal.meetUrl,
    meetSpaceName: deal.meetSpaceName,
    configStatus: deal.meetArtifactConfigStatus,
    configError: deal.meetArtifactConfigError,
    artifactStatus,
    artifactError,
    attempts: deal.meetArtifactAttempts,
    checkedAt: deal.meetArtifactCheckedAt ? deal.meetArtifactCheckedAt.toISOString() : null,
    conferenceRecordId: latest?.meetConferenceRecordId ?? null,
    latestMeetingId: latest?.id ?? null,
    phase: deriveMeetPhase({
      meetUrl: deal.meetUrl,
      meetingStartAt: deal.meetingStartAt,
      meetingEndAt: deal.meetingEndAt,
      configStatus: deal.meetArtifactConfigStatus,
      artifactStatus: deal.meetArtifactStatus,
      latestMeetingStatus: latest?.processingStatus ?? null,
      now,
      meetEventId: deal.meetEventId,
      artifactError: deal.meetArtifactError,
      attempts: deal.meetArtifactAttempts,
      checkedAt: deal.meetArtifactCheckedAt,
      otherRouteMeetingStatus: otherRouteMeeting?.processingStatus ?? null,
      otherRouteMeetingAnalyzed: otherRouteMeeting ? Boolean(otherRouteMeeting.summary) : undefined,
    }),
  };
}

/** 商談一覧の要対応判定に使う商談の列（一覧の問い合わせで読んでいる deals の列だけ）。 */
export type DealMeetAttentionInput = {
  id: string;
  /** deals.status と配下プロダクトのヨミ（受注・失注で閉じた商談には要対応を出さない。isDealClosed） */
  status: string;
  products: ReadonlyArray<{ yomiStatus: string | null }>;
  meetUrl: string | null;
  meetEventId: string | null;
  meetingStartAt: Date | null;
  meetingEndAt: Date | null;
  meetArtifactConfigStatus: string | null;
  meetArtifactStatus: string | null;
  meetArtifactError: string | null;
  meetArtifactAttempts: number;
  meetArtifactCheckedAt: Date | null;
};

/**
 * Meet の1回の会議の長さの上限（24時間）。予定の開始よりこれ以上前に始まった meet_auto の記録は、
 * 予定に重なることがない（＝pickScheduledMeeting の候補にならない）ので、一覧では読まない。
 */
const MEET_MAX_CONFERENCE_MS = 24 * 60 * 60 * 1000;

/**
 * 商談一覧（T16）：商談ページ上部の要約（DealHero）が「要対応」を出す商談の id を、渡された商談の分まとめて求める。
 * 判定は商談ページと同じ：Meetセッションが「確認が必要です」（dealMeetStatus の phase と同じ規則）で、かつ
 * dealMeetNeedsAttention（商談後の場面＝終了直後・商談後のときだけ、受注・失注の商談は除く）。
 * 一覧を重くしないよう、商談ごとには問い合わせず、商談履歴は必要な列と件数だけをまとめて読む。
 * - meet_auto の記録：予定のある商談は、その予定の会議になり得る時間帯（開始-24時間〜終了+3時間）の分だけ。
 *   予定の無い商談は、pickScheduledMeeting が選ぶ最新の1件だけ。
 * - 別経路の記録：自動取得を打ち切った商談だけ、最新の1件（予定の開始以降に作られたかを商談ごとに見る）。
 * - 場面の判定に使う最新の商談履歴：Meetが要対応の商談だけ、最新の1件の処理状態。
 * 呼び出し側は、自動記録が有効（FEATURE_MEET_AUTO_RECORD）で会議種別が自社Meetの商談だけを渡すこと。
 */
export async function dealIdsNeedingMeetAttention(
  deals: ReadonlyArray<DealMeetAttentionInput>,
  now: Date = new Date(),
): Promise<Set<string>> {
  const needsAttention = new Set<string>();
  // 受注・失注の商談（ヨミだけ受注の商談を含む）は、商談ページでも要対応を出さないので何も読まない。
  const open = deals.filter((deal) => dealMeetNeedsAttention("wrapup", "needs_attention", deal));
  if (open.length === 0) return needsAttention;

  const meetingSelect = {
    dealId: true, processingStatus: true, meetConferenceRecordId: true, meetingDate: true, durationSec: true,
  } as const;
  type MeetAutoRow = { dealId: string; processingStatus: string; meetConferenceRecordId: string | null; meetingDate: Date; durationSec: number | null };
  const meetAutoByDeal = new Map<string, MeetAutoRow[]>();
  const addMeetAuto = (row: MeetAutoRow) => {
    const list = meetAutoByDeal.get(row.dealId) ?? [];
    list.push(row);
    meetAutoByDeal.set(row.dealId, list);
  };

  const scheduled = open.filter((deal) => deal.meetingStartAt);
  if (scheduled.length > 0) {
    const rows = await prisma.meeting.findMany({
      where: {
        sourceType: MEETING_SOURCE_MEET_AUTO,
        OR: scheduled.map((deal) => {
          const window = conferenceRecordWindow(deal.meetingStartAt, deal.meetingEndAt);
          return {
            dealId: deal.id,
            meetingDate: {
              gte: new Date((deal.meetingStartAt as Date).getTime() - MEET_MAX_CONFERENCE_MS),
              ...(window && Number.isFinite(window.toMs) ? { lte: new Date(window.toMs) } : {}),
            },
          };
        }),
      },
      orderBy: { meetingDate: "desc" },
      select: meetingSelect,
    });
    rows.forEach(addMeetAuto);
  }
  const unscheduled = open.filter((deal) => !deal.meetingStartAt);
  if (unscheduled.length > 0) {
    const rows = await prisma.deal.findMany({
      where: { id: { in: unscheduled.map((deal) => deal.id) } },
      select: {
        id: true,
        meetings: {
          where: { sourceType: MEETING_SOURCE_MEET_AUTO },
          orderBy: { meetingDate: "desc" },
          take: 1,
          select: meetingSelect,
        },
      },
    });
    for (const row of rows) row.meetings.forEach(addMeetAuto);
  }

  const states = open.map((deal) => {
    const latest = pickScheduledMeeting(meetAutoByDeal.get(deal.id) ?? [], deal.meetingStartAt, deal.meetingEndAt);
    const giveUp = latest
      ? null
      : meetArtifactAutoFetchGiveUp({
          meetUrl: deal.meetUrl,
          meetEventId: deal.meetEventId,
          meetingEndAt: deal.meetingEndAt,
          artifactStatus: deal.meetArtifactStatus,
          artifactError: deal.meetArtifactError,
          attempts: deal.meetArtifactAttempts,
          checkedAt: deal.meetArtifactCheckedAt,
          now,
        });
    return { deal, latest, giveUp };
  });

  // 打ち切られた商談だけ、別経路の記録があるかを見る（dealMeetStatus と同じ条件）。条件に合う最新の1件が
  // 予定の開始より前に作られていれば、それより新しい記録は無い＝この予定の記録は無い、と判断できる。
  const rescueCandidates = states.filter((state) => state.giveUp && state.deal.meetingStartAt);
  const earliestStart = rescueCandidates.reduce<Date | null>((min, { deal }) => {
    const start = deal.meetingStartAt as Date;
    return !min || start < min ? start : min;
  }, null);
  const newestOtherRoute = new Map<string, { createdAt: Date; processingStatus: string }>();
  if (earliestStart) {
    const rows = await prisma.deal.findMany({
      where: { id: { in: rescueCandidates.map(({ deal }) => deal.id) } },
      select: {
        id: true,
        meetings: {
          where: otherRouteMeetingWhere(earliestStart),
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, processingStatus: true },
        },
      },
    });
    for (const row of rows) if (row.meetings[0]) newestOtherRoute.set(row.id, row.meetings[0]);
  }

  const meetAttention = states.filter(({ deal, latest, giveUp }) => {
    const start = deal.meetingStartAt;
    const newest = newestOtherRoute.get(deal.id);
    const other = giveUp && start && newest && newest.createdAt >= start ? newest : null;
    const phase = deriveMeetPhase({
      meetUrl: deal.meetUrl,
      meetingStartAt: deal.meetingStartAt,
      meetingEndAt: deal.meetingEndAt,
      configStatus: deal.meetArtifactConfigStatus,
      artifactStatus: deal.meetArtifactStatus,
      latestMeetingStatus: latest?.processingStatus ?? null,
      now,
      meetEventId: deal.meetEventId,
      artifactError: deal.meetArtifactError,
      attempts: deal.meetArtifactAttempts,
      checkedAt: deal.meetArtifactCheckedAt,
      otherRouteMeetingStatus: other?.processingStatus ?? null,
    });
    return phase === "needs_attention";
  });
  if (meetAttention.length === 0) return needsAttention;

  // 上部の要約と同じ場面判定（deriveDealPhase）。商談ページは最新の商談履歴（全経路、meetingDate の新しい順）の
  // 処理状態と件数を使うので、Meetが要対応の商談だけ最新の1件を読む。議事録の有無は「終了直後」と「商談後」を
  // 分けるだけで、どちらも要対応を出す場面なので読まない。
  const latestRows = await prisma.deal.findMany({
    where: { id: { in: meetAttention.map(({ deal }) => deal.id) } },
    select: { id: true, meetings: { orderBy: { meetingDate: "desc" }, take: 1, select: { processingStatus: true } } },
  });
  const latestByDeal = new Map(latestRows.map((row) => [row.id, row.meetings[0] ?? null]));
  for (const { deal } of meetAttention) {
    const latestMeeting = latestByDeal.get(deal.id) ?? null;
    const dealPhase = deriveDealPhase({
      meetingStartAt: deal.meetingStartAt,
      meetingEndAt: deal.meetingEndAt,
      meetUrl: deal.meetUrl,
      meetingsCount: latestMeeting ? 1 : 0,
      latestMeetingStatus: latestMeeting?.processingStatus ?? null,
      latestMeetingHasMinutes: false,
      now,
    });
    if (dealMeetNeedsAttention(dealPhase, "needs_attention", deal)) needsAttention.add(deal.id);
  }
  return needsAttention;
}
