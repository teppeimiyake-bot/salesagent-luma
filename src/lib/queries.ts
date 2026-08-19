import { cache } from "react";
import { prisma } from "@/lib/db";
import { getFiscalStartMonth, currentTenantId } from "@/lib/tenant-context";
import { DealStatus, TaskStatus } from "@prisma/client";
import {
  fyPeriodLabel,
  fyQuarterPeriodLabel,
  monthPeriodLabel,
  getFiscalQuarterMonths,
  getFiscalMonth,
  getFiscalYear,
  getFiscalMonthIndex,
} from "@/lib/config";
import { totalProposedAmount, wonAmount, isWonDeal, isWonProduct, type DealProductLite } from "@/lib/deal-aggregations";
import {
  revenueEntries,
  toYearMonth,
  yearMonthToPeriod,
  type RevenueEntry,
} from "@/lib/revenue-recognition";
import { isExcludedFromNextAction } from "@/lib/deal-status";
import { excludeNGDealsWhere, excludeDoneAndNGDealsWhere } from "@/lib/deal-status-server";

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
  // ダッシュボード「今日のあなた」の openTasks は受注/失注/NG 除外
  // （社長判断 2026-05：ToDo管理は生きている商談だけに絞る）
  const todoExclude = await excludeDoneAndNGDealsWhere();
  const openTaskFilter = {
    deal: {
      ...(userId ? { ownerUserId: userId } : {}),
      ...ACTIVE_DEAL_FILTER,
      AND: [...todoExclude.AND],
    },
  };

  const [openTasks, deals, doneCount, totalDeals, aiTaskCount, totalTasks] = await Promise.all([
    prisma.task.findMany({
      where: { status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS] }, ...openTaskFilter },
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
  // 受注判定は yomiStatus ベースに統一（Deal.status / contractDate は Notion取込で未設定のため使えない）。
  // 受注商談 = 配下DealProductのいずれかが受注/締結済み（接頭辞付き含む）。
  const wonDeals = allDeals.filter((d) => isWonDeal(d.products as DealProductLite[])).length;
  // 進行中商談の提案金額合計（受注済みDealは除外。DealProduct.amount の単純合計）
  const proposedAmt = allDeals
    .filter((d) => !isWonDeal(d.products as DealProductLite[]))
    .reduce((sum, d) => sum + totalProposedAmount(d.products as DealProductLite[]), 0);
  // 受注額（実績）：yomiStatus が 受注/締結済み の DealProduct の amount合計
  const won = allDeals.reduce(
    (sum, d) => sum + wonAmount(d.products as DealProductLite[]),
    0,
  );
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
      proposedAmount: proposedAmt,
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
  // 受注集計：yomiStatus が 受注/締結済み の DealProduct を持つ Deal。
  // 計上日は contractDate を最優先、未設定なら appointmentDate(商談日) → bantUpdatedAt の順で代替。
  // （Notion取込は contractDate を入れないため、商談日ベースで時系列に乗せる。2026-05 不具合修正）
  const deals = await prisma.deal.findMany({
    where: {
      ...where,
      products: { some: { OR: [{ yomiStatus: { contains: "受注" } }, { yomiStatus: { contains: "締結済み" } }] } },
    },
    select: {
      contractDate: true,
      appointmentDate: true,
      bantUpdatedAt: true,
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

  // 計上日：contractDate → appointmentDate → bantUpdatedAt の優先で確定
  const bookedDate = (d: {
    contractDate: Date | null;
    appointmentDate: Date | null;
    bantUpdatedAt: Date | null;
  }): Date | null => d.contractDate ?? d.appointmentDate ?? d.bantUpdatedAt ?? null;

  return buckets.map((b) => {
    const wonDealsInWeek = deals.filter((d) => {
      const bd = bookedDate(d);
      return bd && bd >= b.weekStart && bd <= b.weekEnd;
    });
    const wonAmt = wonDealsInWeek.reduce(
      (s, d) => s + wonAmount(d.products as DealProductLite[]),
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
 * 指定 period の「目標金額」を返す。
 *
 * 設計（2026-05 社長指示）：
 *   月次目標（YYYY-MM）がマスタ（唯一の入力源）。
 *   四半期目標・年間KGI は DBにレコードを持たず、その期間に属する
 *   月次目標の合計として自動算出する（二重管理を避ける）。
 *
 * - period が月次（YYYY-MM）       → Goal レコードを直接参照
 * - period が会計四半期（FYxxxx-Qn）→ 属する3ヶ月の月次目標を合算
 * - period が会計年度（FYxxxx）     → 属する12ヶ月の月次目標を合算
 * - 後方互換：暦年「2026」「2026-Qn」も月次合算で算出
 */
export async function getGoalTargetAmount(
  period: string,
  userId?: string,
): Promise<number> {
  // 月次：レコード直参照
  if (/^\d{4}-\d{2}$/.test(period)) {
    const goal = await prisma.goal.findFirst({
      where: { period, ownerUserId: userId ?? null },
    });
    return goal?.targetAmount ?? 0;
  }
  // 四半期/年度/暦年系：構成月の月次目標を合算
  const months = periodToMonthPeriods(await getFiscalStartMonth(), period);
  if (months.length === 0) {
    // 想定外フォーマットは旧来どおりレコード直参照（フォールバック）
    const goal = await prisma.goal.findFirst({
      where: { period, ownerUserId: userId ?? null },
    });
    return goal?.targetAmount ?? 0;
  }
  const goals = await prisma.goal.findMany({
    where: { period: { in: months }, ownerUserId: userId ?? null },
    select: { targetAmount: true },
  });
  return goals.reduce((s, g) => s + g.targetAmount, 0);
}

/**
 * 集計期間ラベル → 構成する月次 period（YYYY-MM）配列
 * 月次以外（四半期・年度・暦年・暦年四半期）を月次の集合に展開する。
 * 月次ラベル・未対応ラベルは空配列を返す。
 */
export function periodToMonthPeriods(startMonth: number, period: string): string[] {
  // 会計年度（FY2026）→ 構成12ヶ月
  const fyOnly = /^FY(\d{4})$/i.exec(period);
  if (fyOnly) {
    const fy = Number(fyOnly[1]);
    return Array.from({ length: 12 }, (_, i) => {
      const { year, month } = getFiscalMonth(startMonth, fy, i);
      return monthPeriodLabel(year, month);
    });
  }
  // 会計四半期（FY2026-Q1）→ 構成3ヶ月
  const fyQuarter = /^FY(\d{4})-Q([1-4])$/i.exec(period);
  if (fyQuarter) {
    const fy = Number(fyQuarter[1]);
    const q = Number(fyQuarter[2]);
    return getFiscalQuarterMonths(startMonth, fy, q - 1).map((m) =>
      monthPeriodLabel(m.year, m.month),
    );
  }
  // 後方互換：暦年「2026」→ 1〜12月
  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) {
    const y = Number(yearOnly[1]);
    return Array.from({ length: 12 }, (_, i) => monthPeriodLabel(y, i + 1));
  }
  // 後方互換：暦年四半期「2026-Q1」→ 3ヶ月
  const quarter = /^(\d{4})-Q([1-4])$/i.exec(period);
  if (quarter) {
    const y = Number(quarter[1]);
    const q = Number(quarter[2]);
    const startMonth = (q - 1) * 3 + 1;
    return [0, 1, 2].map((i) => monthPeriodLabel(y, startMonth + i));
  }
  return [];
}

// ============================================================
// 売上計上（レベニューレコグニション）
// ------------------------------------------------------------
// 社長判断 2026-08：
//   SNS運用は毎月売上が発生する継続契約なので、受注時点で6ヶ月分をまとめて
//   受注月に計上しない。契約初月＝初期費用（既定10万）＋月額、2ヶ月目以降＝月額として
//   契約期間中の各月に分割計上する。映像/CATV/アライアンスは従来どおり受注月に一括計上。
//   分割ロジック本体は @/lib/revenue-recognition（純粋関数）。
// ============================================================

/** 受注計上日の由来（contractDate 未設定時のフォールバック元を UI で注記するため） */
export type BookedDateSource = "contractDate" | "appointmentDate" | "bantUpdatedAt" | null;

/** 売上明細1行（DealProduct × 計上月） */
export type RevenueEntryDetail = RevenueEntry & {
  dealId: string;
  companyName: string;
  productName: string;
  planName: string | null;
  /** 受注計上日（contractDate → appointmentDate → bantUpdatedAt の確定値） */
  bookedDate: Date | null;
  bookedDateSource: BookedDateSource;
  contractDate: Date | null;
};

/** 売上計上に必要な受注商談＋契約条件（入金管理の定期契約 / PMの提供期間）をまとめて引く */
async function loadWonDealsForRevenue(userId?: string) {
  const where = {
    ...(userId ? { ownerUserId: userId } : {}),
    ...ACTIVE_DEAL_FILTER,
  };
  return prisma.deal.findMany({
    where: {
      ...where,
      products: {
        some: {
          OR: [{ yomiStatus: { contains: "受注" } }, { yomiStatus: { contains: "締結済み" } }],
        },
      },
    },
    select: {
      id: true,
      contractDate: true,
      appointmentDate: true,
      bantUpdatedAt: true,
      company: { select: { name: true } },
      products: {
        select: {
          id: true,
          productId: true,
          productName: true,
          planName: true,
          amount: true,
          yomiStatus: true,
          probability: true,
          product: { select: { name: true, category: true } },
          // 定期契約の条件（初期費用・月額・契約開始/終了）。最新1件を使う。
          recurringBillings: {
            select: { initialFee: true, monthlyFee: true, startDate: true, endDate: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          // PM側のSNS提供開始/終了月（入金管理未登録の契約のフォールバック）
          productionProject: {
            select: { category: true, serviceStartMonth: true, serviceEndMonth: true },
          },
        },
        orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
      },
    },
  });
}

type WonDealForRevenue = Awaited<ReturnType<typeof loadWonDealsForRevenue>>[number];
type WonProductForRevenue = WonDealForRevenue["products"][number];

/** 受注計上日と、その由来フィールドを確定する */
function bookedDateOf(d: {
  contractDate: Date | null;
  appointmentDate: Date | null;
  bantUpdatedAt: Date | null;
}): { date: Date | null; source: BookedDateSource } {
  if (d.contractDate) return { date: d.contractDate, source: "contractDate" };
  if (d.appointmentDate) return { date: d.appointmentDate, source: "appointmentDate" };
  if (d.bantUpdatedAt) return { date: d.bantUpdatedAt, source: "bantUpdatedAt" };
  return { date: null, source: null };
}

/** 1商談を「受注商材 × 計上月」の売上明細に展開する */
function dealRevenueEntries(
  d: WonDealForRevenue,
): { product: WonProductForRevenue; entry: RevenueEntry }[] {
  const { date: booked } = bookedDateOf(d);
  const out: { product: WonProductForRevenue; entry: RevenueEntry }[] = [];
  for (const p of d.products) {
    if (!isWonProduct(p as DealProductLite)) continue;
    const entries = revenueEntries(
      {
        id: p.id,
        productName: p.productName,
        planName: p.planName,
        amount: p.amount,
        yomiStatus: p.yomiStatus,
        product: p.product,
        recurring: p.recurringBillings[0] ?? null,
        production: p.productionProject ?? null,
      },
      booked,
    );
    for (const entry of entries) out.push({ product: p, entry });
  }
  return out;
}

/**
 * 全受注商材の売上明細（DealProduct × 計上月）を返す。
 * KPI月次・目標進捗・月別ドリルダウンはすべてこの明細を正本に集計する。
 *
 * KPI画面は年間/四半期/月次で getGoalProgress を17回呼ぶため、同一リクエスト内では
 * 会社（テナント）×担当者ごとに結果を使い回す（React cache でリクエストスコープ）。
 */
export function getRevenueEntries(userId?: string): Promise<RevenueEntryDetail[]> {
  const store = revenueEntriesStore();
  const key = `${currentTenantId()}::${userId ?? ""}`;
  let hit = store.get(key);
  if (!hit) {
    hit = loadRevenueEntries(userId);
    store.set(key, hit);
  }
  return hit;
}

/** リクエストスコープのメモ化ストア（テナント×担当者 → 売上明細） */
const revenueEntriesStore = cache(() => new Map<string, Promise<RevenueEntryDetail[]>>());

async function loadRevenueEntries(userId?: string): Promise<RevenueEntryDetail[]> {
  const deals = await loadWonDealsForRevenue(userId);
  const out: RevenueEntryDetail[] = [];
  for (const d of deals) {
    const { date: booked, source } = bookedDateOf(d);
    for (const { product, entry } of dealRevenueEntries(d)) {
      out.push({
        ...entry,
        dealId: d.id,
        companyName: d.company?.name ?? "（企業名なし）",
        productName: product.productName,
        planName: product.planName,
        bookedDate: booked,
        bookedDateSource: source,
        contractDate: d.contractDate,
      });
    }
  }
  return out;
}

/**
 * 目標 vs 実績
 *
 * 集計基準（社長判断 2026-08 の売上計上ルール）：
 *   受注商材（yomiStatus が 受注/締結済み）を「計上月 × 金額」の明細に展開し（getRevenueEntries）、
 *   指定期間に属する月の売上を合算する。
 *     - SNS：契約初月 = 初期費用（既定10万）＋月額、2ヶ月目以降 = 月額 を契約期間中の各月に計上
 *     - 映像/CATV/アライアンス：受注計上日の月に提案金額を全額計上
 *   受注計上日は contractDate → appointmentDate(商談日) → bantUpdatedAt の優先で確定する。
 *
 * - Deal.status は問わない（Notion取込では status は LEAD 固定のため受注判定に使えない）
 * - 期間指定が無い場合は全期間（受注DealProductの売上すべて）
 *
 * 目標金額は getGoalTargetAmount に委譲（四半期/年間は月次目標の合算）。
 */
export async function getGoalProgress(period: string, userId?: string) {
  const targetAmount = await getGoalTargetAmount(period, userId);
  const range = parsePeriodToRange(await getFiscalStartMonth(), period);
  const entries = await getRevenueEntries(userId);

  // 期間は「計上月（YYYYMM）」で判定する。SNSの月次売上は日付を持たないため、
  // 日付レンジではなく月レンジで比較する（レンジ両端の月は必ず含む）。
  const startYm = range ? toYearMonth(range.start) : null;
  const endYm = range ? toYearMonth(range.end) : null;
  const wonAmt = entries
    .filter((e) => startYm == null || endYm == null || (e.yearMonth >= startYm && e.yearMonth <= endYm))
    .reduce((s, e) => s + e.amount, 0);

  return {
    targetAmount,
    wonAmount: wonAmt,
    rate: targetAmount ? wonAmt / targetAmount : 0,
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
export function parsePeriodToRange(fiscalStartMonth: number, period: string): { start: Date; end: Date } | null {
  // 会計年度（FY2026）
  const fyOnly = /^FY(\d{4})$/i.exec(period);
  if (fyOnly) {
    const fy = Number(fyOnly[1]);
    const startMonth = fiscalStartMonth - 1; // 0-indexed
    const startYear = fy;
    const endYear = fiscalStartMonth === 1 ? fy : fy + 1;
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
    const months = getFiscalQuarterMonths(fiscalStartMonth, fy, q - 1);
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
 * 会計年度KGI / 会計四半期KPI / 月次KPI を一括で取得（Lumaは6月始まり＝5月決算）
 * fy は会計年度（FY2026 等の数字部分）
 */
export async function getGoalsHierarchy(fy: number, userId?: string) {
  const yearPeriod = fyPeriodLabel(fy);
  const quarterPeriods = [1, 2, 3, 4].map((q) => fyQuarterPeriodLabel(fy, q));
  // FY内の12ヶ月（暦月のYYYY-MM形式）
  const startMonth = await getFiscalStartMonth();
  const monthPeriods = Array.from({ length: 12 }, (_, i) => {
    const { year, month } = getFiscalMonth(startMonth, fy, i);
    return monthPeriodLabel(year, month);
  });
  const monthLabels = Array.from({ length: 12 }, (_, i) => {
    const { month } = getFiscalMonth(startMonth, fy, i);
    return `${month}月`;
  });

  const [yearProgress, quarters, months] = await Promise.all([
    getGoalProgress(yearPeriod, userId),
    Promise.all(quarterPeriods.map((p) => getGoalProgress(p, userId))),
    Promise.all(monthPeriods.map((p) => getGoalProgress(p, userId))),
  ]);

  // 残月数：今がFY内なら（12 - 経過月数）。FY外なら 0 か 12（過去FYなら0）。
  const now = new Date();
  const currentFy = getFiscalYear(startMonth, now);
  let remainingMonths = 0;
  if (fy === currentFy) {
    const passed = getFiscalMonthIndex(startMonth, now) + 1; // 今月を含めた経過月数（1〜12）
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

/** 受注企業カードのインライン編集用：DealProduct 1件分の編集可能フィールド */
export type WonDealEditableProduct = {
  id: string;
  productId: string | null;
  productName: string;
  planName: string | null;
  amount: number | null;
  yomiStatus: string | null;
  probability: number;
};

/** 月クリックで開くドリルダウン用：1件の受注案件カード（その月の売上1件分） */
export type WonDealCard = {
  dealId: string;
  companyName: string;
  /**
   * その月に計上される売上。
   * スポット（映像/CATV/アライアンス）＝受注月に提案金額の全額。
   * SNS＝その月の月額（契約初月は初期費用を含む）。
   */
  wonAmount: number;
  /**
   * 受注計上日（Deal.contractDate）。
   * スポットの月度振り分けは contractDate（未設定時は appointmentDate→bantUpdatedAt）が基準なので、
   * カード上の編集UIは contractDate を直接書き換える（"YYYY-MM-DD" or null）。
   */
  contractDate: string | null;
  /**
   * 実際にこの案件を月度へ振り分けた「計上日」（contractDate→appointmentDate→bantUpdatedAt の確定値）。
   * contractDate が未設定で別フィールドにフォールバックしている場合に UI で注記するために返す（"YYYY-MM-DD"）。
   */
  bookedDate: string | null;
  /** bookedDate がどのフィールド由来か（contractDate / appointmentDate / bantUpdatedAt） */
  bookedDateSource: BookedDateSource;
  /**
   * その月の売上に寄与した商材（金額は按分後の当月計上額）。
   * note には SNS の「月額（3/6ヶ月目）」等の内訳を入れる。
   */
  products: { name: string; amount: number | null; note?: string | null }[];
  /**
   * この案件に紐づく全 DealProduct（受注以外も含む）。
   * 受注企業カード上でのインライン編集（追加/変更/金額修正）に使う。
   * 受注判定・売上は yomiStatus ベース（isWonProduct）で再集計される。
   */
  editableProducts: WonDealEditableProduct[];
  /** その月の計上に SNS（継続課金）の月次売上が含まれるか */
  hasRecurring: boolean;
};

/**
 * FY内の各月（YYYY-MM）について「その月に売上が計上される案件」のカード一覧を返す。
 *
 * 集計基準は KPI月次セル（getGoalProgress / getMonthlyKpiBases）と完全に同一：
 *   - 受注 = DealProduct.yomiStatus が 受注/締結済み（接頭辞付き含む。isWonProduct）
 *   - 月帰属 = getRevenueEntries の計上月
 *       * SNS：契約初月＝初期費用＋月額／2ヶ月目以降＝月額（契約期間中の各月）
 *       * それ以外：受注計上日（contractDate → appointmentDate → bantUpdatedAt）の月
 *   - カード金額 = その月に計上される売上
 *
 * これにより KPI月次セルの「売上」とカード一覧の合計が必ず一致する。
 * 戻り値は period(YYYY-MM) → カード配列 の Record。
 */
export async function getMonthlyWonDealsByPeriod(
  fy: number,
  userId?: string,
): Promise<Record<string, WonDealCard[]>> {
  const wonDeals = await loadWonDealsForRevenue(userId);

  // 12ヶ月分の period を用意（getGoalsHierarchy と同じ並び）
  const startMonth = await getFiscalStartMonth();
  const monthPeriods = Array.from({ length: 12 }, (_, i) => {
    const { year, month } = getFiscalMonth(startMonth, fy, i);
    return monthPeriodLabel(year, month);
  });
  const monthPeriodSet = new Set(monthPeriods);
  const result: Record<string, WonDealCard[]> = {};
  for (const p of monthPeriods) result[p] = [];

  // Date → "YYYY-MM-DD"（KPIの月帰属は UTC レンジ判定なので UTC で日付化して表記を揃える）
  const toYmd = (dt: Date | null): string | null =>
    dt ? dt.toISOString().slice(0, 10) : null;

  for (const d of wonDeals) {
    const { date: bd, source: bookedSource } = bookedDateOf(d);
    // 同一商談が同じ月に複数商材の売上を持つ場合は1カードにまとめる
    const byPeriod = new Map<string, WonDealCard>();

    for (const { product, entry } of dealRevenueEntries(d)) {
      const period = yearMonthToPeriod(entry.yearMonth);
      if (!monthPeriodSet.has(period)) continue; // FY外の計上月はスキップ

      let card = byPeriod.get(period);
      if (!card) {
        card = {
          dealId: d.id,
          companyName: d.company?.name ?? "（企業名なし）",
          wonAmount: 0,
          contractDate: toYmd(d.contractDate),
          bookedDate: toYmd(bd),
          bookedDateSource: bookedSource,
          products: [],
          editableProducts: d.products.map((p) => ({
            id: p.id,
            productId: p.productId,
            productName: p.productName,
            planName: p.planName,
            amount: p.amount,
            yomiStatus: p.yomiStatus,
            probability: p.probability,
          })),
          hasRecurring: false,
        };
        byPeriod.set(period, card);
      }
      card.wonAmount += entry.amount;
      card.hasRecurring = card.hasRecurring || entry.kind === "recurring";
      card.products.push({
        name: product.productName,
        amount: entry.amount,
        note:
          entry.kind === "recurring"
            ? `月額 ${entry.monthIndex}/${entry.totalMonths}ヶ月目${entry.includesInitialFee ? "＋初期費用" : ""}`
            : null,
      });
    }

    for (const [period, card] of byPeriod) result[period].push(card);
  }

  // 各月は売上の大きい順に並べる（見やすさ）
  for (const p of monthPeriods) {
    result[p].sort((a, b) => b.wonAmount - a.wonAmount);
  }
  return result;
}


// ============================================================
// 指標別 KPI ロールアップ（月次を正本に四半期・年間へ積み上げる）
// ------------------------------------------------------------
// 「月次で入れた数字を合算して四半期目標・年間KGIに反映させたい」という
// 社長要望で作った集計。リージー版で先に作り、統合にあたって Luma へ移植した。
//
// 会計年度の開始月は会社ごとに異なる（Luma=6月 / リージー=1月）ため、
// 期間の区切りは getFiscalStartMonth() から取る。
// ============================================================

/**
 * FY内12ヶ月の基礎実績（売上・商談数・受注数）を月インデックス順に返す。
 *
 * 売上（revenue）：getRevenueEntries の売上明細を計上月で振り分ける（社長判断 2026-08）。
 *   SNSは契約期間中の各月に月額（初月は＋初期費用）が立つため、受注月に一括計上しない。
 *   前年度に受注したSNS契約でも、当年度の月に売上が立てばその月に計上される。
 * 受注数（wonCount）：受注は「その月に決まった件数」なので従来どおり受注計上日ベース。
 *
 * 受注の判定は Luma の慣習に合わせ isWonProduct / isWonDeal を使う。
 * Luma のヨミは「【映像】受注」のようにプレフィックスが付くため、
 * 文字列の厳密一致では受注を取りこぼす。
 */
export async function getMonthlyKpiBases(
  fy: number,
  userId?: string,
): Promise<import("@/lib/kpi-rollup").MonthlyBase[]> {
  const startMonth = await getFiscalStartMonth();
  const where = {
    ...(userId ? { ownerUserId: userId } : {}),
    ...ACTIVE_DEAL_FILTER,
  };

  // FY全体を1回で取り、メモリ上で月別に振り分ける
  const fyStart = getFiscalMonth(startMonth, fy, 0);
  const fyEnd = getFiscalMonth(startMonth, fy, 11);
  const rangeStart = new Date(Date.UTC(fyStart.year, fyStart.month - 1, 1, 0, 0, 0));
  const rangeEnd = new Date(Date.UTC(fyEnd.year, fyEnd.month, 0, 23, 59, 59));

  const [wonDeals, createdDeals, entries] = await Promise.all([
    // 受注件数（受注計上日ベース）
    prisma.deal.findMany({
      where: { ...where, contractDate: { gte: rangeStart, lte: rangeEnd } },
      select: {
        contractDate: true,
        products: { select: { amount: true, yomiStatus: true } },
      },
    }),
    // 新規商談数（作成日ベース）
    prisma.deal.findMany({
      where: { ...where, createdAt: { gte: rangeStart, lte: rangeEnd } },
      select: { createdAt: true },
    }),
    // 売上明細（SNSは月次按分済み）。FY外の受注も含めて引き、計上月でFYに振り分ける。
    getRevenueEntries(userId),
  ]);

  // 会計年度内の月インデックス（0〜11）。範囲外は -1。
  const monthIndexOf = (d: Date): number => {
    for (let i = 0; i < 12; i++) {
      const fm = getFiscalMonth(startMonth, fy, i);
      if (d.getUTCFullYear() === fm.year && d.getUTCMonth() + 1 === fm.month) return i;
    }
    return -1;
  };
  // FY内12ヶ月の YYYYMM → 月インデックス
  const idxByYearMonth = new Map<number, number>();
  for (let i = 0; i < 12; i++) {
    const fm = getFiscalMonth(startMonth, fy, i);
    idxByYearMonth.set(fm.year * 100 + fm.month, i);
  }

  const bases: import("@/lib/kpi-rollup").MonthlyBase[] = Array.from(
    { length: 12 },
    () => ({ revenue: 0, dealCount: 0, wonCount: 0 }),
  );

  for (const e of entries) {
    const idx = idxByYearMonth.get(e.yearMonth);
    if (idx === undefined) continue;
    bases[idx].revenue += e.amount;
  }
  for (const d of wonDeals) {
    if (!d.contractDate) continue;
    const idx = monthIndexOf(d.contractDate);
    if (idx < 0) continue;
    const products = d.products as DealProductLite[];
    if (!isWonDeal(products)) continue;
    bases[idx].wonCount += 1;
  }
  for (const d of createdDeals) {
    const idx = monthIndexOf(d.createdAt);
    if (idx >= 0) bases[idx].dealCount += 1;
  }
  return bases;
}

/**
 * 指標別ロールアップ（月次 → 四半期 → 年間）を組み立てる。
 * 上位期間の目標が明示設定されていればそれを優先し、無ければ月次目標の合算で補う。
 */
export async function getKpiRollup(fy: number, userId?: string) {
  const { buildKpiRollup } = await import("@/lib/kpi-rollup");
  const startMonth = await getFiscalStartMonth();

  const yearPeriod = fyPeriodLabel(fy);
  const quarterPeriods = [1, 2, 3, 4].map((q) => fyQuarterPeriodLabel(fy, q));
  const monthPeriods = Array.from({ length: 12 }, (_, i) => {
    const { year, month } = getFiscalMonth(startMonth, fy, i);
    return monthPeriodLabel(year, month);
  });
  const monthLabels = Array.from({ length: 12 }, (_, i) => {
    const { month } = getFiscalMonth(startMonth, fy, i);
    return `${month}月`;
  });

  const [bases, goals] = await Promise.all([
    getMonthlyKpiBases(fy, userId),
    prisma.goal.findMany({
      where: {
        ownerUserId: userId ?? null,
        period: { in: [yearPeriod, ...quarterPeriods, ...monthPeriods] },
      },
      select: { period: true, targetAmount: true },
    }),
  ]);

  const targets = new Map<string, number>();
  for (const g of goals) targets.set(g.period, g.targetAmount);

  return buildKpiRollup(fy, bases, monthLabels, targets, {
    year: yearPeriod,
    quarters: quarterPeriods,
    months: monthPeriods,
  });
}
