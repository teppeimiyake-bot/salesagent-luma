/**
 * 商談ページ（T15）の「いまどの場面か」を判定する純粋関数群。
 *
 * 目的：
 *   商談ページを開いた人が、スクロールして探さなくても
 *   「いま自分は商談前なのか・終わった直後なのか・次に何を押すのか」を
 *   1画面目で分かるようにする。判定はサーバ・クライアント双方から使うため、
 *   prisma も React も import しない純粋関数だけで構成する。
 *
 * 設計方針（T15 受け入れ条件より）：
 *   - 場面は「商談前 / 開始直前 / 商談中 / 終了直後 / 商談後」の5つに畳む。
 *   - 場面ごとに「いま押すべき操作」を1つだけ主役にする。副次操作は並べない。
 *   - 判定できないときは無理に断定せず "planning" に倒す（誤誘導しない）。
 */

import { isWonYomi } from "@/lib/yomi-status";

/** 商談ページの場面。UIの主役操作とセクションの開閉に使う。 */
export type DealPhase =
  | "planning" // 商談前：日時がまだ決まっていない
  | "scheduled" // 商談前：日時は決まっている（Meet発行・事前準備の段階）
  | "imminent" // 開始直前：開始15分前〜開始
  | "live" // 商談中
  | "wrapup" // 終了直後：成果物・議事録がまだ揃っていない
  | "followup"; // 商談後：議事録まで揃い、次の一手を進める段階

export const DEAL_PHASE_LABEL: Record<DealPhase, string> = {
  planning: "商談前",
  scheduled: "商談前",
  imminent: "まもなく開始",
  live: "商談中",
  wrapup: "終了直後",
  followup: "商談後",
};

/**
 * 場面の説明文。「いま何をする時間か」を1行で言い切る。
 * 忙しさを感じさせないよう、状態の羅列ではなく行動の言葉にする。
 */
export const DEAL_PHASE_CAPTION: Record<DealPhase, string> = {
  planning: "商談日時を決めるところから始めます",
  scheduled: "商談に向けて準備を整えます",
  imminent: "まもなく開始です。Meetに参加してください",
  live: "商談中です。記録はLumaが引き受けます",
  wrapup: "商談の記録を取り込んでいます",
  followup: "議事録を確認し、次の一手を進めます",
};

/** 主役操作の種類。UI側はこれを見てボタンの見た目と遷移先を決める。 */
export type DealPrimaryActionKind =
  | "set_schedule" // 商談日時セクションへ
  | "issue_meet" // Meet発行（商談日時セクションへ）
  | "join_meet" // Meet URLを開く
  | "collect_artifacts" // 商談の記録セクションへ
  | "review_minutes" // 商談履歴セクションへ
  | "set_next_action"; // 次の一手へ

export type DealPrimaryAction = {
  kind: DealPrimaryActionKind;
  label: string;
  /** ページ内アンカー（section id）。外部リンクのときは null。 */
  targetSectionId: string | null;
  /** 外部リンク（Meet URL）。ページ内遷移のときは null。 */
  href: string | null;
  /** ボタンの下に添える1行の理由。押した先で何が起きるかを事前に分からせる。 */
  hint: string;
};

/** 場面判定の入力。Date は ISO文字列でも Date でも受ける。 */
export type DealPhaseInput = {
  meetingStartAt?: Date | string | null;
  meetingEndAt?: Date | string | null;
  meetUrl?: string | null;
  /** 商談履歴（Meeting）の件数 */
  meetingsCount?: number;
  /** 最新 Meeting の processingStatus（uploaded/transcribing/transcribed/analyzing/completed/error） */
  latestMeetingStatus?: string | null;
  /** 最新 Meeting が議事録本文を持っているか */
  latestMeetingHasMinutes?: boolean;
  /** 判定時刻。テスト容易性のため外から渡せるようにする。 */
  now?: Date | string | null;
};

/** 開始何分前から「まもなく開始」とみなすか。 */
export const IMMINENT_WINDOW_MIN = 15;
/** 終了後どれだけの間を「終了直後」とみなすか（成果物生成の待ち時間を見込む）。 */
export const WRAPUP_WINDOW_HOURS = 48;

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 商談ページの場面を判定する。
 *
 * 時刻が無い商談（日時未設定・過去のNotion取込データ等）でも破綻しないよう、
 * 「時刻で決まらないときは商談履歴の有無で決める」という順序にしている。
 */
export function deriveDealPhase(input: DealPhaseInput): DealPhase {
  const now = toDate(input.now) ?? new Date();
  const start = toDate(input.meetingStartAt);
  const end = toDate(input.meetingEndAt);
  const meetingsCount = input.meetingsCount ?? 0;
  const hasMinutes = input.latestMeetingHasMinutes === true;
  const status = input.latestMeetingStatus ?? null;

  // 記録の取り込み・解析が動いている最中は、時刻より処理状態を優先する。
  // （商談が長引いて終了時刻を過ぎている、といったズレに引きずられないため）
  const processing =
    status === "uploaded" ||
    status === "transcribing" ||
    status === "transcribed" ||
    status === "analyzing";
  if (processing) return "wrapup";

  if (start) {
    const imminentFrom = new Date(start.getTime() - IMMINENT_WINDOW_MIN * 60_000);
    // 終了時刻が無い商談は、開始から2時間を仮の終了とみなす。
    const effectiveEnd = end ?? new Date(start.getTime() + 2 * 60 * 60_000);
    const wrapupUntil = new Date(effectiveEnd.getTime() + WRAPUP_WINDOW_HOURS * 60 * 60_000);

    if (now < imminentFrom) return "scheduled";
    if (now < start) return "imminent";
    if (now <= effectiveEnd) return "live";
    if (now <= wrapupUntil) {
      // 終了直後でも、議事録まで揃っていれば商談後として扱う。
      return hasMinutes ? "followup" : "wrapup";
    }
    // 終了から時間が経っている：記録が無ければ取りこぼしとして終了直後を維持する。
    return hasMinutes || meetingsCount > 0 ? "followup" : "wrapup";
  }

  // 日時が無い商談。履歴があるなら過去商談として商談後、無ければ計画段階。
  if (meetingsCount > 0) return "followup";
  return "planning";
}

/**
 * 場面から「いま押すべき操作」を1つ決める。
 *
 * 迷わせないため、返すのは常に1件。副次操作をここに混ぜない
 * （複数出すとユーザーはどれが正解かを推論しなければならなくなる）。
 */
export function deriveDealPrimaryAction(
  phase: DealPhase,
  input: {
    /**
     * 自社発行MeetのURL。会議種別を変えても deals.meet_url は残るため、
     * 自社Meet以外の商談では渡さないこと（渡すと古い自社Meetへの参加を主役にしてしまう。T21/T24）。
     */
    meetUrl?: string | null;
    hasSchedule: boolean;
    hasMinutes: boolean;
  },
): DealPrimaryAction {
  const meetUrl = input.meetUrl && input.meetUrl.length > 0 ? input.meetUrl : null;

  switch (phase) {
    case "planning":
      return {
        kind: "set_schedule",
        label: "商談日時を設定する",
        targetSectionId: "section-deal-status",
        href: null,
        hint: "日時を保存すると、Google Meetの発行までまとめて行えます",
      };

    case "scheduled":
      if (!meetUrl) {
        return {
          kind: "issue_meet",
          label: "Google Meetを発行する",
          targetSectionId: "section-deal-status",
          href: null,
          hint: "商談情報の「商談日時」からMeetを発行します",
        };
      }
      return {
        kind: "set_next_action",
        label: "事前準備を確認する",
        targetSectionId: "section-preparation",
        href: null,
        hint: "ブリーフと過去のBANTを見てから商談に臨みます",
      };

    case "imminent":
    case "live":
      if (meetUrl) {
        return {
          kind: "join_meet",
          label: "Meetに参加する",
          targetSectionId: null,
          href: meetUrl,
          hint: "新しいタブで開きます。Luma側の録音操作は不要です",
        };
      }
      return {
        kind: "issue_meet",
        label: "Google Meetを発行する",
        targetSectionId: "section-deal-status",
        href: null,
        hint: "商談情報の「商談日時」からMeetを発行します",
      };

    case "wrapup":
      return {
        kind: "collect_artifacts",
        label: "商談の記録を確認する",
        targetSectionId: "group-record",
        href: null,
        hint: "取得状況を確認し、必要なら手動で取り込みます",
      };

    case "followup":
      return {
        kind: input.hasMinutes ? "review_minutes" : "collect_artifacts",
        label: input.hasMinutes ? "議事録を確認する" : "商談の記録を確認する",
        targetSectionId: input.hasMinutes ? "section-history" : "group-record",
        href: null,
        hint: input.hasMinutes
          ? "議事録からBANT・次の一手・見積へつなげます"
          : "この商談の記録がまだありません。取り込みを確認します",
      };
  }
}

/** 受注・失注で閉じた商談のフェーズ（deals.status）。Meetの記録の要対応は出さない。 */
const CLOSED_DEAL_STATUSES: ReadonlySet<string> = new Set(["WON", "LOST"]);

/** 受注・失注の判定に使う商談の値。 */
export type DealClosedInput = {
  /** deals.status */
  status?: string | null;
  /** 配下プロダクトのヨミ（DealProduct.yomiStatus） */
  products?: ReadonlyArray<{ yomiStatus: string | null }> | null;
};

/**
 * 受注・失注で閉じた商談か。deals.status が WON/LOST のほか、配下プロダクトのどれかのヨミが受注（isWonYomi）なら受注とみなす。
 * Notion 取り込みの商談は deals.status が LEAD のままで、受注の事実はヨミだけにある（src/lib/deal-aggregations.ts の isWonDeal）。
 * 商談一覧の「受注後」タブ（src/app/(app)/deals/page.tsx の isWonDeal）と同じ見方にそろえる。
 */
export function isDealClosed(deal: DealClosedInput | null | undefined): boolean {
  if (!deal) return false;
  if (deal.status && CLOSED_DEAL_STATUSES.has(deal.status)) return true;
  return (deal.products ?? []).some((p) => isWonYomi(p.yomiStatus));
}

/**
 * T16：商談が終わった後（終了直後・商談後）に、自社Meetの記録を自動で取り込めなかった
 * （Meetセッションが「確認が必要です」＝自動取得の打ち切り・取得エラーなど）かどうか。
 * 商談前（リスケ後の次回商談など）と、受注・失注で閉じた商談には要対応を出さない。
 * 商談ページ上部の要約（DealHero）と商談一覧の「要対応」は、どちらもこの関数で判定する。
 */
export function dealMeetNeedsAttention(
  phase: DealPhase,
  meetPhase: string | null | undefined,
  deal?: DealClosedInput | null,
): boolean {
  if (isDealClosed(deal)) return false;
  return meetPhase === "needs_attention" && (phase === "wrapup" || phase === "followup");
}

/** Meetの記録が要対応のときに、要約（DealHero）の場面ラベル・説明・主操作を差し替える文言。 */
export const DEAL_MEET_ATTENTION_LABEL = "要対応";
export const DEAL_MEET_ATTENTION_CAPTION = "Meetの記録を自動で取り込めませんでした。商談記録で確認してください";
export const DEAL_MEET_ATTENTION_ACTION: DealPrimaryAction = {
  kind: "collect_artifacts",
  label: "商談の記録を確認する",
  targetSectionId: "group-record",
  href: null,
  hint: "自動取得は終了しています。「成果物を取得」で再試行するか、記録を手動で添付します",
};

/** 4ステップの進行表示。現在地だけを強調し、残りは淡く置く。 */
export const DEAL_PHASE_STEPS: ReadonlyArray<{ id: string; label: string; phases: DealPhase[] }> = [
  { id: "prepare", label: "準備", phases: ["planning", "scheduled"] },
  { id: "meet", label: "商談", phases: ["imminent", "live"] },
  { id: "record", label: "記録", phases: ["wrapup"] },
  { id: "follow", label: "推進", phases: ["followup"] },
];

/** 現在の場面が4ステップのどこにあたるか（0始まり）。 */
export function dealPhaseStepIndex(phase: DealPhase): number {
  const i = DEAL_PHASE_STEPS.findIndex((s) => s.phases.includes(phase));
  return i < 0 ? 0 : i;
}
