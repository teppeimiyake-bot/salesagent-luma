/**
 * ToDo除外フィルタの影響件数を集計するワンショットスクリプト
 * 実行：npx tsx scripts/count-todo-impact.ts
 */
import { prisma } from "../src/lib/db";
import {
  excludeNGDealsWhere,
  excludeDoneAndNGDealsWhere,
} from "../src/lib/deal-status-server";

async function main() {
  const activeDeal = { deletedAt: null, company: { deletedAt: null } } as const;

  const totalDeals = await prisma.deal.count({ where: activeDeal });
  const wonDeals = await prisma.deal.count({
    where: { ...activeDeal, status: "WON" },
  });
  const lostDeals = await prisma.deal.count({
    where: { ...activeDeal, status: "LOST" },
  });

  const ngOnly = await excludeNGDealsWhere();
  const todoEx = await excludeDoneAndNGDealsWhere();

  const totalTasks = await prisma.task.count({
    where: {
      deal: activeDeal,
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
  });
  const tasksAfterNgOnly = await prisma.task.count({
    where: {
      deal: { ...activeDeal, AND: [...ngOnly.AND] },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
  });
  const tasksAfterFull = await prisma.task.count({
    where: {
      deal: { ...activeDeal, AND: [...todoEx.AND] },
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
  });

  const dealsWithNA = await prisma.deal.count({
    where: {
      ...activeDeal,
      AND: [{ nextAction: { not: null } }, { nextAction: { not: "" } }],
    },
  });
  const dealsWithNaAfterFull = await prisma.deal.count({
    where: {
      ...activeDeal,
      AND: [
        { nextAction: { not: null } },
        { nextAction: { not: "" } },
        ...todoEx.AND,
      ],
    },
  });

  console.log("===== Deal件数 =====");
  console.log("  total active:", totalDeals);
  console.log("  WON:", wonDeals, " LOST:", lostDeals);
  console.log("  fullyLostDealIds:", todoEx.fullyLostDealIds.length);
  console.log("  fullyWonDealIds:", todoEx.fullyWonDealIds.length);
  console.log("");
  console.log("===== OPEN/IN_PROGRESS Task件数（active deal配下） =====");
  console.log("  フィルタなし:                  ", totalTasks);
  console.log("  NG除外のみ（旧）:               ", tasksAfterNgOnly);
  console.log("  WON/LOST/NG除外（新）:          ", tasksAfterFull);
  console.log(
    "  → 差分（受注/失注で消える）:   ",
    totalTasks - tasksAfterFull,
    "件",
  );
  console.log("");
  console.log("===== Deal.nextAction 件数（active deal） =====");
  console.log("  フィルタなし:                  ", dealsWithNA);
  console.log("  WON/LOST/NG除外（新）:          ", dealsWithNaAfterFull);
  console.log("  → 差分:                        ", dealsWithNA - dealsWithNaAfterFull, "件");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
