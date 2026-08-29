/**
 * 京プロ 撮影会人材派遣（リージー専用）の共通ロジック
 * ============================================================
 * 職種の表示名・配色、レートの解決、1アサインの金額計算、支払期日の算出を集約する。
 * 画面（Server / Client 両方）と取り込みスクリプトから同じ関数を使い、
 * 「どこで計算したかによって金額が違う」状態を作らない。
 *
 * 要件定義: docs/plan-kyopro-staffing.md
 */
import type { KyoproRole } from "@prisma/client";

export const KYOPRO_ROLES: KyoproRole[] = ["CAMERA", "SELECT", "MC", "GUIDE"];

export const ROLE_LABEL: Record<KyoproRole, string> = {
  CAMERA: "カメラ",
  SELECT: "セレクト",
  MC: "司会",
  GUIDE: "案内",
};

/**
 * 職種の配色。全画面で固定（カレンダー・詳細・請求明細で同じ色を使う）。
 * Tailwind は動的なクラス名を解決できないため、静的な文字列で持つ。
 *
 * 司会は要件定義ではアンバーだが、globals.css がリージー表示時に
 * orange / amber / yellow をまとめて緑系へ振り替えるため、セレクト（エメラルド）と
 * 見分けがつかなくなる。振り替え対象外の rose を使う。
 */
export const ROLE_STYLE: Record<
  KyoproRole,
  { text: string; bg: string; border: string; solid: string; ring: string }
> = {
  CAMERA: { text: "text-violet-700", bg: "bg-violet-50", border: "border-violet-200", solid: "bg-violet-500", ring: "ring-violet-500" },
  SELECT: { text: "text-emerald-700", bg: "bg-emerald-50", border: "border-emerald-200", solid: "bg-emerald-500", ring: "ring-emerald-500" },
  MC: { text: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200", solid: "bg-rose-500", ring: "ring-rose-500" },
  GUIDE: { text: "text-sky-700", bg: "bg-sky-50", border: "border-sky-200", solid: "bg-sky-500", ring: "ring-sky-500" },
};

/** クライアント・会場の識別色プリセット */
export const KYOPRO_COLOR_PRESETS = [
  "#0d6b52", // エメラルド
  "#0284c7", // スカイ
  "#7c3aed", // バイオレット
  "#c2710c", // アンバー
  "#be123c", // ローズ
  "#0f766e", // ティール
  "#4f46e5", // インディゴ
  "#65a30d", // ライム
];

export const SHOOT_KIND_LABEL: Record<string, string> = {
  SHOOT: "撮影",
  SETUP: "設営",
};

export const SHOOT_STATUS_LABEL: Record<string, string> = {
  PLANNED: "予定",
  CONFIRMED: "確定",
  DONE: "実施済",
  CANCELLED: "中止",
};

export const ASSIGN_STATUS_LABEL: Record<string, string> = {
  TENTATIVE: "仮",
  CONFIRMED: "確定",
  DONE: "実施済",
  CANCELLED: "キャンセル",
};

/**
 * 初期レート（1名1日あたり・税抜）。
 * 片付けは京プロへ +3,000 円請求し、人材への支払は発生しない（粗利 +3,000）。
 */
export const DEFAULT_RATES: Record<
  KyoproRole,
  { billRate: number; payRateDefault: number; payRateMin?: number; payRateMax?: number }
> = {
  CAMERA: { billRate: 35000, payRateDefault: 25000 },
  SELECT: { billRate: 35000, payRateDefault: 20000 },
  MC: { billRate: 25000, payRateDefault: 18000, payRateMin: 15000, payRateMax: 20000 },
  GUIDE: { billRate: 25000, payRateDefault: 20000 },
};

export const DEFAULT_CLEANUP_BILL = 3000;
export const DEFAULT_CLEANUP_PAY = 0;

export type RateLike = {
  role: KyoproRole;
  billRate: number;
  payRateDefault: number;
  payRateMin: number | null;
  payRateMax: number | null;
  cleanupBillAmount: number;
  cleanupPayAmount: number;
  effectiveFrom: Date;
};

/**
 * 撮影日時点で有効なレートを返す。
 * 同一職種に複数世代がある場合、撮影日以前で最も新しい effectiveFrom を採用する。
 * 該当が無ければ（レート改定前の過去日など）最も古い行にフォールバックする。
 */
export function resolveRate<T extends RateLike>(rates: T[], role: KyoproRole, date: Date): T | null {
  const ofRole = rates
    .filter((r) => r.role === role)
    .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
  if (ofRole.length === 0) return null;
  let picked: T | null = null;
  for (const r of ofRole) {
    if (r.effectiveFrom.getTime() <= date.getTime()) picked = r;
  }
  return picked ?? ofRole[0];
}

/** 人材ごとの個別発注単価（{ "MC": 18000 } 形式のJSON）を読む */
export function staffPayOverride(payOverrides: unknown, role: KyoproRole): number | null {
  if (!payOverrides || typeof payOverrides !== "object") return null;
  const v = (payOverrides as Record<string, unknown>)[role];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 1アサインの金額を決める。
 * 発注単価の優先順位は「手入力 > 人材の個別単価 > レートマスタの既定値」。
 */
export function computeAssignmentAmounts(opts: {
  rate: RateLike | null;
  role: KyoproRole;
  payOverrides?: unknown;
  /** 画面で手入力された発注単価（未指定なら自動決定） */
  payAmountInput?: number | null;
  /** 画面で手入力された受注単価（未指定ならレート） */
  billAmountInput?: number | null;
  cleanup?: boolean;
}) {
  const fallback = DEFAULT_RATES[opts.role];
  const billRate = opts.rate?.billRate ?? fallback.billRate;
  const payDefault = opts.rate?.payRateDefault ?? fallback.payRateDefault;
  const override = staffPayOverride(opts.payOverrides, opts.role);

  const billAmount = opts.billAmountInput ?? billRate;
  const payAmount = opts.payAmountInput ?? override ?? payDefault;
  const cleanup = opts.cleanup ?? false;

  return {
    billAmount,
    payAmount,
    cleanupBillAmount: cleanup ? (opts.rate?.cleanupBillAmount ?? DEFAULT_CLEANUP_BILL) : 0,
    cleanupPayAmount: cleanup ? (opts.rate?.cleanupPayAmount ?? DEFAULT_CLEANUP_PAY) : 0,
  };
}

/** 発注単価が職種の想定レンジ内か（範囲外でも保存はできるが画面で警告する） */
export function isPayRateOutOfRange(rate: RateLike | null, role: KyoproRole, pay: number): boolean {
  const min = rate?.payRateMin ?? DEFAULT_RATES[role].payRateMin ?? null;
  const max = rate?.payRateMax ?? DEFAULT_RATES[role].payRateMax ?? null;
  if (min !== null && pay < min) return true;
  if (max !== null && pay > max) return true;
  return false;
}

export type AssignmentAmounts = {
  billAmount: number;
  payAmount: number;
  cleanupBillAmount: number;
  cleanupPayAmount: number;
  adjustAmount: number;
  status?: string;
};

/** アサイン1件の受注額（京プロへの請求） */
export function billTotal(a: AssignmentAmounts): number {
  return a.billAmount + a.cleanupBillAmount;
}

/** アサイン1件の発注額（人材への支払） */
export function payTotal(a: AssignmentAmounts): number {
  return a.payAmount + a.cleanupPayAmount + a.adjustAmount;
}

/** キャンセル分を除いた集計（受注・発注・粗利） */
export function sumAssignments(list: AssignmentAmounts[]) {
  const live = list.filter((a) => a.status !== "CANCELLED");
  const bill = live.reduce((s, a) => s + billTotal(a), 0);
  const pay = live.reduce((s, a) => s + payTotal(a), 0);
  return { bill, pay, margin: bill - pay, count: live.length };
}

// ------------------------------------------------------------
// 日付ユーティリティ
// ------------------------------------------------------------

/** "2026-11" 形式の年月 */
export function toYearMonth(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function parseYearMonth(ym: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function monthRange(year: number, month: number) {
  // 月初 00:00 〜 翌月初 00:00（UTC基準。date列は @db.Date なので時差の影響を受けない）
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

export function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/**
 * 人材への支払期日 ＝ 撮影月 + payoutDueMonths ヶ月の月末。
 * 既定は 2（撮影があった月の翌々月末）。設定で 1（翌月末）にも変えられる。
 */
export function payoutDueDate(yearMonth: string, payoutDueMonths: number): Date {
  const parsed = parseYearMonth(yearMonth);
  if (!parsed) throw new Error(`不正な年月です: ${yearMonth}`);
  // 翌月の0日 = 当月末日
  return new Date(Date.UTC(parsed.year, parsed.month + payoutDueMonths, 0));
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「11/7（土）」形式 */
export function formatShootDate(date: Date): string {
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}（${WEEKDAYS[date.getUTCDay()]}）`;
}

export function isWeekend(date: Date): boolean {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}

export function formatJPY(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

// ------------------------------------------------------------
// 依頼人数 / 充足
// ------------------------------------------------------------

export type RequiredCounts = Partial<Record<KyoproRole, number>>;

export function parseRequiredCounts(json: unknown): RequiredCounts {
  if (!json || typeof json !== "object") return {};
  const src = json as Record<string, unknown>;
  const out: RequiredCounts = {};
  for (const role of KYOPRO_ROLES) {
    const v = src[role];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[role] = v;
  }
  return out;
}

export function requiredTotal(counts: RequiredCounts): number {
  return KYOPRO_ROLES.reduce((s, r) => s + (counts[r] ?? 0), 0);
}

/**
 * 充足状況。依頼人数が未設定の撮影会は「不足なし」として扱う
 * （依頼人数が空欄のままアサインだけ入っている行が実データにあるため）。
 */
export function fulfillment(counts: RequiredCounts, assigned: Record<string, number>) {
  const required = requiredTotal(counts);
  const filled = KYOPRO_ROLES.reduce((s, r) => s + (assigned[r] ?? 0), 0);
  const shortage = KYOPRO_ROLES.reduce(
    (s, r) => s + Math.max(0, (counts[r] ?? 0) - (assigned[r] ?? 0)),
    0,
  );
  return { required, filled, shortage, isShort: shortage > 0 };
}

export type ShootLike = {
  requiredCounts: unknown;
  assignments: (AssignmentAmounts & { role: KyoproRole })[];
};

/**
 * 撮影会1件の指標。カレンダーのバッジ・一覧の金額列・月次サマリで同じ値を使う。
 * キャンセルしたアサインは人数にも金額にも数えない。
 */
export function shootMetrics(shoot: ShootLike) {
  const counts = parseRequiredCounts(shoot.requiredCounts);
  const live = shoot.assignments.filter((a) => a.status !== "CANCELLED");
  const assigned: Record<string, number> = {};
  for (const a of live) assigned[a.role] = (assigned[a.role] ?? 0) + 1;
  return {
    // 職種別の依頼人数。fulfillment() が返す required は合計人数なので名前を分ける。
    requiredByRole: counts,
    assigned,
    ...fulfillment(counts, assigned),
    ...sumAssignments(live),
  };
}
