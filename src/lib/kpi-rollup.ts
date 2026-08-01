/**
 * KPI 階層ロールアップ（Luma・リージー共通）
 * ============================================================
 * 社長要望：「月次で入れたものを合算して、四半期目標や年間KGIに反映させたい」
 *
 * 設計の核心：
 *   月次KPIを「正本（source of truth）」とし、
 *   四半期 = その四半期に属する3ヶ月分の合算
 *   年間KGI = 12ヶ月分の合算
 *   とすることで、月次データを入れれば自動で上位に積み上がる。
 *
 * 集計タイプの区別（要望で明示された注意点）：
 *   - "sum"    累積タイプ … 売上・商談数・受注数。3ヶ月/12ヶ月を単純合算。
 *   - "avg"    比率/平均タイプ … 受注率・平均単価。単純合算してはいけない。
 *              実績ベース（分子/分母）を持つ指標は「分子の合算 / 分母の合算」で
 *              再計算する＝事実上の加重平均。これにより四半期・年間でも正しい比率になる。
 *
 * 目標値の階層：
 *   上位（四半期・年間）の目標が明示設定されていればそれを優先（トップダウン）。
 *   未設定なら月次目標の合算（sum型）/ 加重平均（avg型）をフォールバック採用（ボトムアップ）。
 */

// ============================================================
// 指標定義
// ============================================================

/** KPI指標キー。売上・商談・受注の基本指標（Luma・リージー共通）。 */
export type KpiMetricKey =
  | "revenue" // 受注金額（売上）
  | "dealCount" // 商談数（新規に発生した商談）
  | "wonCount" // 受注数（受注に至った商談数）
  | "winRate" // 受注率（受注数 / 商談数）
  | "avgDealSize"; // 平均受注単価（受注金額 / 受注数）

/** 集計タイプ：sum=単純合算で上位へ積み上げ可 / avg=分子分母で再計算（加重平均） */
export type RollupKind = "sum" | "avg";

export type KpiMetricDef = {
  key: KpiMetricKey;
  label: string;
  /** sum=累積系（合算OK） / avg=比率・平均系（合算NG、加重平均で再計算） */
  kind: RollupKind;
  /** 表示単位の整形 */
  unit: "jpy" | "count" | "percent";
  /**
   * avg型の指標が「どの実績値から再計算されるか」。
   * numeratorKey / denominatorKey は基礎となる sum 型指標を指す。
   */
  numeratorKey?: KpiMetricKey;
  denominatorKey?: KpiMetricKey;
};

/**
 * KPI指標マスタ（会社共通）。
 * winRate / avgDealSize は派生指標（基礎指標から再計算する）。
 */
export const KPI_METRICS: KpiMetricDef[] = [
  { key: "revenue", label: "受注金額", kind: "sum", unit: "jpy" },
  { key: "dealCount", label: "商談数", kind: "sum", unit: "count" },
  { key: "wonCount", label: "受注数", kind: "sum", unit: "count" },
  {
    key: "winRate",
    label: "受注率",
    kind: "avg",
    unit: "percent",
    numeratorKey: "wonCount",
    denominatorKey: "dealCount",
  },
  {
    key: "avgDealSize",
    label: "平均受注単価",
    kind: "avg",
    unit: "jpy",
    numeratorKey: "revenue",
    denominatorKey: "wonCount",
  },
];

export const KPI_METRIC_MAP: Record<KpiMetricKey, KpiMetricDef> = Object.fromEntries(
  KPI_METRICS.map((m) => [m.key, m]),
) as Record<KpiMetricKey, KpiMetricDef>;

// ============================================================
// 月次の基礎データ型
// ============================================================

/**
 * 1ヶ月分の「sum型基礎指標」の実績。
 * avg型（winRate / avgDealSize）はこの基礎値から導出するので、ここには持たない。
 */
export type MonthlyBase = {
  revenue: number;
  dealCount: number;
  wonCount: number;
};

/** 空の月次基礎値 */
export function emptyMonthlyBase(): MonthlyBase {
  return { revenue: 0, dealCount: 0, wonCount: 0 };
}

/** 複数月の基礎値を合算 */
export function sumMonthlyBase(months: MonthlyBase[]): MonthlyBase {
  return months.reduce<MonthlyBase>(
    (acc, m) => ({
      revenue: acc.revenue + m.revenue,
      dealCount: acc.dealCount + m.dealCount,
      wonCount: acc.wonCount + m.wonCount,
    }),
    emptyMonthlyBase(),
  );
}

// ============================================================
// 派生指標の算出
// ============================================================

/**
 * sum型基礎値から、指定指標の値を算出する。
 *  - sum型はそのまま基礎値を返す
 *  - avg型は「分子合算 / 分母合算」で再計算（＝加重平均）。
 *    分母が0なら0を返す（0除算回避）。
 */
export function metricValueFromBase(base: MonthlyBase, key: KpiMetricKey): number {
  const def = KPI_METRIC_MAP[key];
  if (def.kind === "sum") {
    return base[key as keyof MonthlyBase] as number;
  }
  // avg型：基礎指標の分子/分母から再計算
  const num = base[def.numeratorKey as keyof MonthlyBase] as number;
  const den = base[def.denominatorKey as keyof MonthlyBase] as number;
  if (!den) return 0;
  if (key === "winRate") return (num / den) * 100; // パーセント
  return num / den; // avgDealSize（円）
}

// ============================================================
// 進捗（実績 vs 目標）
// ============================================================

export type MetricProgress = {
  metric: KpiMetricKey;
  label: string;
  kind: RollupKind;
  unit: KpiMetricDef["unit"];
  actual: number;
  target: number;
  /** 達成率（0〜1）。目標0なら0。 */
  rate: number;
  /** 目標が「月次目標の合算/加重平均から推定」されたものか（true=ボトムアップ推定） */
  targetEstimated: boolean;
};

// ============================================================
// 階層ロールアップ
// ============================================================

export type PeriodRollup = {
  /** "FY2026" / "FY2026-Q1" / "2026-06" */
  period: string;
  /** 表示ラベル */
  label: string;
  /** 全指標の進捗 */
  metrics: MetricProgress[];
};

export type KpiRollupResult = {
  fy: number;
  /** 年間KGI（12ヶ月合算） */
  year: PeriodRollup;
  /** 四半期KPI（各3ヶ月合算） */
  quarters: PeriodRollup[];
  /** 月次KPI（正本） */
  months: PeriodRollup[];
  monthLabels: string[];
};

/**
 * 月次の基礎値配列（12ヶ月）と、期間別の売上目標から、
 * 年間KGI / 四半期KPI / 月次KPI の階層ロールアップを構築する。
 *
 * @param fy            会計年度
 * @param monthlyBases  12ヶ月分の基礎実績（index0 = FY開始月）
 * @param monthLabels   12ヶ月分の表示ラベル（"6月" 等）
 * @param targets       期間ラベル → 売上目標（円）。未設定の上位期間は月次合算でフォールバック。
 */
export function buildKpiRollup(
  fy: number,
  monthlyBases: MonthlyBase[],
  monthLabels: string[],
  targets: Map<string, number>,
  periodLabels: { year: string; quarters: string[]; months: string[] },
): KpiRollupResult {
  // --- 月次 ---
  const months: PeriodRollup[] = monthlyBases.map((base, idx) => {
    const period = periodLabels.months[idx];
    const explicitTarget = targets.get(period);
    return {
      period,
      label: monthLabels[idx],
      metrics: buildMetricProgress(base, explicitTarget, false),
    };
  });

  // --- 四半期（3ヶ月合算） ---
  const quarters: PeriodRollup[] = [0, 1, 2, 3].map((qi) => {
    const slice = monthlyBases.slice(qi * 3, qi * 3 + 3);
    const base = sumMonthlyBase(slice);
    const period = periodLabels.quarters[qi];
    // 四半期目標：明示があれば優先、無ければ3ヶ月分の月次目標を合算（ボトムアップ）
    const explicit = targets.get(period);
    let target = explicit;
    let estimated = false;
    if (explicit == null) {
      const monthTargets = periodLabels.months
        .slice(qi * 3, qi * 3 + 3)
        .map((p) => targets.get(p) ?? 0);
      const sum = monthTargets.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        target = sum;
        estimated = true;
      }
    }
    return {
      period,
      label: `Q${qi + 1}`,
      metrics: buildMetricProgress(base, target, estimated),
    };
  });

  // --- 年間KGI（12ヶ月合算） ---
  const yearBase = sumMonthlyBase(monthlyBases);
  const explicitYear = targets.get(periodLabels.year);
  let yearTarget = explicitYear;
  let yearEstimated = false;
  if (explicitYear == null) {
    const sum = periodLabels.months
      .map((p) => targets.get(p) ?? 0)
      .reduce((a, b) => a + b, 0);
    if (sum > 0) {
      yearTarget = sum;
      yearEstimated = true;
    }
  }
  const year: PeriodRollup = {
    period: periodLabels.year,
    label: `FY${fy}`,
    metrics: buildMetricProgress(yearBase, yearTarget, yearEstimated),
  };

  return { fy, year, quarters, months, monthLabels };
}

/**
 * 1期間分の基礎値から、全指標の進捗を算出。
 * 売上目標（revenueTarget）のみ Goal から渡る。
 * 派生指標（winRate / avgDealSize）の目標は持たない（実績のみ表示）。
 *
 * @param base          その期間の sum型基礎実績
 * @param revenueTarget 受注金額の目標（円）。未設定なら undefined。
 * @param targetEstimated  目標が月次合算からの推定か
 */
function buildMetricProgress(
  base: MonthlyBase,
  revenueTarget: number | undefined,
  targetEstimated: boolean,
): MetricProgress[] {
  return KPI_METRICS.map((def) => {
    const actual = metricValueFromBase(base, def.key);
    // 現状 Goal に保存しているのは売上目標のみ。他指標の目標は0（未設定）。
    const target = def.key === "revenue" ? (revenueTarget ?? 0) : 0;
    return {
      metric: def.key,
      label: def.label,
      kind: def.kind,
      unit: def.unit,
      actual,
      target,
      rate: target > 0 ? actual / target : 0,
      targetEstimated: def.key === "revenue" ? targetEstimated : false,
    };
  });
}

// ============================================================
// 表示整形
// ============================================================

/** 指標値を単位付き文字列に整形 */
export function formatMetricValue(value: number, unit: KpiMetricDef["unit"]): string {
  if (unit === "jpy") {
    if (value >= 100_000_000) return `¥${(value / 100_000_000).toFixed(2)}億`;
    if (value >= 10_000) return `¥${Math.round(value / 10_000).toLocaleString()}万`;
    return `¥${Math.round(value).toLocaleString()}`;
  }
  if (unit === "percent") return `${value.toFixed(1)}%`;
  return `${Math.round(value).toLocaleString()}件`;
}
