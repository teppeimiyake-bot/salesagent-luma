// ============================================================
// 全社設定（Luma版）
// ============================================================

/**
 * 会計年度の開始月は会社ごとに異なるため、定数ではなく引数で受け取る。
 *   株式会社Luma     … 6（6月始まり・5月決算）
 *   株式会社リージー … 1（1月始まり・12月決算）
 *
 * 値の取得元:
 *   - サーバー側     … getFiscalStartMonth()（src/lib/tenant-context.ts）
 *                      選択中の会社の Tenant.fiscalYearStartMonth を返す
 *   - クライアント側 … props で受け取る（コンポーネント側に会社を知る手段がないため）
 *
 * かつての FISCAL_YEAR_START_MONTH 定数は、Luma の 6 がリージーにも適用されて
 * KPI が誤った期間で集計される事故を招くため廃止した。
 */

// ============================================================
// 会計年度ヘルパー
// ============================================================

/** 指定日が属する会計年度（FY2026 等の数字部分）を返す */
export function getFiscalYear(startMonth: number, date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1; // 1〜12
  const y = date.getUTCFullYear();
  // 開始月以降ならその年がFY、開始月より前なら前年がFY
  return m >= startMonth ? y : y - 1;
}

/** 指定日が属する会計年度の四半期（1〜4） */
export function getFiscalQuarter(startMonth: number, date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1;
  const offset = (m - startMonth + 12) % 12; // 0〜11
  return Math.floor(offset / 3) + 1;
}

/**
 * 会計年度の四半期インデックス（0〜3）から、その四半期に属する3ヶ月の暦月リストを返す
 * 例: FY2026 の Q1（6/7/8月）→ [{year:2026,month:6}, {year:2026,month:7}, {year:2026,month:8}]
 */
export function getFiscalQuarterMonths(
  startMonth: number,
  fy: number,
  quarterIndex: number, // 0..3
): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const monthOffset = quarterIndex * 3 + i; // 0..11 from start month
    const m1 = startMonth + monthOffset; // 6..17
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
export function getFiscalMonth(startMonth: number, fy: number, monthIndex: number): { year: number; month: number } {
  const m1 = startMonth + monthIndex; // 6..17
  const yearAdd = Math.floor((m1 - 1) / 12);
  const month = ((m1 - 1) % 12) + 1;
  return { year: fy + yearAdd, month };
}

/** 指定日が会計年度の中で何ヶ月目か（0〜11） */
export function getFiscalMonthIndex(startMonth: number, date: Date = new Date()): number {
  const m = date.getUTCMonth() + 1;
  return (m - startMonth + 12) % 12;
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
export function currentFiscalYearPeriod(startMonth: number): string {
  return fyPeriodLabel(getFiscalYear(startMonth));
}

/** 現在の会計四半期 period ラベル */
export function currentFiscalQuarterPeriod(startMonth: number): string {
  return fyQuarterPeriodLabel(getFiscalYear(startMonth), getFiscalQuarter(startMonth));
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
export function fyDisplayLabel(startMonth: number, fy: number): string {
  const startY = fy;
  const startM = startMonth;
  const endMonth0 = (startM - 2 + 12) % 12;
  const endY = startM === 1 ? fy : fy + 1;
  const endM = endMonth0 + 1;
  if (startM === 1) {
    return `FY${fy}（${startY}年${startM}月〜${endM}月）`;
  }
  return `FY${fy}（${startY}年${startM}月〜${endY}年${endM}月）`;
}
