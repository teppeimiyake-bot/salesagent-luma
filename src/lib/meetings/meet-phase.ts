/**
 * Meet自動記録（T16）の進行フェーズ判定（純関数）。
 *
 * Prisma の型に依存しないプレーンな入力だけを受け取る。
 * DBを持たない検証スクリプト（scripts/check-t16-meet.mts）から直接テストできるように
 * meet-ingest.ts 本体（prisma を import する）から切り離してある。
 * meet-ingest.ts からも再エクスポートしているので、呼び出し側はどちらから import してもよい。
 */

export type MeetPhase =
  | "no_schedule"
  | "scheduled_unissued"
  | "scheduled"
  | "configured"
  | "config_failed"
  | "in_progress"
  | "waiting_artifacts"
  | "fetching"
  | "analyzing"
  /** 別経路（手入力のテキスト記録など）で記録は残せたが、AI分析はまだ（議事録要約が無い）。 */
  | "recorded"
  | "completed"
  | "needs_attention";

/**
 * 自動取得（cron: src/app/api/cron/meet-artifacts/route.ts の LOOKBACK_DAYS）が成果物を追いかける期間。
 * 会議記録はMeet側で30日で消えるため、商談終了から7日より古い商談はcronが拾わない。
 * cron 側の値と必ず揃える（tests/t16-cron-budget.test.mjs で突き合わせている）。
 */
export const MEET_ARTIFACT_LOOKBACK_DAYS = 7;
export const MEET_ARTIFACT_LOOKBACK_MS = MEET_ARTIFACT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

/** 自動取得の期間を過ぎても成果物が無いときの案内。DBには保存せず、状態表示のときに導く。 */
export const MEET_ARTIFACT_LOOKBACK_EXPIRED_MESSAGE =
  `商談終了から${MEET_ARTIFACT_LOOKBACK_DAYS}日を過ぎたため、自動取得を終了しました。Meetの文字起こしが作られていない可能性があります。「成果物を取得」で再試行できます。`;

/**
 * 成果物取得の試行上限。空振りが続く商談をcronが延々と叩き続けないための歯止め。
 * cron（meetArtifactAttempts < 上限の商談だけを拾う）は meet-ingest.ts の再エクスポート経由で同じ値を使う。
 */
export const MEET_ARTIFACT_MAX_ATTEMPTS = 20;

/**
 * 試行上限に達しても成果物が無いとき、商談に保存する理由。
 * cron は上限に達した商談を拾わないので、「成果物待ち」のまま放置せず失敗（要対応）として見せる。
 * 状態表示では、この理由の failed を「自動取得の打ち切り」（本物の取得エラーではない）として見分ける。
 */
export const MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE =
  "自動取得の上限に達しました。Meetの文字起こしが作られていない可能性があります。「成果物を取得」で再試行できます。";

/**
 * fetching のまま、最終確認からこれ以上たった商談は、取得処理が途中で落ちたとみなす。
 * 取得処理は cron・手動（POST /api/deals/[id]/meet/artifacts）とも maxDuration 300秒で打ち切られるので、その倍を取る。
 * これより新しい fetching は取得の実行中として扱い、打ち切りと判定しない（実行中に「取得失敗」と出さない）。
 */
export const MEET_ARTIFACT_FETCH_STALE_MS = 10 * 60 * 1000;

/** cron が拾い続ける（＝まだ自動取得に任せている）成果物の取得状態。null は未着手。 */
const AUTO_FETCH_PENDING_STATUSES: ReadonlyArray<string | null> = [null, "waiting", "fetching"];

/** 自動取得を打ち切った理由。attempts_exhausted＝試行上限、lookback_expired＝商談終了から7日の期間切れ。 */
export type MeetAutoFetchGiveUp = "attempts_exhausted" | "lookback_expired";

export type MeetAutoFetchState = {
  meetUrl: string | null;
  /** Calendar予定のID。cron は meetEventId のある商談しか拾わない。省略時は未発行とみなす。 */
  meetEventId?: string | null;
  meetingEndAt: Date | null;
  artifactStatus: string | null;
  artifactError?: string | null;
  attempts?: number;
  /** 最終確認日時（取得開始時にも更新される）。fetching が実行中か、途中で落ちたかの判断に使う。 */
  checkedAt?: Date | null;
  now: Date;
};

/** 取り込み側（meet-ingest.ts の settleWaiting）が試行上限で保存した failed か。本物の取得エラーの failed とは区別する。 */
export function isMeetArtifactAttemptsExhaustedFailure(input: {
  artifactStatus: string | null;
  artifactError?: string | null;
}): boolean {
  return input.artifactStatus === "failed" && input.artifactError === MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE;
}

/**
 * 成果物が無いまま、自動取得（cron: src/app/api/cron/meet-artifacts/route.ts）が打ち切られたか。null はまだ自動取得に任せている
 * （または自動取得の対象外）。打ち切られた商談は手動の「成果物を取得」以外ではもう取り込まれないので、「成果物待ち」のまま
 * 放置せず要対応として見せるのに使う。次のどれかに当たるものを打ち切りとする。
 * - 取り込み側が試行上限で保存した failed（MEET_ARTIFACT_ATTEMPTS_EXHAUSTED_MESSAGE）。
 * - cron の対象になる商談（Meet発行済み＝meetUrl と meetEventId がある、終了日時がある、未着手・待ち・取得中）のうち、
 *   商談終了が「いま − 7日」より前のもの（cron の meetingEndAt >= since から外れた）。
 * - 同じく、保存済みの試行回数が上限以上のもの（cron の meetArtifactAttempts < 上限から外れた）。上限に達したまま
 *   waiting・fetching で残った行（上限の打ち切りを入れる前の行や、20回目の取得が途中で落ちた行）は取り込み側が failed を
 *   書けていないので、ここで導く。
 * Meet未発行の商談は cron が拾わず「成果物を取得」も押せないので、打ち切りとは扱わない（「再試行できます」と案内しない）。
 * 取得の実行中（最終確認から MEET_ARTIFACT_FETCH_STALE_MS 未満の fetching）も、結果が出るまで打ち切りとは扱わない。
 */
export function meetArtifactAutoFetchGiveUp(input: MeetAutoFetchState): MeetAutoFetchGiveUp | null {
  if (isMeetArtifactAttemptsExhaustedFailure(input)) return "attempts_exhausted";
  if (!input.meetUrl || !input.meetEventId) return null;
  if (!input.meetingEndAt || !AUTO_FETCH_PENDING_STATUSES.includes(input.artifactStatus)) return null;
  const fetchInFlight =
    input.artifactStatus === "fetching" &&
    input.checkedAt != null &&
    input.now.getTime() - input.checkedAt.getTime() < MEET_ARTIFACT_FETCH_STALE_MS;
  if (fetchInFlight) return null;
  if (input.meetingEndAt.getTime() < input.now.getTime() - MEET_ARTIFACT_LOOKBACK_MS) return "lookback_expired";
  if ((input.attempts ?? 0) >= MEET_ARTIFACT_MAX_ATTEMPTS) return "attempts_exhausted";
  return null;
}

export type MeetPhaseInput = {
  meetUrl: string | null;
  meetingStartAt: Date | null;
  meetingEndAt: Date | null;
  configStatus: string | null;
  artifactStatus: string | null;
  /** 直近の meet_auto 商談履歴の processingStatus（無ければ null） */
  latestMeetingStatus: string | null;
  now: Date;
  // 以下は自動取得の打ち切り（meetArtifactAutoFetchGiveUp）の判定に使う。省略すると Meet未発行・試行0回として扱う。
  meetEventId?: string | null;
  artifactError?: string | null;
  attempts?: number;
  checkedAt?: Date | null;
  /**
   * 別経路（ブラウザ録音・手動添付・手入力）で、この予定の開始以降に作られた商談履歴の processingStatus（無ければ null）。
   * どの履歴を数えるかは dealMeetStatus（meet-ingest.ts）の規則で決める。
   */
  otherRouteMeetingStatus?: string | null;
  /**
   * その別経路の記録に AI分析の結果（議事録要約 summary）があるか。
   * 手入力のテキスト記録（manual_text）は processingStatus の既定が completed でも AI分析は走っていないので、
   * completed だけで「AI分析まで完了」と言わないために使う。false なら「記録あり（AI分析は未実施）」にする。
   * 省略（undefined）は従来どおり completed を完了として扱う。
   */
  otherRouteMeetingAnalyzed?: boolean;
};

export function deriveMeetPhase(input: MeetPhaseInput): MeetPhase {
  const { meetUrl, meetingStartAt, meetingEndAt, configStatus, artifactStatus, now } = input;
  const latest = input.latestMeetingStatus;

  // 成果物取得後：AI分析の状態が最優先（ここまで来ていれば設定状態は結果に影響しない）
  if (latest === "completed") return "completed";
  if (latest === "analyzing" || latest === "transcribed") return "analyzing";
  if (latest === "error") return "needs_attention";

  // 成果物が無いまま自動取得が打ち切られた（試行上限・期間切れ）：cron はもう拾わないので、待ち・取得中のままにせず要対応にする。
  // ただし別経路の記録で会議を残せている（T16 AC8 の救済経路を使った）なら、Meetの打ち切りは対応待ちではないので、
  // その記録の処理状況を出す（処理に失敗した記録は数えない＝要対応のまま）。
  if (meetArtifactAutoFetchGiveUp(input)) {
    const other = input.otherRouteMeetingStatus;
    if (other && other !== "error") {
      if (other !== "completed") return "analyzing";
      return input.otherRouteMeetingAnalyzed === false ? "recorded" : "completed";
    }
    return "needs_attention";
  }
  if (artifactStatus === "failed") return "needs_attention";
  if (artifactStatus === "fetched") return "analyzing";
  if (artifactStatus === "fetching") return "fetching";

  // 日時未設定＝そもそも自動記録の対象外
  if (!meetingStartAt || !meetingEndAt) return "no_schedule";

  // 商談が終わっているなら成果物待ち（設定失敗していても待ちは待ち：理由は別途表示する）
  if (meetingEndAt.getTime() <= now.getTime()) {
    if (configStatus === "failed") return "needs_attention";
    return "waiting_artifacts";
  }

  // 商談中
  if (meetingStartAt.getTime() <= now.getTime()) return "in_progress";

  // 商談前
  if (configStatus === "failed") return "config_failed";
  if (configStatus === "configured") return "configured";
  if (meetUrl) return "scheduled";
  return "scheduled_unissued";
}
