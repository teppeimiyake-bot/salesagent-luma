/**
 * テナント境界の検証
 * ============================================================
 * 「Luma のデータがリージーから見えないこと」をコードで確認する。
 * 実装ミスによる別法人への情報漏洩は統合プロジェクト最大のリスクであり、
 * Phase 5（リージーデータ投入）の前に必ずこれを通すこと。
 *
 * 実行:
 *   npx tsx scripts/verify-tenant-isolation.ts .env.staging
 *
 * 第1引数の env ファイルから DATABASE_URL を読む（省略時は .env.staging）。
 * テスト用の商談・企業を作って消すため、**本番DBでは実行しないこと**。
 */
import fs from "node:fs";
import { LUMA_TENANT_ID, REAGEY_TENANT_ID } from "../prisma/tenant-ids";
import type { TenantCtx } from "../src/lib/tenant-context";

// DB接続は import 時に確立されるため、先に DATABASE_URL を差し込んでから読み込む
const envFile = process.argv[2] ?? ".env.staging";
if (!fs.existsSync(envFile)) {
  console.error(`env ファイルが見つかりません: ${envFile}`);
  console.error("使い方: npx tsx scripts/verify-tenant-isolation.ts .env.staging");
  process.exit(1);
}
const dbUrl = fs.readFileSync(envFile, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
if (!dbUrl) {
  console.error(`${envFile} に DATABASE_URL がありません`);
  process.exit(1);
}
process.env.DATABASE_URL = dbUrl[1];

let failed = 0;
const ok = (m: string) => console.log("  ✓ " + m);
const ng = (m: string) => { console.error("  ✗ " + m); failed++; };

const ctx = (tenantId: string, over: Partial<TenantCtx> = {}): TenantCtx => ({
  tenantId,
  code: tenantId === LUMA_TENANT_ID ? "luma" : "reagey",
  fiscalYearStartMonth: tenantId === LUMA_TENANT_ID ? 6 : 1,
  userId: "verify-script",
  permission: "admin",
  crossTenant: false,
  ...over,
});

async function main() {
  // DATABASE_URL を差し込んだ後に読み込む必要があるため、ここで動的 import する
  const { prisma, prismaUnscoped, TENANT_SCOPED_MODELS } = await import("../src/lib/db");
  const { runWithTenant } = await import("../src/lib/tenant-context");

  console.log("=== テナント境界の検証 ===\n");

  // 0. 保護対象モデルが schema と同期しているか
  console.log("[0] 保護対象モデル");
  const scoped = [...TENANT_SCOPED_MODELS];
  scoped.length === 31
    ? ok(`tenantId を持つモデル ${scoped.length} 件すべてが境界の対象`)
    : ng(`保護対象が ${scoped.length} 件（想定 31 件）。schema.prisma とズレている`);

  // テスト用の企業（共有マスタ）を1件用意
  const testCompany =
    (await prismaUnscoped.company.findFirst({ where: { name: "__tenant_verify__" } })) ??
    (await prismaUnscoped.company.create({ data: { name: "__tenant_verify__" } }));

  // 後片付け用
  const createdDealIds: string[] = [];

  try {
    // 1. 作成時に tenant_id が自動で入るか
    console.log("\n[1] 作成時の自動付与");
    const lumaDeal = await runWithTenant(ctx(LUMA_TENANT_ID), () =>
      prisma.deal.create({ data: { companyId: testCompany.id, title: "__verify_luma__" } }),
    );
    createdDealIds.push(lumaDeal.id);
    lumaDeal.tenantId === LUMA_TENANT_ID
      ? ok("Luma として作成した商談に Luma の tenant_id が入る")
      : ng(`tenant_id が ${lumaDeal.tenantId}`);

    const reageyDeal = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.create({ data: { companyId: testCompany.id, title: "__verify_reagey__" } }),
    );
    createdDealIds.push(reageyDeal.id);
    reageyDeal.tenantId === REAGEY_TENANT_ID
      ? ok("リージーとして作成した商談にリージーの tenant_id が入る")
      : ng(`tenant_id が ${reageyDeal.tenantId}`);

    // 2. 読み取りが自テナントに閉じるか
    console.log("\n[2] 読み取りの遮断");
    const seenByReagey = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.findMany({ where: { title: { startsWith: "__verify_" } } }),
    );
    seenByReagey.every((d) => d.tenantId === REAGEY_TENANT_ID)
      ? ok("findMany: リージーから Luma の商談は見えない")
      : ng("findMany で他テナントの商談が見えた");

    const cnt = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.count({ where: { title: { startsWith: "__verify_" } } }),
    );
    cnt === 1 ? ok("count: 自テナント分のみ数える") : ng(`count が ${cnt}（想定 1）`);

    // 3. findUnique（id 直指定）でも他テナントの行を返さないか
    console.log("\n[3] ID 直指定の遮断");
    const stolen = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.findUnique({ where: { id: lumaDeal.id } }),
    );
    stolen === null
      ? ok("findUnique: 他テナントの商談を ID 直指定しても null")
      : ng("findUnique で他テナントの商談が取れた（URL に他社の商談IDを入れれば覗ける状態）");

    const stolenSelect = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.findUnique({ where: { id: lumaDeal.id }, select: { id: true, title: true } }),
    );
    stolenSelect === null
      ? ok("findUnique + select でも同様に遮断される")
      : ng("select 指定時に他テナントの商談が取れた");

    // 自テナントのものは select 指定でも普通に取れること（過剰遮断していないか）
    const mine = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.findUnique({ where: { id: reageyDeal.id }, select: { id: true, title: true } }),
    );
    mine && !("tenantId" in mine)
      ? ok("自テナントの商談は取得でき、検証用に足した tenantId は結果に混ざらない")
      : ng("自テナントの商談が取得できない、または tenantId が結果に混入している");

    // 4. 更新・削除の遮断
    console.log("\n[4] 更新・削除の遮断");
    const updated = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.updateMany({ where: { id: lumaDeal.id }, data: { title: "__hijacked__" } }),
    );
    updated.count === 0
      ? ok("updateMany: 他テナントの商談は更新できない")
      : ng("他テナントの商談を更新できてしまった");

    const deleted = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.deleteMany({ where: { id: lumaDeal.id } }),
    );
    deleted.count === 0
      ? ok("deleteMany: 他テナントの商談は削除できない")
      : ng("他テナントの商談を削除できてしまった");

    const stillThere = await prismaUnscoped.deal.findUnique({ where: { id: lumaDeal.id } });
    stillThere?.title === "__verify_luma__"
      ? ok("Luma の商談は無傷のまま")
      : ng("Luma の商談が改変・削除された");

    // 5. 全社統合ビュー
    console.log("\n[5] 全社統合ビュー");
    const all = await runWithTenant(
      ctx(LUMA_TENANT_ID, { tenantId: null, code: "__all__", crossTenant: true, permission: "viewer" }),
      () => prisma.deal.findMany({ where: { title: { startsWith: "__verify_" } } }),
    );
    all.length === 2 ? ok("全社ビューでは両社の商談が見える") : ng(`全社ビューで ${all.length} 件（想定 2）`);

    let blocked = false;
    await runWithTenant(
      ctx(LUMA_TENANT_ID, { tenantId: null, code: "__all__", crossTenant: true, permission: "viewer" }),
      () => prisma.deal.create({ data: { companyId: testCompany.id, title: "__verify_all__" } }),
    ).catch(() => { blocked = true; });
    blocked ? ok("全社ビューからの書き込みは拒否される") : ng("全社ビューで書き込めてしまった（誤起票の恐れ）");

    // 6. ネストした create にも tenant_id が入るか
    //    商談は products: { create: {...} } を伴って作られるため、ここが抜けると
    //    新規商談の登録そのものが FK 違反で失敗する
    console.log("\n[6] ネストした作成");
    const nested = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.create({
        data: {
          companyId: testCompany.id,
          title: "__verify_nested__",
          products: { create: { productName: "採用ブランディング", probability: 20 } },
        },
        include: { products: true },
      }),
    );
    createdDealIds.push(nested.id);
    nested.products[0]?.tenantId === REAGEY_TENANT_ID
      ? ok("商談に紐づけて作った商材にも同じ tenant_id が入る")
      : ng(`ネストした商材の tenant_id が ${nested.products[0]?.tenantId}`);

    // 7. 生SQL（Prisma Extension が効かない唯一の経路）
    console.log("\n[7] 生SQL（deal-status-server.ts）");
    const { getFullyLostDealIds } = await import("../src/lib/deal-status-server");
    // リージーに完全失注の商談を1件作る（商材が全てNG）
    const lostDeal = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.deal.create({
        data: {
          companyId: testCompany.id,
          title: "__verify_lost__",
          products: { create: { productName: "採用ブランディング", yomiStatus: "NG" } },
        },
      }),
    );
    createdDealIds.push(lostDeal.id);

    const lostFromReagey = await runWithTenant(ctx(REAGEY_TENANT_ID), () => getFullyLostDealIds());
    const lostFromLuma = await runWithTenant(ctx(LUMA_TENANT_ID), () => getFullyLostDealIds());
    lostFromReagey.includes(lostDeal.id)
      ? ok("生SQL: 自テナントの完全失注商談は取得できる")
      : ng("生SQL: 自テナントの商談が取得できない");
    !lostFromLuma.includes(lostDeal.id)
      ? ok("生SQL: 他テナントの商談は混ざらない（tenant_id 条件が効いている）")
      : ng("生SQL: 他テナントの商談IDが混入した — $queryRaw に tenant_id 条件が無い");

    // 8. 共有マスタは絞られないこと
    console.log("\n[8] 共有マスタ（企業）");
    const companiesFromReagey = await runWithTenant(ctx(REAGEY_TENANT_ID), () =>
      prisma.company.findFirst({ where: { id: testCompany.id } }),
    );
    companiesFromReagey
      ? ok("企業マスタは両社から参照できる（相互送客のため共有）")
      : ng("共有マスタである企業が絞り込まれてしまっている");
  } finally {
    // 後片付け
    await prismaUnscoped.deal.deleteMany({ where: { title: { startsWith: "__verify_" } } });
    await prismaUnscoped.deal.deleteMany({ where: { title: "__hijacked__" } });
    await prismaUnscoped.company.deleteMany({ where: { name: "__tenant_verify__" } });
  }

  console.log(failed === 0 ? "\n=== 全チェック通過 ===" : `\n=== ${failed} 件の失敗 ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
