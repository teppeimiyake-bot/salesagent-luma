import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log('=== (1) deal_products productName別件数 ===');
  const productCounts = await prisma.dealProduct.groupBy({
    by: ['productName'],
    _count: { _all: true },
    orderBy: { _count: { productName: 'desc' } },
  });
  productCounts.forEach((r) => {
    console.log(`  ${r.productName}: ${r._count._all}`);
  });

  console.log('\n=== (2) アライアンス deal_products の yomiStatus 分布 ===');
  const allianceYomi = await prisma.dealProduct.groupBy({
    by: ['yomiStatus'],
    where: { productName: 'アライアンス' },
    _count: { _all: true },
  });
  allianceYomi
    .sort((a, b) => b._count._all - a._count._all)
    .forEach((r) => {
      console.log(`  ${r.yomiStatus ?? '(null)'}: ${r._count._all}`);
    });

  console.log('\n=== (3) 全 deal_products yomiStatus 分布（productName別） ===');
  const allYomi = await prisma.dealProduct.groupBy({
    by: ['productName', 'yomiStatus'],
    _count: { _all: true },
  });
  allYomi
    .sort((a, b) =>
      a.productName === b.productName
        ? (a.yomiStatus ?? '').localeCompare(b.yomiStatus ?? '')
        : a.productName.localeCompare(b.productName),
    )
    .forEach((r) => {
      console.log(`  [${r.productName}] ${r.yomiStatus ?? '(null)'}: ${r._count._all}`);
    });

  console.log('\n=== (4) pipeline_stages 全件 ===');
  const stages = await prisma.pipelineStage.findMany({
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
  });
  stages.forEach((s) => {
    console.log(
      `  [group=${s.group} sortOrder=${s.sortOrder}] value="${s.value}" / label="${s.label}" (active=${s.active})`,
    );
  });

  console.log('\n=== (5) deals の pipelineStage 分布 ===');
  const dealsByStage = await prisma.deal.groupBy({
    by: ['pipelineStage'],
    _count: { _all: true },
  });
  dealsByStage
    .sort((a, b) => b._count._all - a._count._all)
    .forEach((r) => {
      console.log(`  "${r.pipelineStage ?? '(null)'}" : ${r._count._all}`);
    });

  console.log('\n=== (6) deal_products yomiStatus に NG/失注 含む件数 ===');
  const ngYomi = await prisma.dealProduct.findMany({
    where: {
      OR: [
        { yomiStatus: { contains: 'NG' } },
        { yomiStatus: { contains: '失注' } },
      ],
    },
    select: { productName: true, yomiStatus: true },
  });
  const ngMap = new Map<string, number>();
  ngYomi.forEach((r) => {
    const key = `${r.productName} / ${r.yomiStatus}`;
    ngMap.set(key, (ngMap.get(key) ?? 0) + 1);
  });
  Array.from(ngMap.entries())
    .sort((a, b) => b[1] - a[1])
    .forEach(([key, count]) => {
      console.log(`  ${key}: ${count}`);
    });

  console.log('\n=== (7) 全 deal_products が NG/失注 の deal数（完全失注） ===');
  const allDP = await prisma.dealProduct.findMany({
    select: { dealId: true, yomiStatus: true, productName: true },
  });
  const dealYomiMap = new Map<string, { yomi: string; productName: string }[]>();
  allDP.forEach((r) => {
    const arr = dealYomiMap.get(r.dealId) ?? [];
    arr.push({ yomi: r.yomiStatus ?? '', productName: r.productName });
    dealYomiMap.set(r.dealId, arr);
  });
  let fullyNG = 0;
  let partialNG = 0;
  const fullyNGDealIds: string[] = [];
  dealYomiMap.forEach((arr, dealId) => {
    const hasNG = arr.some((y) => y.yomi.includes('NG') || y.yomi.includes('失注'));
    const allNG = arr.every((y) => y.yomi.includes('NG') || y.yomi.includes('失注'));
    if (allNG) {
      fullyNG++;
      fullyNGDealIds.push(dealId);
    } else if (hasNG) {
      partialNG++;
    }
  });
  console.log(`  全 deal_products が NG/失注: ${fullyNG} 件（完全失注）`);
  console.log(`  一部のみ NG/失注: ${partialNG} 件（部分失注）`);
  console.log(`  NG/失注なし: ${dealYomiMap.size - fullyNG - partialNG} 件`);
  console.log(`  deal_products を持たない deal: 集計外`);

  console.log('\n=== (8) 既存 NG指標の重複・統合チェック ===');
  // pipelineStage の文字列で「日程調整不可」を含むもの
  const noScheduleCount = await prisma.deal.count({
    where: { pipelineStage: { contains: '日程調整不可' } },
  });
  console.log(`  pipelineStage に '日程調整不可' を含む deal数: ${noScheduleCount}`);

  const isNGDeals = await prisma.deal.findMany({
    where: { bant: { path: ['isNG'], equals: true } },
    select: { id: true },
  });
  console.log(`  bant.isNG=true の deal数: ${isNGDeals.length}`);

  // アライアンスのみ持つ deal
  const allianceOnlyDealIds = new Set<string>();
  const dealProductsArr = Array.from(dealYomiMap.entries());
  dealProductsArr.forEach(([dealId, arr]) => {
    if (arr.length > 0 && arr.every((y) => y.productName === 'アライアンス')) {
      allianceOnlyDealIds.add(dealId);
    }
  });
  console.log(`  アライアンス商材だけを持つ deal数: ${allianceOnlyDealIds.size}`);

  console.log('\n=== (9) 完全失注 deal の pipelineStage 分布 ===');
  if (fullyNGDealIds.length > 0) {
    const fullyNGDeals = await prisma.deal.findMany({
      where: { id: { in: fullyNGDealIds } },
      select: { pipelineStage: true },
    });
    const stageDist = new Map<string, number>();
    fullyNGDeals.forEach((d) => {
      const key = d.pipelineStage ?? '(null)';
      stageDist.set(key, (stageDist.get(key) ?? 0) + 1);
    });
    Array.from(stageDist.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, c]) => {
        console.log(`  "${name}": ${c}`);
      });
  }

  console.log('\n=== (10) 完全失注 deal の bant.isNG 分布 ===');
  if (fullyNGDealIds.length > 0) {
    const fullyNGDeals2 = await prisma.deal.findMany({
      where: { id: { in: fullyNGDealIds } },
      select: { bant: true },
    });
    let isNGTrue = 0;
    let isNGOther = 0;
    fullyNGDeals2.forEach((d) => {
      const bant = d.bant as Record<string, unknown> | null;
      if (bant && bant.isNG === true) isNGTrue++;
      else isNGOther++;
    });
    console.log(`  bant.isNG=true: ${isNGTrue}`);
    console.log(`  bant.isNG=false/null/欠如: ${isNGOther}`);
  }

  console.log('\n=== (11) 4画面除外の現状 vs 完全失注の重複度 ===');
  // 既存除外 = bant.isNG=true OR pipelineStage='【商談前】日程調整不可'
  const existingExclusionIds = new Set<string>();
  isNGDeals.forEach((d) => existingExclusionIds.add(d.id));
  const noScheduleDeals = await prisma.deal.findMany({
    where: { pipelineStage: { contains: '日程調整不可' } },
    select: { id: true },
  });
  noScheduleDeals.forEach((d) => existingExclusionIds.add(d.id));
  console.log(`  既存除外 deal数（isNG OR 日程調整不可）: ${existingExclusionIds.size}`);

  // 完全失注で既存除外に含まれていないもの
  const newlyExcludedByFullyNG = fullyNGDealIds.filter((id) => !existingExclusionIds.has(id));
  console.log(`  完全失注のうち既存除外に未含: ${newlyExcludedByFullyNG.length}（追加除外候補）`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
