import { prisma } from "@/lib/db";
import { DealStatus, TaskStatus } from "@prisma/client";
import {
  FISCAL_YEAR_START_MONTH,
  fyPeriodLabel,
  fyQuarterPeriodLabel,
  monthPeriodLabel,
  getFiscalQuarterMonths,
  getFiscalMonth,
  getFiscalYear,
  getFiscalMonthIndex,
} from "@/lib/config";
import { pipelineAmount, wonAmount, type DealProductLite } from "@/lib/deal-aggregations";
import { isExcludedFromNextAction } from "@/lib/deal-status";
import { excludeNGDealsWhere } from "@/lib/deal-status-server";

const dealInclude = {
  company: true,
  owner: { select: { id: true, name: true, avatarColor: true, email: true } },
  leadSource: { select: { id: true, name: true } },
  products: true,
  _count: { select: { tasks: true, meetings: true } },
} as const;

/**
 * ソフト削除済みを除外する共通フィルタ。
 * Deal側の deletedAt: null + 親Companyの deletedAt: null も同時に強制。
 * （Companyを削除したらDealも一括ソフト削除される運用なので二重チェックだが安全側）
 */
export const ACTIVE_DEAL_FILTER = {
  deletedAt: null,
  company: { deletedAt: null },
} as const;

export const ACTIVE_COMPANY_FILTER = {
  deletedAt: null,
} as const;

/**
 * NextActionをToDo化する際に「ToDo一覧から除外したい」商談を弾く条件。
 *
 * 除外対象（社長判断 2026-05）：
 *   A. bant.isNG = true（Notion で NGフラグONの商談）
 *   B. pipelineStage = 「【商談前】日程調整不可」
 *   C. 完全失注（全 DealProduct.yomiStatus が NG/失注 を含む）
 *
 * @deprecated 完全失注（C）も含む正規版は `excludeNGDealsWhere()` を使う（async）。
 *   こちらは A+B のみ判定する旧版で、互換性のために残している。
 */
export const DEAL_NEXT_ACTION_NG_EXCLUDE_AND = [
  // bant.isNG が true で無いこと（null/undefined/false は通す）
  { NOT: { bant: { path: ["isNG"], equals: true } } },
  // pipeline_stage が【商談前】日程調整不可で無いこと
  { NOT: { pipelineStage: "【商談前】日程調整不可" } },
] as const;

/**
 * クライアント側（取得済みのDealに対して）のNG除外判定（A+B のみ）。
 * 完全失注も除外したい場合は `isExcludedFromNextAction()`（@/lib/deal-status）を使う。
 *
 * @deprecated `isExcludedFromNextAction()` を推奨
 */
export function isNgExcluded(d: { bant?: unknown; pipelineStage?: string | null }): boolean {
  if (d.pipelineStage === "【商談前】日程調整不可") return true;
  const bant = d.bant as { isNG?: unknown } | null | undefined;
  if (bant && typeof bant === "object" && bant.isNG === true) return true;
  return false;
}

// 新ヘルパーを再エクスポート（既存コードの import 経路を統一しやすくする）
export { excludeNGDealsWhere, isExcludedFromNextAction };

export type DealWithRelations = Awaited<ReturnType<typeof prisma.deal.findFirst>> & {
  company: { id: string; name: string; industry: string | null };
  owner: { id: string; name: string; avatarColor: string | null; email: string } | null;
  _count: { tasks: number; meetings: number };
};

interface DashboardOptions {
  userId?: string; // 指定時：ログイン担当者の view
}

export async function getDashboardData(opts: DashboardOptions = {}) {
  const { userId } = opts;
  const dealOwnerFilter = {
    ...(userId ? { ownerUserId: userId } : {}),
    ...ACTIVE_DEAL_FILTER,
  };
  // Task は親 Deal が active であるものに絞る
  const taskFilter = {
    deal: {
      ...(userId ? { ownerUserId: userId } : {}),
      ...ACTIVE_DEAL_FILTER,
    },
  };

  const [openTasks, deals, doneCount, totalDeals, wonDeals, aiTaskCount, totalTasks] = await Promise.all([
    prisma.task.findMany({
      where: { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, ...taskFilter },
      include: { deal: { include: { company: true, owner: true } } },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
      take: 10,
    }),
    prisma.deal.findMany({
      where: { status: { notIn: [DealStatus.WON, DealStatus.LOST] }, ...dealOwnerFilter },
      include: dealInclude,
      orderBy: [{ nextActionAt: "asc" }, { updatedAt: "desc" }],
      take: 8,
    }),
    prisma.task.count({ where: { status: TaskStatus.DONE, ...taskFilter } }),
    prisma.deal.count({ where: dealOwnerFilter }),
    prisma.deal.count({ where: { status: DealStatus.WON, ...dealOwnerFilter } }),
    prisma.task.count({ where: { isAiGenerated: true, ...taskFilter } }),
    prisma.task.count({ where: taskFilter }),
  ]);

  const allDeals = await prisma.deal.findMany({
    where: dealOwnerFilter,
    select: {
      id: true,
      status: true,
      nextAction: true,
      contractDate: true,
      bant: true,
      pipelineStage: true,
      products: { select: { amount: true, probability: true, yomiStatus: true } },
    },
  });
  const pipelineAmt = allDeals
    .filter((d) => d.status !== DealStatus.WON && d.status !== DealStatus.LOST)
    .reduce((sum, d) => sum + pipelineAmount(d.products as DealProductLite[]), 0);
  // 受注額（実績）：受注計上日ベース。Deal.contractDate が入っており、
  //                 yomiStatus="受注" の DealProduct の amount合計
  const won = allDeals
    .filter((d) => d.contractDate != null)
    .reduce((sum, d) => sum + wonAmount(d.products as DealProductLite[]), 0);
  // nextActionRate：NG/日程調整不可/完全失注は除外（KPI上、設定義務外なので分母分子から外す）
  const nextActionEligible = allDeals.filter(
    (d) => !isExcludedFromNextAction(d),
  );
  const nextActionRate =
    nextActionEligible.length === 0
      ? 0
      : nextActionEligible.filter((d) => d.nextAction).length / nextActionEligible.length;

  return {
    openTasks,
    deals,
    kpi: {
      winRate: totalDeals === 0 ? 0 : wonDeals / totalDeals,
      todoCompletionRate: totalTasks === 0 ? 0 : doneCount / totalTasks,
      nextActionRate,
      aiTaskRatio: totalTasks === 0 ? 0 : aiTaskCount / totalTasks,
      pipelineAmount: pipelineAmt,
      wonAmount: won,
      totalDeals,
      wonDeals,
    },
  };
}

export async function getKpiTimeseries(userId?: string) {
  const where = {
    ...(userId ? { ownerUserId: userId } : {}),
    ...ACTIVE_DEAL_FILTER,
  };
  const taskWhere = {
    deal: {
      ...(userId ? { ownerUserId: userId } : {}),
      ...ACTIVE_DEAL_FILTER,
    },
  };
  const tasks = await prisma.task.findMany({
    where: taskWhere,
    select: { createdAt: true, completedAt: true, status: true },
  });
  // 受注計上日ベース集計：contractDate が入っており、yomiStatus="受注" のDealProductがあるDealのみ
  const deals = await prisma.deal.findMany({
    where: { ...where, contractDate: { not: null } },
    select: {
      contractDate: true,
      products: { select: { amount: true, yomiStatus: true } },
    },
  });

  const now = new Date();
  const buckets: { label: string; weekStart: Date; weekEnd: Date }[] = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(now);
    end.setDate(end.getDate() - i * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    buckets.push({
      label: `${end.getMonth() + 1}/${end.getDate()}`,
      weekStart: start,
      weekEnd: end,
    });
  }

  return buckets.map((b) => {
    const wonDealsInWeek = deals.filter(
      (d) =>
        d.contractDate &&
        d.contractDate >= b.weekStart &&
        d.contractDate <= b.weekEnd,
    );
    const wonAmt = wonDealsInWeek.reduce(
      (s, d) =>
        s +
        d.products
          .filter((p) => p.yomiStatus === "受注")
          .reduce((ss, p) => ss + (p.amount ?? 0), 0),
      0,
    );
    const tasksDoneInWeek = tasks.filter(
      (t) =>
        t.status === "DONE" &&
        t.completedAt &&
        t.completedAt >= b.weekStart &&
        t.completedAt <= b.weekEnd,
    ).length;
    return {
      label: b.label,
      wonAmount: Math.round(wonAmt / 10000),
      wonDeals: wonDealsInWeek.length,
      tasksDone: tasksDoneInWeek,
    };
  });
}

/** 担当者一覧（タブ用） */
export async function getSalesUsers() {
  return prisma.user.findMany({
    where: { role: { in: ["sales", "manager"] } },
    select: { id: true, name: true, avatarColor: true, email: true, role: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * 目標 vs 実績
 * 集計基準：契約日（Deal.contractDate）が指定期間内 かつ
 *           DealProduct.yomiStatus = "受注" の DealProduct.amount 合計
 *
 * - Deal.status は問わない（契約日が入っているDealは契約済みと判定）
 * - WON / LOST / 任意ステータスでも、contractDate と yomiStatus="受注" のDealProductがあれば実績に乗る
 * - 期間指定が無い場合は全期間（contractDate not null のものすべて）
 */
export async function getGoalProgress(period: string, userId?: string) {
  const goal = await prisma.goal.findFirst({
    where: { period, ownerUserId: userId ?? null },
  });
  const where = {
    ...(userId ? { ownerUserId: userId } : {}),
    ...ACTIVE_DEAL_FILTER,
  };
  const range = parsePeriodToRange(period);

  const wonDeals = await prisma.deal.findMany({
    where: {
      ...where,
      contractDate: range
        ? { gte: range.start, lte: range.end }
        : { not: null },
    },
    select: {
      products: { select: { amount: true, yomiStatus: true } },
    },
  });
  const wonAmt = wonDeals.reduce(
    (s, d) =>
      s +
      d.products
        .filter((p) => p.yomiStatus === "受注")
        .reduce((ss, p) => ss + (p.amount ?? 0), 0),
    0,
  );
  return {
    targetAmount: goal?.targetAmount ?? 0,
    wonAmount: wonAmt,
    rate: goal?.targetAmount ? wonAmt / goal.targetAmount : 0,
    period,
  };
}

// ============================================================
// 期間ラベル → 開始/終了日のレンジ変換
// 対応：
//   「FY2026」     = 会計年度（2026/6 〜 2027/5）
//   「FY2026-Q1」  = 会計四半期（FY2026 の Q1 = 6/7/8月）
//   「2026-06」    = 暦月（fiscal年度とは無関係に YYYY-MM）
// 後方互換：旧表記「2026」「2026-Q1」も暦年ベースで受け付ける
// ============================================================
export function parsePeriodToRange(period: string): { start: Date; end: Date } | null {
  // 会計年度（FY2026）
  const fyOnly = /^FY(\d{4})$/i.exec(period);
  if (fyOnly) {
    const fy = Number(fyOnly[1]);
    const startMonth = FISCAL_YEAR_START_MONTH - 1; // 0-indexed
    const startYear = fy;
    const endYear = FISCAL_YEAR_START_MONTH === 1 ? fy : fy + 1;
    const endMonth = (startMonth - 1 + 12) % 12;
    const endDay = new Date(Date.UTC(endYear, endMonth + 1, 0)).getUTCDate();
    return {
      start: new Date(Date.UTC(startYear, startMonth, 1, 0, 0, 0)),
      end: new Date(Date.UTC(endYear, endMonth, endDay, 23, 59, 59)),
    };
  }
  // 会計四半期（FY2026-Q1）
  const fyQuarter = /^FY(\d{4})-Q([1-4])$/i.exec(period);
  if (fyQuarter) {
    const fy = Number(fyQuarter[1]);
    const q = Number(fyQuarter[2]);
    const months = getFiscalQuarterMonths(fy, q - 1);
    const first = months[0];
    const last = months[2];
    const lastDay = new Date(Date.UTC(last.year, last.month, 0)).getUTCDate();
    return {
      start: new Date(Date.UTC(first.year, first.month - 1, 1, 0, 0, 0)),
      end: new Date(Date.UTC(last.year, last.month - 1, lastDay, 23, 59, 59)),
    };
  }
  // 暦月（2026-06）
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    return {
      start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0)),
      end: new Date(Date.UTC(y, m, 0, 23, 59, 59)),
    };
  }
  // 後方互換：暦年「2026」
  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    return {
      start: new Date(Date.UTC(y, 0, 1, 0, 0, 0)),
      end: new Date(Date.UTC(y, 11, 31, 23, 59, 59)),
    };
  }
  // 後方互換：暦年四半期「2026-Q1」
  const quarter = /^(\d{4})-Q([1-4])$/i.exec(period);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    const startMonth = (q - 1) * 3;
    return {
      start: new Date(Date.UTC(y, startMonth, 1, 0, 0, 0)),
      end: new Date(Date.UTC(y, startMonth + 3, 0, 23, 59, 59)),
    };
  }
  return null;
}

export function periodLabel(period: string): string {
  const fyOnly = /^FY(\d{4})$/i.exec(period);
  if (fyOnly) return `FY${fyOnly[1]}（年間）`;
  const fyQuarter = /^FY(\d{4})-Q([1-4])$/i.exec(period);
  if (fyQuarter) return `FY${fyQuarter[1]} Q${fyQuarter[2]}`;
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) return `${month[1]}/${month[2]}`;
  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) return `${yearOnly[1]}年（年間）`;
  const quarter = /^(\d{4})-Q([1-4])$/i.exec(period);
  if (quarter) return `${quarter[1]}年 Q${quarter[2]}`;
  return period;
}

/**
 * 会計年度KGI / 会計四半期KPI / 月次KPI を一括で取得（リージーは6月始まり）
 * fy は会計年度（FY2026 等の数字部分）
 */
export async function getGoalsHierarchy(fy: number, userId?: string) {
  const yearPeriod = fyPeriodLabel(fy);
  const quarterPeriods = [1, 2, 3, 4].map((q) => fyQuarterPeriodLabel(fy, q));
  // FY内の12ヶ月（暦月のYYYY-MM形式）
  const monthPeriods = Array.from({ length: 12 }, (_, i) => {
    const { year, month } = getFiscalMonth(fy, i);
    return monthPeriodLabel(year, month);
  });
  const monthLabels = Array.from({ length: 12 }, (_, i) => {
    const { month } = getFiscalMonth(fy, i);
    return `${month}月`;
  });

  const [yearProgress, quarters, months] = await Promise.all([
    getGoalProgress(yearPeriod, userId),
    Promise.all(quarterPeriods.map((p) => getGoalProgress(p, userId))),
    Promise.all(monthPeriods.map((p) => getGoalProgress(p, userId))),
  ]);

  // 残月数：今がFY内なら（12 - 経過月数）。FY外なら 0 か 12（過去FYなら0）。
  const now = new Date();
  const currentFy = getFiscalYear(now);
  let remainingMonths = 0;
  if (fy === currentFy) {
    const passed = getFiscalMonthIndex(now) + 1; // 今月を含めた経過月数（1〜12）
    remainingMonths = Math.max(0, 12 - passed);
  } else if (fy > currentFy) {
    remainingMonths = 12;
  }

  return {
    year: yearProgress,
    quarters,
    months,
    monthLabels,
    remainingMonths,
  };
}

