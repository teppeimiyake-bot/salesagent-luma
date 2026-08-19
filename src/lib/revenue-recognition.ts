/**
 * 売上計上（レベニューレコグニション）の共通ロジック。
 *
 * 社長判断 2026-08：
 *   SNS運用は「毎月売上が発生する継続契約」。受注時点で契約総額（初期費用＋月額×6ヶ月）を
 *   受注月に一括計上すると、受注月だけ数字が跳ね、実際に売上が立っている契約期間中の
 *   月次売上がゼロに見えてしまう。
 *     → SNSは 契約初月 = 初期費用（既定10万円）＋ 月額、2ヶ月目以降 = 月額 として
 *       契約期間中の各月へ分割計上する。
 *     → 映像 / CATV / アライアンス（スポット商材）は従来どおり受注計上日の月に全額計上。
 *
 * このモジュールは純粋関数のみ（DBアクセスなし）。DBから引いた値の詰め替えは
 * queries.ts 側（getRevenueEntries）が担当する。
 */
import { categoryFromDealProduct, type ProductCategory } from "@/lib/product-categories";

/** SNS初期費用の既定値（税抜10万円）。契約に個別の初期費用が記録されていればそちらが優先。 */
export const SNS_DEFAULT_INITIAL_FEE = 100_000;
/** SNS契約期間の既定値（契約開始/終了月が未登録のときのフォールバック）。 */
export const SNS_DEFAULT_MONTHS = 6;

/** 年月を YYYYMM の整数で表す（RecurringBillingPeriod.yearMonth と同じ表現）。 */
export type YearMonth = number;

/** Date → YYYYMM（KPIの月帰属判定がUTCレンジなのでUTCで揃える） */
export function toYearMonth(d: Date): YearMonth {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

/** YYYYMM に n ヶ月加算 */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const y = Math.floor(ym / 100);
  const m = (ym % 100) - 1 + n;
  return (y + Math.floor(m / 12)) * 100 + (((m % 12) + 12) % 12) + 1;
}

/** start〜end（両端含む）の月数。end < start なら null。 */
export function monthSpan(start: YearMonth, end: YearMonth): number | null {
  if (end < start) return null;
  const ys = Math.floor(start / 100);
  const ms = start % 100;
  const ye = Math.floor(end / 100);
  const me = end % 100;
  return (ye - ys) * 12 + (me - ms) + 1;
}

/** YYYYMM → "YYYY-MM"（Goal.period / KPI月次ラベルと同じ表記） */
export function yearMonthToPeriod(ym: YearMonth): string {
  return `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, "0")}`;
}

/** 1件の DealProduct から生成される「ある月の売上」1行 */
export type RevenueEntry = {
  /** DealProduct.id */
  dealProductId: string;
  /** 計上年月（YYYYMM） */
  yearMonth: YearMonth;
  /** その月に計上する売上（円） */
  amount: number;
  /** スポット一括計上 or SNS月次計上 */
  kind: "spot" | "recurring";
  /** SNSのとき「何ヶ月目 / 全何ヶ月」。スポットは null。 */
  monthIndex: number | null;
  totalMonths: number | null;
  /** 初月（初期費用を含む月）か */
  includesInitialFee: boolean;
};

/** 売上計上の元になる DealProduct（DBから引いた形をそのまま渡せる最小型） */
export type RevenueSourceProduct = {
  id: string;
  productName: string;
  planName?: string | null;
  amount: number | null;
  yomiStatus?: string | null;
  product?: { name?: string | null; category?: string | null } | null;
  /** 入金管理（定期）の契約条件。最新1件を渡す。 */
  recurring?: {
    initialFee: number | null;
    monthlyFee: number | null;
    startDate: Date | null;
    endDate: Date | null;
  } | null;
  /** PM（ProductionProject）のSNS提供開始/終了月 */
  production?: {
    category?: string | null;
    serviceStartMonth: Date | null;
    serviceEndMonth: Date | null;
  } | null;
};

/**
 * 商材カテゴリ判定。yomiStatus接頭辞 → 商材名 → PMカテゴリ の順に見る。
 * （PMカテゴリは Notion同期で入るため、商材名が「SNS」でない契約の救済に使う）
 */
export function revenueCategory(p: RevenueSourceProduct): ProductCategory | null {
  const byName = categoryFromDealProduct(p);
  if (byName) return byName;
  const ppCat = p.production?.category ?? null;
  if (ppCat === "映像" || ppCat === "SNS" || ppCat === "CATV" || ppCat === "アライアンス") {
    return ppCat;
  }
  return null;
}

/** SNS（継続課金）として月次按分する商材か */
export function isRecurringProduct(p: RevenueSourceProduct): boolean {
  return revenueCategory(p) === "SNS";
}

/** SNS契約の計上条件（開始月・月数・初期費用・月額） */
export type RecurringPlan = {
  startYm: YearMonth;
  months: number;
  initialFee: number;
  monthlyFee: number;
  /** 月額が提案金額からの逆算か（契約に月額が登録されていない場合 true） */
  monthlyFeeDerived: boolean;
  /** 逆算のもとにした契約総額（提案金額）。端数を最終月で吸収して合計を一致させるために使う。 */
  derivedTotal: number | null;
};

/**
 * SNS契約の計上条件を決める。
 *
 * 開始月：入金管理の契約開始日 → PMの提供開始月 → 受注計上日 の優先。
 * 月数　：契約開始〜終了（両端含む）。終了月が無ければ既定6ヶ月。
 * 初期費用：入金管理の初期費用。未登録なら既定10万円。
 * 月額　：入金管理の月額。未登録なら提案金額から逆算（(総額 - 初期費用) ÷ 月数）。
 *         ※逆算は契約書ドラフト生成（contract-generate.ts）と同じ考え方。
 *
 * 金額が一切分からない（月額も提案金額も無い）契約は null を返し、売上を作らない。
 */
export function recurringPlan(
  p: RevenueSourceProduct,
  bookedDate: Date | null,
): RecurringPlan | null {
  const startSrc = p.recurring?.startDate ?? p.production?.serviceStartMonth ?? bookedDate;
  if (!startSrc) return null;
  const startYm = toYearMonth(startSrc);

  const endSrc = p.recurring?.endDate ?? p.production?.serviceEndMonth ?? null;
  const span = endSrc ? monthSpan(startYm, toYearMonth(endSrc)) : null;
  const months = span ?? SNS_DEFAULT_MONTHS;

  const initialFee = p.recurring?.initialFee ?? SNS_DEFAULT_INITIAL_FEE;

  let monthlyFee = p.recurring?.monthlyFee ?? 0;
  let monthlyFeeDerived = false;
  let derivedTotal: number | null = null;
  if (monthlyFee <= 0) {
    const total = p.amount ?? 0;
    if (total <= 0) return null; // 月額も提案金額も無い＝売上を作れない
    // 提案金額に初期費用が含まれている前提で逆算。含まれていない古いデータ（総額＝月額×月数）も
    // 「総額 ≦ 初期費用」でなければ同じ式で概ね妥当な月額になる。
    monthlyFee = Math.round(Math.max(0, total - initialFee) / months);
    if (monthlyFee <= 0) monthlyFee = Math.round(total / months);
    monthlyFeeDerived = true;
    derivedTotal = total;
  }

  return { startYm, months, initialFee, monthlyFee, monthlyFeeDerived, derivedTotal };
}

/**
 * DealProduct 1件を「月ごとの売上」に展開する。
 *
 * - SNS：契約初月 = 初期費用 + 月額、2ヶ月目以降 = 月額（契約期間中の各月）
 * - それ以外：受注計上日の月に提案金額を全額計上（従来どおり）
 *
 * @param p          受注済み DealProduct（受注判定は呼び出し側の責務）
 * @param bookedDate 受注計上日（contractDate → appointmentDate → bantUpdatedAt の確定値）
 */
export function revenueEntries(
  p: RevenueSourceProduct,
  bookedDate: Date | null,
): RevenueEntry[] {
  if (isRecurringProduct(p)) {
    const plan = recurringPlan(p, bookedDate);
    if (!plan) return [];
    // 月額を提案金額から逆算した場合は、四捨五入の端数を最終月で吸収して
    // 「各月の合計 = 提案金額」になるようにする（総額が1〜2円ずれるのを防ぐ）。
    const rounding =
      plan.monthlyFeeDerived && plan.derivedTotal != null
        ? plan.derivedTotal - (plan.initialFee + plan.monthlyFee * plan.months)
        : 0;
    return Array.from({ length: plan.months }, (_, i) => ({
      dealProductId: p.id,
      yearMonth: addMonths(plan.startYm, i),
      amount:
        plan.monthlyFee +
        (i === 0 ? plan.initialFee : 0) +
        (i === plan.months - 1 ? rounding : 0),
      kind: "recurring" as const,
      monthIndex: i + 1,
      totalMonths: plan.months,
      includesInitialFee: i === 0,
    }));
  }

  if (!bookedDate) return [];
  const amount = p.amount ?? 0;
  return [
    {
      dealProductId: p.id,
      yearMonth: toYearMonth(bookedDate),
      amount,
      kind: "spot",
      monthIndex: null,
      totalMonths: null,
      includesInitialFee: false,
    },
  ];
}
