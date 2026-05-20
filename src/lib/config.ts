// ============================================================
// 全社設定（リージー版）
// ============================================================

/**
 * 会計年度の開始月（1〜12）
 * リージーは1月始まり（12月決算）。
 * 例: 2026年1月〜2026年12月 = FY2026
 *
 * 型を `number` に広げているのは、将来的に他社展開時に値を変えても
 * リテラル型による意図しない比較警告が出ないようにするため。
 */
export const FISCAL_YEAR_START_MONTH: number = 1;

// ============================================================
// 会計年度ヘルパー
// ============================================================

/** 指定日が属する会計年度（FY2026 等の数字部分）を返す */
export function getFiscalYear(date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1; // 1〜12
  const y = date.getUTCFullYear();
  // 開始月以降ならその年がFY、開始月より前なら前年がFY
  return m >= FISCAL_YEAR_START_MONTH ? y : y - 1;
}

/** 指定日が属する会計年度の四半期（1〜4） */
export function getFiscalQuarter(date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1;
  const offset = (m - FISCAL_YEAR_START_MONTH + 12) % 12; // 0〜11
  return Math.floor(offset / 3) + 1;
}

/**
 * 会計年度の四半期インデックス（0〜3）から、その四半期に属する3ヶ月の暦月リストを返す
 * 例: FY2026 の Q1（6/7/8月）→ [{year:2026,month:6}, {year:2026,month:7}, {year:2026,month:8}]
 */
export function getFiscalQuarterMonths(
  fy: number,
  quarterIndex: number, // 0..3
): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const monthOffset = quarterIndex * 3 + i; // 0..11 from start month
    const m1 = FISCAL_YEAR_START_MONTH + monthOffset; // 6..17
    const yearAdd = Math.floor((m1 - 1) / 12);
    const month = ((m1 - 1) % 12) + 1;
    months.push({ year: fy + yearAdd, month });
  }
  return months;
}

/**
 * 会計年度の月インデックス（0〜11）から、その月の {year, month} を返す
 * 例: FY2026, idx=0 → {2026, 6} ／ idx=11 → {2027, 5}
 */
export function getFiscalMonth(fy: number, monthIndex: number): { year: number; month: number } {
  const m1 = FISCAL_YEAR_START_MONTH + monthIndex; // 6..17
  const yearAdd = Math.floor((m1 - 1) / 12);
  const month = ((m1 - 1) % 12) + 1;
  return { year: fy + yearAdd, month };
}

/** 指定日が会計年度の中で何ヶ月目か（0〜11） */
export function getFiscalMonthIndex(date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1;
  return (m - FISCAL_YEAR_START_MONTH + 12) % 12;
}

/** 会計年度の period ラベル（"FY2026"） */
export function fyPeriodLabel(fy: number): string {
  return `FY${fy}`;
}

/** 会計年度四半期 period ラベル（"FY2026-Q1"） */
export function fyQuarterPeriodLabel(fy: number, q: number): string {
  return `FY${fy}-Q${q}`;
}

/** 月次 period ラベル（"2026-06"） */
export function monthPeriodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 現在の会計年度 period ラベル */
export function currentFiscalYearPeriod(): string {
  return fyPeriodLabel(getFiscalYear());
}

/** 現在の会計四半期 period ラベル */
export function currentFiscalQuarterPeriod(): string {
  return fyQuarterPeriodLabel(getFiscalYear(), getFiscalQuarter());
}

/** 現在の月次 period ラベル（暦月） */
export function currentMonthPeriod(): string {
  const now = new Date();
  return monthPeriodLabel(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** 会計年度の表示用ラベル
 * - 開始月==1（暦年と一致）の場合: "FY2026（2026年1月〜12月）"
 * - それ以外の場合: "FY2026（2026年6月〜2027年5月）"
 */
export function fyDisplayLabel(fy: number): string {
  const startY = fy;
  const startM = FISCAL_YEAR_START_MONTH;
  const endMonth0 = (startM - 2 + 12) % 12;
  const endY = startM === 1 ? fy : fy + 1;
  const endM = endMonth0 + 1;
  if (startM === 1) {
    return `FY${fy}（${startY}年${startM}月〜${endM}月）`;
  }
  return `FY${fy}（${startY}年${startM}月〜${endY}年${endM}月）`;
}
