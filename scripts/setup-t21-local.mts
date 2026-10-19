import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { prismaUnscoped: prisma } = require("../src/lib/db.ts") as typeof import("../src/lib/db");
const ownDealId = "16d00000-0000-4000-8000-000000000001";

const base = await prisma.deal.findUniqueOrThrow({
  where: { id: ownDealId },
  select: { tenantId: true, ownerUserId: true },
});

const rows = [
  {
    companyId: "21c00000-0000-4000-8000-000000000002",
    dealId: "21d00000-0000-4000-8000-000000000002",
    company: "ミナト光学工房株式会社（T21検証用・架空）",
    title: "先方主催Meetによる業務映像共有の商談",
    owner: "guest_meet",
    url: "https://meet.google.com/xxx-yyyy-zzz",
    amount: "月額28万円、初期費用60万円",
    problem: "検査映像の共有に時間がかかり、品質判断が属人化",
    proposal: "映像ナレッジ共有と検索の業務基盤",
    start: "2026-09-03T04:00:00.000Z",
  },
  {
    companyId: "21c00000-0000-4000-8000-000000000003",
    dealId: "21d00000-0000-4000-8000-000000000003",
    company: "ツキカゲ物流研究所株式会社（T21検証用・架空）",
    title: "先方主催Zoomによる配送改善の商談",
    owner: "zoom",
    url: "https://zoom.us/j/123456789",
    amount: "月額35万円、初期費用80万円",
    problem: "配送会議の記録が散在し、改善施策の追跡が困難",
    proposal: "会議記録と改善タスクを一元管理する営業支援基盤",
    start: "2026-09-04T05:00:00.000Z",
  },
] as const;

for (const row of rows) {
  const note = `課題: ${row.problem}\n提案: ${row.proposal}\n想定金額: ${row.amount}`;
  await prisma.company.upsert({
    where: { id: row.companyId },
    create: {
      id: row.companyId,
      name: row.company,
      note,
      createdByTenantId: base.tenantId,
    },
    update: { name: row.company, note },
  });

  const start = new Date(row.start);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  await prisma.deal.upsert({
    where: { id: row.dealId },
    create: {
      id: row.dealId,
      tenantId: base.tenantId,
      companyId: row.companyId,
      ownerUserId: base.ownerUserId,
      title: row.title,
      meetUrl: row.url,
      meetingOwnerType: row.owner,
      meetingStartAt: start,
      meetingEndAt: end,
      nextAction: "先方から録画または議事録を受領し手動添付",
      pipelineStage: "商談",
    },
    update: {
      meetUrl: row.url,
      meetingOwnerType: row.owner,
      meetingStartAt: start,
      meetingEndAt: end,
    },
  });
}

await prisma.deal.update({
  where: { id: ownDealId },
  data: { meetingOwnerType: "own_meet" },
});

console.log(
  JSON.stringify(
    await prisma.deal.findMany({
      where: { id: { in: [ownDealId, ...rows.map((row) => row.dealId)] } },
      select: {
        id: true,
        meetingOwnerType: true,
        meetUrl: true,
        company: { select: { name: true } },
      },
      orderBy: { id: "asc" },
    }),
    null,
    2,
  ),
);

await prisma.$disconnect();
