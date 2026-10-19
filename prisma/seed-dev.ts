/**
 * 開発環境ブートストラップ（架空データのみ）
 * ============================================================
 * `prisma db push` 直後のまっさらなDBを、ログインして商談一覧・商談詳細まで
 * 触れる状態にする。ローカル開発とインターン生の学習環境で使う。
 *
 * 実行：
 *   npx tsx prisma/seed-dev.ts
 *
 * 投入するのは架空の企業・担当者・商談のみ。実顧客データは一切含まない。
 *
 * 既存の seed-luma.ts / seed-reagey.ts との違い：
 *   - tenants 行を自分で投入する（db push はテーブルを作るだけで行は作らない）
 *   - users + user_tenants を作る（これが無いとテナントが解決できない）
 *   - テナント所有テーブルへの create で tenantId を必ず明示する
 *     （このスクリプトは src/lib/db.ts の Prisma Extension を通らないため、
 *      省略すると tenant_id が '' のまま INSERT され FK 違反で落ちる）
 *
 * 冪等：全レコードを固定UUIDで upsert するため、何度実行しても同じ状態になる。
 */
import { PrismaClient, DealStatus, TaskStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { DEFAULT_LEAD_SOURCES } from "../src/lib/lead-source";
import { LUMA_TENANT_ID, REAGEY_TENANT_ID } from "./tenant-ids";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** 接続先を認証情報を伏せて表示する（誤ったDBに流し込む事故を目視で防ぐ） */
function redactedTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(解析不能なDATABASE_URL)";
  }
}

/**
 * 固定UUID生成。kind は16進4文字。
 * 架空データであることを一目で判別できるよう、実データと異なる規則的なIDにする。
 */
const uid = (kind: string, n: number) =>
  `${kind}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const U = (n: number) => uid("0a01", n); // users
const P = (n: number) => uid("0b01", n); // products
const PL = (n: number) => uid("0b02", n); // product_plans
const C = (n: number) => uid("0c01", n); // companies
const CT = (n: number) => uid("0c02", n); // contacts
const D = (n: number) => uid("0d01", n); // deals
const DP = (n: number) => uid("0d02", n); // deal_products
const M = (n: number) => uid("0e01", n); // meetings
const T = (n: number) => uid("0f01", n); // tasks

const DEV_PASSWORD = "dev1234";

// ============================================================
// マスタ定義
// ============================================================

/** PipelineStage 14件（seed-luma.ts と同一セット） */
const STAGES = [
  { value: "【商談前】商談予定", group: "before", badgeBg: "bg-sky-100", badgeText: "text-sky-800", sortOrder: 10 },
  { value: "【商談前】日程調整不可", group: "before", badgeBg: "bg-zinc-200", badgeText: "text-zinc-700", sortOrder: 20 },
  { value: "【商談前】催促2回送信済", group: "before", badgeBg: "bg-amber-100", badgeText: "text-amber-800", sortOrder: 30 },
  { value: "【商談後】追いかけ1回目", group: "after", badgeBg: "bg-emerald-50", badgeText: "text-emerald-700", sortOrder: 110 },
  { value: "【商談後】追いかけ2回目", group: "after", badgeBg: "bg-emerald-50", badgeText: "text-emerald-700", sortOrder: 120 },
  { value: "【商談後】追いかけ3回目", group: "after", badgeBg: "bg-emerald-100", badgeText: "text-emerald-800", sortOrder: 130 },
  { value: "【商談後】追いかけ4回目", group: "after", badgeBg: "bg-emerald-100", badgeText: "text-emerald-800", sortOrder: 140 },
  { value: "【商談後】追いかけ5回目", group: "after", badgeBg: "bg-emerald-200", badgeText: "text-emerald-900", sortOrder: 150 },
  { value: "【商談後】追いかけ6回目以上", group: "after", badgeBg: "bg-emerald-200", badgeText: "text-emerald-900", sortOrder: 160 },
  { value: "【商談後】稟議中", group: "after", badgeBg: "bg-teal-100", badgeText: "text-teal-800", sortOrder: 170 },
  { value: "【商談後】企画中", group: "after", badgeBg: "bg-teal-100", badgeText: "text-teal-800", sortOrder: 180 },
  { value: "【商談後】トスなし", group: "after", badgeBg: "bg-zinc-100", badgeText: "text-zinc-600", sortOrder: 190 },
  { value: "契約書チェック中", group: "contract", badgeBg: "bg-orange-100", badgeText: "text-orange-800", sortOrder: 210 },
  { value: "契約書送付中（返送待ち）", group: "contract", badgeBg: "bg-green-100", badgeText: "text-green-800", sortOrder: 220 },
];

const INDUSTRIES = [
  "製造", "IT・通信", "医療・介護", "建設・不動産",
  "運輸・物流", "飲食・食品", "小売", "観光・宿泊",
];

/** プロダクト（Lumaの3カテゴリ）とプラン */
const PRODUCTS = [
  {
    n: 1,
    name: "映像",
    plans: [
      { n: 1, name: "採用動画", basePrice: 800000 },
      { n: 2, name: "会社紹介動画", basePrice: 600000 },
      { n: 3, name: "商品PR動画", basePrice: 450000 },
    ],
  },
  {
    n: 2,
    name: "SNS",
    plans: [
      { n: 4, name: "SNS運用代行（6ヶ月）", basePrice: 1200000 },
      { n: 5, name: "スポット制作", basePrice: 300000 },
    ],
  },
  {
    n: 3,
    name: "CATV",
    plans: [{ n: 6, name: "CM枠出稿", basePrice: 250000 }],
  },
];

/** 架空の営業担当。ドメインは RFC 2606 予約の .test を使い、実在しないことを保証する */
const USERS = [
  { n: 1, email: "admin@dev.test", name: "開発 管理者", kana: "カイハツカンリシャ", role: "manager", permission: "admin", color: "#6366f1" },
  { n: 2, email: "manager@dev.test", name: "見本 一郎", kana: "ミホンイチロウ", role: "manager", permission: "user", color: "#0ea5e9" },
  { n: 3, email: "sales1@dev.test", name: "架空 花子", kana: "カクウハナコ", role: "sales", permission: "user", color: "#10b981" },
  { n: 4, email: "sales2@dev.test", name: "仮 太郎", kana: "カリタロウ", role: "sales", permission: "user", color: "#f59e0b" },
];

/** 架空の顧客企業 */
const COMPANIES = [
  { n: 1, name: "サンプル製菓株式会社", industry: "飲食・食品", employees: 180, ceo: "見本 太郎", pref: "東京都千代田区" },
  { n: 2, name: "テスト工業株式会社", industry: "製造", employees: 420, ceo: "架空 次郎", pref: "愛知県名古屋市" },
  { n: 3, name: "ダミー建設株式会社", industry: "建設・不動産", employees: 95, ceo: "仮名 三郎", pref: "大阪府大阪市" },
  { n: 4, name: "例示メディカル株式会社", industry: "医療・介護", employees: 260, ceo: "例示 四郎", pref: "福岡県福岡市" },
  { n: 5, name: "見本ロジスティクス株式会社", industry: "運輸・物流", employees: 610, ceo: "見本 五郎", pref: "神奈川県横浜市" },
  { n: 6, name: "モデル観光株式会社", industry: "観光・宿泊", employees: 75, ceo: "模擬 六郎", pref: "北海道札幌市" },
  { n: 7, name: "仮想システム株式会社", industry: "IT・通信", employees: 140, ceo: "仮想 七海", pref: "東京都渋谷区" },
  { n: 8, name: "テストマート株式会社", industry: "小売", employees: 830, ceo: "試験 八重", pref: "宮城県仙台市" },
];

/**
 * 架空の商談。
 * yomi はデフォルトフィルタ（A+ヨミ/Aヨミ/Bヨミ/Cヨミ）に入るものと入らないものを
 * 混在させ、一覧のフィルタ挙動をそのまま検証できるようにしている。
 */
const DEALS = [
  { n: 1, company: 1, owner: 3, title: "サンプル製菓／採用動画の新規提案", status: DealStatus.PROPOSAL, stage: "【商談後】追いかけ1回目", lead: "HP経由", products: [{ n: 1, product: 1, plan: "採用動画", yomi: "Aヨミ", prob: 70, amount: 800000 }] },
  { n: 2, company: 2, owner: 3, title: "テスト工業／会社紹介動画リニューアル", status: DealStatus.NEGOTIATION, stage: "【商談後】稟議中", lead: "紹介", products: [{ n: 2, product: 1, plan: "会社紹介動画", yomi: "A+ヨミ", prob: 90, amount: 1200000 }] },
  { n: 3, company: 3, owner: 4, title: "ダミー建設／採用動画＋SNS運用", status: DealStatus.PROPOSAL, stage: "【商談後】企画中", lead: "交流会経由", products: [{ n: 3, product: 1, plan: "採用動画", yomi: "【映像】Bヨミ", prob: 50, amount: 750000 }, { n: 4, product: 2, plan: "SNS運用代行（6ヶ月）", yomi: "【SNS】Cヨミ", prob: 30, amount: 1200000 }] },
  { n: 4, company: 4, owner: 4, title: "例示メディカル／商品PR動画", status: DealStatus.HEARING, stage: "【商談前】商談予定", lead: "MS", products: [{ n: 5, product: 1, plan: "商品PR動画", yomi: "Cヨミ", prob: 30, amount: 450000 }] },
  { n: 5, company: 5, owner: 2, title: "見本ロジ／ドライバー採用動画", status: DealStatus.CLOSING, stage: "契約書送付中（返送待ち）", lead: "紹介", products: [{ n: 6, product: 1, plan: "採用動画", yomi: "A+ヨミ", prob: 90, amount: 950000 }] },
  { n: 6, company: 6, owner: 3, title: "モデル観光／インバウンド向けSNS", status: DealStatus.LEAD, stage: "【商談前】商談予定", lead: "SNS経由", products: [{ n: 7, product: 2, plan: "スポット制作", yomi: "ネタ", prob: 10, amount: 300000 }] },
  { n: 7, company: 7, owner: 4, title: "仮想システム／エンジニア採用ブランディング", status: DealStatus.PROPOSAL, stage: "【商談後】追いかけ3回目", lead: "HP経由", products: [{ n: 8, product: 1, plan: "採用動画", yomi: "Bヨミ", prob: 50, amount: 880000 }] },
  { n: 8, company: 8, owner: 2, title: "テストマート／地域CM枠出稿", status: DealStatus.WON, stage: "契約書チェック中", lead: "その他", products: [{ n: 9, product: 3, plan: "CM枠出稿", yomi: "受注", prob: 100, amount: 250000 }] },
  { n: 9, company: 1, owner: 3, title: "サンプル製菓／周年記念ムービー", status: DealStatus.HEARING, stage: "【商談後】追いかけ2回目", lead: "紹介", products: [{ n: 10, product: 1, plan: "会社紹介動画", yomi: "Bヨミ", prob: 50, amount: 600000 }] },
  { n: 10, company: 2, owner: 2, title: "テスト工業／工場紹介SNS運用", status: DealStatus.LEAD, stage: "【商談前】催促2回送信済", lead: "MS", products: [{ n: 11, product: 2, plan: "SNS運用代行（6ヶ月）", yomi: "Cヨミ", prob: 30, amount: 1200000 }] },
];

/**
 * 架空の商談議事録。
 * エンハンス機能②（BANT自動生成）の入力源になるため、
 * BANT4項目を読み取れる程度の内容量を持たせている。
 */
const MEETINGS = [
  {
    n: 1,
    deal: 1,
    daysAgo: 14,
    title: "第1回 ヒアリング",
    minutes:
      "採用サイトのリニューアルに合わせて、採用向けの動画を作りたいとのこと。" +
      "応募数が前年比で3割落ちており、母集団形成が課題。" +
      "予算は人事部の採用広告費から捻出予定で、上限は100万円前後。" +
      "決裁は人事部長と役員会の承認が必要。次年度の新卒採用が始まる前に公開したい。",
    transcript:
      "（架空の文字起こしサンプル）はい、よろしくお願いします。えー、今回はですね、" +
      "採用の動画を検討していまして。応募が去年より3割ぐらい減っていて、まず知ってもらうところが" +
      "できていないなと。予算はですね、採用広告の枠から出す想定で、だいたい100万ぐらいかなと。" +
      "決裁は私と、あと役員会にかける形になります。時期は来年の新卒が動き出す前には出したいですね。",
    bant: { budget: "100万円前後（採用広告費枠）", authority: "人事部長＋役員会承認", need: "応募数が前年比30%減、母集団形成が課題", timeline: "次年度新卒採用の開始前（約4ヶ月後）" },
  },
  {
    n: 2,
    deal: 2,
    daysAgo: 7,
    title: "第2回 提案レビュー",
    minutes:
      "会社紹介動画のリニューアル提案をレビュー。構成案はおおむね合意。" +
      "見積は120万円で提示し、稟議に回すとのこと。" +
      "工場での撮影が必要なため、ライン停止の調整に2週間程度かかる見込み。",
    transcript:
      "（架空の文字起こしサンプル）構成はこれでいいと思います。金額は120万ですね、" +
      "はい、これで稟議あげます。撮影なんですけど、工場のラインを止める必要があるので、" +
      "現場と調整させてください。2週間はみておいてほしいです。",
    bant: { budget: "120万円（提示済み・稟議中）", authority: "稟議承認プロセス進行中", need: "会社紹介動画が10年前のもので実態と乖離", timeline: "撮影調整に2週間、以降着手" },
  },
  {
    n: 3,
    deal: 5,
    daysAgo: 3,
    title: "第3回 最終条件確認",
    minutes:
      "ドライバー採用動画。金額95万円で合意し、契約書を送付済み。返送待ち。" +
      "納品は撮影日から6週間後で調整。",
    transcript:
      "（架空の文字起こしサンプル）金額は95万で大丈夫です。契約書、送っていただければ" +
      "こちらで押印して返します。納品は撮影から6週間ぐらいですよね、はい、了解しました。",
    bant: { budget: "95万円で合意", authority: "決裁済み", need: "ドライバー不足、採用チャネルの拡大", timeline: "撮影日から6週間後に納品" },
  },
];

const TASKS = [
  { n: 1, deal: 1, title: "構成案の初稿を送付する", status: TaskStatus.OPEN, daysFromNow: 3, priority: "high" },
  { n: 2, deal: 1, title: "参考事例3本をまとめて共有", status: TaskStatus.DONE, daysFromNow: -2, priority: "medium" },
  { n: 3, deal: 2, title: "工場撮影の日程候補をもらう", status: TaskStatus.IN_PROGRESS, daysFromNow: 5, priority: "high" },
  { n: 4, deal: 3, title: "SNS運用の運用体制を整理して提案に反映", status: TaskStatus.OPEN, daysFromNow: 7, priority: "medium" },
  { n: 5, deal: 5, title: "契約書の返送を確認する", status: TaskStatus.OPEN, daysFromNow: 2, priority: "high" },
];

// ============================================================
// 投入処理
// ============================================================

const daysFromNow = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000);

async function assertNotProductionData() {
  const companyCount = await prisma.company.count();
  if (companyCount > 20 && process.env.FORCE_DEV_SEED !== "1") {
    throw new Error(
      `[safety] 既存の企業が ${companyCount} 件あります。実データの入ったDBの可能性が高いため中止しました。\n` +
        `        意図した操作であれば FORCE_DEV_SEED=1 を付けて再実行してください。`,
    );
  }
}

async function main() {
  console.log("[seed-dev] start");
  console.log(`[seed-dev] 接続先: ${redactedTarget(connectionString!)}`);

  await assertNotProductionData();

  // ── テナント（db push はテーブルを作るだけなので行は自前で入れる） ──
  const tenants = [
    { id: LUMA_TENANT_ID, code: "luma", name: "株式会社Luma", shortName: "Luma", fiscalYearStartMonth: 6, themeColor: "#F97316", sortOrder: 1 },
    { id: REAGEY_TENANT_ID, code: "reagey", name: "株式会社リージー", shortName: "リージー", fiscalYearStartMonth: 1, themeColor: "#047857", sortOrder: 2 },
  ];
  for (const t of tenants) {
    await prisma.tenant.upsert({ where: { id: t.id }, update: t, create: t });
  }
  console.log(`  [tenant] ${tenants.length}件`);

  // ── ユーザーと所属 ──
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  for (const u of USERS) {
    const data = {
      email: u.email,
      name: u.name,
      nameKana: u.kana,
      role: u.role,
      permission: u.permission,
      avatarColor: u.color,
      passwordHash,
    };
    await prisma.user.upsert({ where: { id: U(u.n) }, update: data, create: { id: U(u.n), ...data } });

    // user_tenants が無いとテナントが解決できず、Extension の移行期フォールバックに落ちる
    const membership = {
      userId: U(u.n),
      tenantId: LUMA_TENANT_ID,
      permission: u.permission,
      role: u.role,
      isDefault: true,
      crossTenantRead: u.permission === "admin",
    };
    await prisma.userTenant.upsert({
      where: { userId_tenantId: { userId: U(u.n), tenantId: LUMA_TENANT_ID } },
      update: membership,
      create: membership,
    });
  }
  console.log(`  [user] ${USERS.length}件（全員 Luma 所属）`);

  // ── マスタ ──
  for (const ls of DEFAULT_LEAD_SOURCES) {
    await prisma.leadSource.upsert({
      where: { tenantId_name: { tenantId: LUMA_TENANT_ID, name: ls.name } },
      update: { sortOrder: ls.sortOrder, active: true },
      create: { tenantId: LUMA_TENANT_ID, name: ls.name, sortOrder: ls.sortOrder, active: true },
    });
  }
  console.log(`  [leadSource] ${DEFAULT_LEAD_SOURCES.length}件`);

  for (const s of STAGES) {
    const data = { label: s.value, group: s.group, badgeBg: s.badgeBg, badgeText: s.badgeText, sortOrder: s.sortOrder, active: true };
    await prisma.pipelineStage.upsert({
      where: { tenantId_value: { tenantId: LUMA_TENANT_ID, value: s.value } },
      update: data,
      create: { tenantId: LUMA_TENANT_ID, value: s.value, ...data },
    });
  }
  console.log(`  [pipelineStage] ${STAGES.length}件`);

  for (const [i, name] of INDUSTRIES.entries()) {
    await prisma.industry.upsert({
      where: { tenantId_name: { tenantId: LUMA_TENANT_ID, name } },
      update: { sortOrder: (i + 1) * 10, active: true },
      create: { tenantId: LUMA_TENANT_ID, name, sortOrder: (i + 1) * 10, active: true },
    });
  }
  console.log(`  [industry] ${INDUSTRIES.length}件`);

  let planCount = 0;
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { id: P(p.n) },
      update: { name: p.name, active: true },
      create: { id: P(p.n), tenantId: LUMA_TENANT_ID, name: p.name, active: true },
    });
    for (const pl of p.plans) {
      const data = { productId: P(p.n), name: pl.name, basePrice: pl.basePrice, sortOrder: pl.n * 10, active: true };
      await prisma.productPlan.upsert({
        where: { id: PL(pl.n) },
        update: data,
        create: { id: PL(pl.n), tenantId: LUMA_TENANT_ID, ...data },
      });
      planCount += 1;
    }
  }
  console.log(`  [product] ${PRODUCTS.length}件 / [productPlan] ${planCount}件`);

  // ── 顧客企業と担当者（Company / Contact はテナント所有ではなく共有マスタ） ──
  for (const c of COMPANIES) {
    const data = {
      name: c.name,
      industry: c.industry,
      employeeCount: c.employees,
      ceoName: c.ceo,
      address: c.pref,
      createdByTenantId: LUMA_TENANT_ID,
      note: "開発用のダミー企業（実在しません）",
    };
    await prisma.company.upsert({ where: { id: C(c.n) }, update: data, create: { id: C(c.n), ...data } });

    const contact = {
      companyId: C(c.n),
      name: `${c.ceo.split(" ")[0]} 担当`,
      role: "経営企画部 部長",
      email: `contact${c.n}@dev.test`,
      phone: "03-0000-0000",
      isPrimary: true,
      isDecisionMaker: true,
    };
    await prisma.contact.upsert({ where: { id: CT(c.n) }, update: contact, create: { id: CT(c.n), ...contact } });
  }
  console.log(`  [company] ${COMPANIES.length}件 / [contact] ${COMPANIES.length}件`);

  // ── 商談 ──
  const leadSources = await prisma.leadSource.findMany({ where: { tenantId: LUMA_TENANT_ID } });
  const leadSourceIdByName = new Map(leadSources.map((ls) => [ls.name, ls.id]));

  let dealProductCount = 0;
  for (const d of DEALS) {
    const data = {
      companyId: C(d.company),
      ownerUserId: U(d.owner),
      title: d.title,
      status: d.status,
      pipelineStage: d.stage,
      leadSourceId: leadSourceIdByName.get(d.lead) ?? null,
      appointmentDate: daysFromNow(-30 + d.n),
      nextAction: "次回打ち合わせの日程を調整する",
      nextActionAt: daysFromNow(d.n),
    };
    await prisma.deal.upsert({
      where: { id: D(d.n) },
      update: data,
      create: { id: D(d.n), tenantId: LUMA_TENANT_ID, ...data },
    });

    for (const dp of d.products) {
      const dpData = {
        dealId: D(d.n),
        productId: P(dp.product),
        productName: PRODUCTS.find((p) => p.n === dp.product)!.name,
        planName: dp.plan,
        probability: dp.prob,
        amount: dp.amount,
        yomiStatus: dp.yomi,
        ownerUserId: U(d.owner),
      };
      await prisma.dealProduct.upsert({
        where: { id: DP(dp.n) },
        update: dpData,
        create: { id: DP(dp.n), tenantId: LUMA_TENANT_ID, ...dpData },
      });
      dealProductCount += 1;
    }
  }
  console.log(`  [deal] ${DEALS.length}件 / [dealProduct] ${dealProductCount}件`);

  // ── 議事録とToDo ──
  for (const m of MEETINGS) {
    const data = {
      dealId: D(m.deal),
      meetingDate: daysFromNow(-m.daysAgo),
      title: m.title,
      minutes: m.minutes,
      transcript: m.transcript,
      bantBudget: m.bant.budget,
      bantAuthority: m.bant.authority,
      bantNeed: m.bant.need,
      bantTimeline: m.bant.timeline,
    };
    await prisma.meeting.upsert({
      where: { id: M(m.n) },
      update: data,
      create: { id: M(m.n), tenantId: LUMA_TENANT_ID, ...data },
    });
  }
  console.log(`  [meeting] ${MEETINGS.length}件`);

  for (const t of TASKS) {
    const data = {
      dealId: D(t.deal),
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: daysFromNow(t.daysFromNow),
      completedAt: t.status === TaskStatus.DONE ? daysFromNow(t.daysFromNow) : null,
    };
    await prisma.task.upsert({
      where: { id: T(t.n) },
      update: data,
      create: { id: T(t.n), tenantId: LUMA_TENANT_ID, ...data },
    });
  }
  console.log(`  [task] ${TASKS.length}件`);

  console.log("");
  console.log("[seed-dev] done");
  console.log("");
  console.log("  ログイン: http://localhost:3003/login");
  for (const u of USERS) {
    console.log(`    ${u.email.padEnd(20)} / ${DEV_PASSWORD}  （${u.name}・${u.permission}）`);
  }
  console.log("");
  console.log("  投入したのは架空データのみ。実顧客データは含まれていない。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
