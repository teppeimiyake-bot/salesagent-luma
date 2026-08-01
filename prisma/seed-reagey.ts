/**
 * リージー版seed：実顧客データ＋実社員データの投入
 *
 * 実行：DATABASE_URL=salesagent_reagey で
 *   npx tsx prisma/seed-reagey.ts
 *
 * 既存データは upsert ベースで保護。
 * Deal/Contact は同じ Company×Product 組合せがあれば再生成しない。
 */
import { PrismaClient, DealStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { DEFAULT_LEAD_SOURCES } from "../src/lib/lead-source";
import { REAGEY_TENANT_ID } from "./tenant-ids";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");
if (!connectionString.includes("salesagent_reagey")) {
  throw new Error(
    `[safety] DATABASE_URL does not point to salesagent_reagey. Got: ${connectionString}`,
  );
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ============================================================
// 商材マスタ（リージー）
// ============================================================
const PRODUCTS: {
  name: string;
  category: string;
  description?: string;
  planNames: string[];
}[] = [
  {
    name: "映像",
    category: "映像",
    description: "採用動画・会社紹介動画など。企画〜撮影〜編集〜納品まで一気通貫。",
    planNames: ["採用動画", "会社紹介動画", "その他"],
  },
  {
    name: "SNS",
    category: "SNS",
    description: "YouTube/Instagram/TikTok の運用代行。会社・採用ブランディング向け。",
    planNames: ["会社ブランディング向け運用", "採用ブランディング向け運用", "その他"],
  },
  {
    name: "HP制作",
    category: "HP",
    description: "コーポレートサイト・採用LPの企画〜制作〜公開まで。",
    planNames: ["会社HP制作", "採用LP"],
  },
  {
    name: "採用コンサル",
    category: "コンサル",
    description: "母集団形成〜選考設計〜内定承諾までの採用課題コンサル。",
    planNames: ["スタンダード"],
  },
  {
    name: "営業支援",
    category: "営業支援",
    description: "リスト作成・架電代行・商談同席など、営業活動のアウトソーシング。",
    planNames: ["スタンダード"],
  },
  {
    name: "Re;easy HR",
    category: "SaaS",
    description: "採用担当向け候補者ごとAIアシスタントSaaS。専門職特化。",
    planNames: ["¥10万/月", "¥30万/月", "¥50万/月"],
  },
];

// ============================================================
// 社員（実名）
// ============================================================
const USERS: {
  email: string;
  name: string;
  role: "sales" | "manager";
  permission: "admin" | "user" | "viewer";
  avatarColor: string;
}[] = [
  {
    email: "teppei.miyake@luma-create.com",
    name: "三宅 哲平",
    role: "sales",
    permission: "admin",
    avatarColor: "#6366f1",
  },
  {
    email: "hana.tominaga@luma-create.com",
    name: "冨永 羽菜",
    role: "sales",
    permission: "user",
    avatarColor: "#ec4899",
  },
];

// ============================================================
// 顧客データ（Notion生データ）
// ============================================================
type YomiKey = "映像" | "SNS" | "HP" | "採用コンサル" | "営業支援" | "Re;easy HR";
type Yomi = "受注" | "Aヨミ" | "Bヨミ" | "Cヨミ" | "ネタ" | "NG";

interface CompanyData {
  name: string;
  hp?: string;
  industry?: string;
  ceoName?: string;
  phone?: string;
  apoDate?: string; // アポ取得日
  meetingDate?: string; // 初回商談日
  nextActionDate?: string;
  nextAction?: string;
  contractDate?: string;
  pipelineStage: string;
  contacts?: { name?: string; email?: string; phone?: string; isPrimary?: boolean }[];
  amount?: number;
  yomi: Partial<Record<YomiKey, Yomi>>;
  proposalUrl?: string;
  // 担当者（カンマ区切り名）→ ownerメール解決
  ownerNames: string[]; // ["三宅"], ["三宅","冨永"], ["冨永"]
  // リード獲得経由（LeadSource.name）
  leadSource?: string;
}

const COMPANIES: CompanyData[] = [
  {
    name: "株式会社システムサポート",
    hp: "https://www.sts-inc.co.jp",
    apoDate: "2026-04-30",
    meetingDate: "2026-05-18",
    pipelineStage: "【商談前】商談予定",
    contacts: [{ name: "武士垣外 寛之", email: "h-bushigaito@sts-inc.co.jp", isPrimary: true }],
    yomi: {},
    ownerNames: ["三宅"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "株式会社タイヤーサービスセンター",
    apoDate: "2026-04-08",
    meetingDate: "2026-05-15",
    pipelineStage: "【商談前】商談予定",
    yomi: {},
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "前田特許事務所",
    apoDate: "2026-04-08",
    meetingDate: "2026-05-15",
    nextActionDate: "2026-05-07",
    nextAction: "次回HP・動画について提案",
    pipelineStage: "【商談前】商談予定",
    yomi: {},
    ownerNames: ["三宅", "冨永"],
    leadSource: "HP経由",
  },
  {
    name: "株式会社銭形企画",
    hp: "https://zenigata-group.jp/",
    apoDate: "2026-04-30",
    meetingDate: "2026-05-12",
    pipelineStage: "【商談前】商談予定",
    contacts: [{ name: "上野 眞司", email: "ueno.shin@zenigata-kyoto.com", isPrimary: true }],
    yomi: {},
    ownerNames: ["三宅"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "熊澤酒造株式会社",
    hp: "https://kumazawa.jp/",
    apoDate: "2026-04-22",
    meetingDate: "2026-04-30",
    pipelineStage: "【商談前】商談予定",
    contacts: [{ email: "kumazawa.brewery@gmail.com", isPrimary: true }],
    yomi: {},
    ownerNames: ["三宅"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "水島ゴム工業用品株式会社",
    hp: "https://mizushimagomu.co.jp/",
    industry: "商社／建設・設計",
    apoDate: "2026-04-15",
    meetingDate: "2026-04-30",
    pipelineStage: "【商談前】商談予定",
    contacts: [
      { name: "管理部 渡邊様", email: "k.watanabe@mizushimagomu.co.jp", isPrimary: true },
    ],
    yomi: {},
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "株式会社ジェイマックシステム",
    hp: "https://www.j-mac.co.jp/",
    apoDate: "2026-04-24",
    meetingDate: "2026-04-24",
    nextActionDate: "2026-05-07",
    nextAction: "次回HP提案",
    pipelineStage: "【商談前】商談予定",
    contacts: [
      { name: "田中 和博", email: "ka.tanaka@j-mac.co.jp", isPrimary: true },
      { name: "清野 一樹", email: "ka.seino@j-mac.co.jp" },
      { name: "築山 富士雄", email: "fu.tsukiyama@j-mac.co.jp" },
    ],
    yomi: { 映像: "Cヨミ", HP: "Cヨミ" },
    ownerNames: ["三宅"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "ダイワサイクル株式会社",
    hp: "https://www.daiwa-cycle.co.jp/",
    industry: "サービス／製造／小売・流通",
    apoDate: "2026-04-03",
    meetingDate: "2026-04-23",
    nextActionDate: "2026-07-01",
    nextAction:
      "上野様が営業部で管掌範囲ではない、秋が予算策定時期なのでそれに向けて人事や広報につなげてもらえるよう、長い付き合いをしていく",
    pipelineStage: "【商談後】トスなし",
    contacts: [
      {
        name: "法人営業部部長 上野 和司",
        email: "ueno-k@daiwa-cycle.co.jp",
        phone: "080-3765-6959",
        isPrimary: true,
      },
    ],
    amount: 0,
    yomi: { 採用コンサル: "NG", 営業支援: "NG" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "株式会社三谷製作所",
    hp: "https://onomichi-mitani.co.jp/",
    industry: "製造",
    apoDate: "2026-04-06",
    meetingDate: "2026-04-22",
    pipelineStage: "【商談前】商談予定",
    contacts: [
      {
        name: "代表取締役社長 三谷 晋一郎",
        email: "mitani01@onomichi-mitani.co.jp",
        isPrimary: true,
      },
    ],
    ceoName: "三谷 晋一郎",
    amount: 0,
    yomi: {},
    ownerNames: ["三宅"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "株式会社セルート",
    hp: "https://www.saroute.co.jp/",
    industry: "小売・流通",
    apoDate: "2026-04-06",
    meetingDate: "2026-04-22",
    nextActionDate: "2026-05-05",
    nextAction:
      "一旦簡易資料を作成し、上長を含めたアポ打診。返信来なければGW明けに連絡",
    pipelineStage: "【商談後】企画中",
    contacts: [
      { name: "早乙女様", email: "pr@saroute.co.jp", phone: "03-5285-5017", isPrimary: true },
      { name: "今村様" },
    ],
    yomi: { 映像: "Cヨミ", SNS: "Cヨミ", HP: "Cヨミ", 採用コンサル: "Cヨミ" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "澤村株式会社",
    hp: "https://sawamura-net.co.jp/",
    industry: "商社",
    apoDate: "2026-04-06",
    meetingDate: "2026-04-20",
    pipelineStage: "【商談後】トスなし",
    contacts: [
      { name: "酒谷 典秀", email: "sakatani@sawamura-net.co.jp", isPrimary: true },
      { name: "奥野部長", email: "okuno@sawamura-net.co.jp" },
      { name: "突々次長", email: "totsutotsu-s@sawamura-net.co.jp" },
    ],
    amount: 0,
    yomi: { SNS: "NG", HP: "Cヨミ", 採用コンサル: "NG" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "株式会社日本ビジネスデータープロセシングセンター",
    apoDate: "2026-04-08",
    meetingDate: "2026-04-20",
    pipelineStage: "【商談前】商談予定",
    yomi: {},
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "日本経営グループ",
    hp: "https://nkgr.co.jp/",
    industry: "コンサル",
    apoDate: "2026-04-06",
    meetingDate: "2026-04-20",
    nextAction: "次回２回目の提案",
    pipelineStage: "【商談後】企画中",
    contacts: [
      {
        name: "山本 将司",
        email: "masashi.yamamoto@nkgr.co.jp",
        phone: "070-1482-3271",
        isPrimary: true,
      },
      { name: "鈴木 隆之", email: "takayuki.suzuki@nkgr.co.jp" },
      { name: "大塚 洋子", email: "yoko.otsuka@nkgr.co.jp" },
    ],
    yomi: { 採用コンサル: "Cヨミ" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "マクセル株式会社",
    hp: "https://www.maxell.co.jp/",
    industry: "製造",
    apoDate: "2026-04-06",
    meetingDate: "2026-04-17",
    pipelineStage: "【商談後】稟議中",
    contacts: [
      {
        name: "片峯 美由紀",
        email: "miyuki-katamine@maxell.co.jp",
        phone: "080-3017-7399",
        isPrimary: true,
      },
      { name: "岡田 千怜", email: "chisato.okada.yb@maxell.co.jp" },
    ],
    amount: 0,
    yomi: { 採用コンサル: "ネタ" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "井上リボン工業株式会社",
    hp: "https://www.telala.com/",
    industry: "製造",
    apoDate: "2026-04-07",
    meetingDate: "2026-04-13",
    nextActionDate: "2026-04-24",
    nextAction: "4/28 広報委員会があるのでそこでエスカレーション",
    pipelineStage: "【商談後】稟議中",
    contacts: [
      { name: "山本 紀理香", email: "yamamoto@telala.com", isPrimary: true },
      { email: "h-inoue@telala.com" },
      { email: "nakamura@telala.com" },
      { email: "makino@telala.com" },
      { email: "yosimoto@telala.com" },
    ],
    proposalUrl: "https://canva.link/2jybt6bu6zesano",
    yomi: { SNS: "Cヨミ" },
    ownerNames: ["三宅", "冨永"],
    leadSource: "Luma顧客企業",
  },
  {
    name: "g-wic",
    apoDate: "2026-04-09",
    meetingDate: "2026-04-09",
    contractDate: "2026-04-01",
    pipelineStage: "契約書チェック中",
    amount: 186000,
    yomi: { 営業支援: "受注" },
    ownerNames: ["冨永"],
    leadSource: "その他",
  },
  {
    name: "Allegro株式会社",
    apoDate: "2026-04-09",
    meetingDate: "2026-04-09",
    contractDate: "2026-04-01",
    pipelineStage: "契約書送付中（返送待ち）",
    amount: 3600000,
    yomi: { 営業支援: "受注" },
    ownerNames: ["冨永"],
    leadSource: "その他",
  },
  {
    name: "オオヨドコーポレーション",
    hp: "https://oyodo-co.jp/",
    industry: "建設・設計／サービス",
    apoDate: "2026-01-13",
    meetingDate: "2026-01-21",
    nextActionDate: "2026-04-20",
    nextAction:
      "4/12までに映像のコンテを送付・HPデザインを20日までに検討いただく",
    pipelineStage: "【商談後】稟議中",
    contacts: [
      {
        name: "淀 祐一郎",
        email: "y.yodo@oyodo-co.jp",
        phone: "080-7843-5561",
        isPrimary: true,
      },
    ],
    proposalUrl: "https://canva.link/t6k5r97yuujswry",
    amount: 3050000,
    yomi: { 映像: "Aヨミ", HP: "Aヨミ" },
    ownerNames: ["三宅"],
    leadSource: "その他",
  },
];

// ============================================================
// ヨミ → 受注確度＋ステータス
// ============================================================
function yomiToProbability(y: Yomi): number {
  switch (y) {
    case "受注":
      return 100;
    case "Aヨミ":
      return 80;
    case "Bヨミ":
      return 60;
    case "Cヨミ":
      return 40;
    case "ネタ":
      return 20;
    case "NG":
      return 0;
  }
}
function yomiToDealStatus(y: Yomi): DealStatus {
  if (y === "受注") return DealStatus.WON;
  if (y === "NG") return DealStatus.LOST;
  if (y === "Aヨミ") return DealStatus.NEGOTIATION;
  if (y === "Bヨミ") return DealStatus.PROPOSAL;
  if (y === "Cヨミ") return DealStatus.PROPOSAL;
  if (y === "ネタ") return DealStatus.LEAD;
  return DealStatus.LEAD;
}

// 商材ヨミキー → Productマスタ名／プラン名
function yomiKeyToProductPlan(key: YomiKey): { productName: string; planName?: string } {
  switch (key) {
    case "映像":
      return { productName: "映像", planName: "採用動画" };
    case "SNS":
      return { productName: "SNS", planName: "会社ブランディング向け運用" };
    case "HP":
      return { productName: "HP制作", planName: "会社HP制作" };
    case "採用コンサル":
      return { productName: "採用コンサル", planName: "スタンダード" };
    case "営業支援":
      return { productName: "営業支援", planName: "スタンダード" };
    case "Re;easy HR":
      return { productName: "Re;easy HR" };
  }
}

async function main() {
  console.log("[seed-reagey] start");
  console.log(`[seed-reagey] DB: ${connectionString}`);

  // ============================================================
  // ユーザー
  // ============================================================
  const passwordHash = await bcrypt.hash("reagey2026", 10);
  const userByName = new Map<string, string>(); // 名前(姓のみ) → userId
  const userByEmail = new Map<string, { id: string; name: string }>();

  for (const u of USERS) {
    const created = await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        role: u.role,
        permission: u.permission,
        avatarColor: u.avatarColor,
        passwordHash, // 既存ユーザーのパスワードも初期パスワードに揃える（リージー初期投入時のみ）
      },
      create: {
        email: u.email,
        passwordHash,
        name: u.name,
        role: u.role,
        permission: u.permission,
        avatarColor: u.avatarColor,
      },
    });
    userByEmail.set(u.email, { id: created.id, name: created.name });
    // 「三宅」「冨永」キーで引けるように姓のみマッピング
    const surname = u.name.split(/\s+/)[0];
    userByName.set(surname, created.id);
    console.log(`  [user] ${u.name} <${u.email}> permission=${u.permission}`);
  }

  // ============================================================
  // 商材マスタ
  // ============================================================
  for (const p of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { tenantId_name: { tenantId: REAGEY_TENANT_ID, name: p.name } },
      update: {
        category: p.category,
        description: p.description ?? null,
      },
      create: {
        name: p.name,
        category: p.category,
        description: p.description ?? null,
        active: true,
      },
    });
    // プランは ProductPlan に upsert（productId+name でユニーク）
    for (let i = 0; i < p.planNames.length; i++) {
      const planName = p.planNames[i];
      await prisma.productPlan.upsert({
        where: { productId_name: { productId: product.id, name: planName } },
        update: { sortOrder: i },
        create: {
          productId: product.id,
          name: planName,
          sortOrder: i,
          active: true,
        },
      });
    }
    console.log(`  [product] ${p.name} (${p.category}) plans=[${p.planNames.join(", ")}]`);
  }

  // ============================================================
  // リード獲得経由マスタ
  // ============================================================
  const leadSourceByName = new Map<string, string>(); // name → id
  for (const ls of DEFAULT_LEAD_SOURCES) {
    const created = await prisma.leadSource.upsert({
      where: { tenantId_name: { tenantId: REAGEY_TENANT_ID, name: ls.name } },
      update: { sortOrder: ls.sortOrder },
      create: { name: ls.name, sortOrder: ls.sortOrder, active: true },
    });
    leadSourceByName.set(ls.name, created.id);
    console.log(`  [leadSource] ${ls.name} (sortOrder=${ls.sortOrder})`);
  }

  // ============================================================
  // 顧客企業＋連絡先＋商談
  // ============================================================
  let companyCount = 0;
  let contactCount = 0;
  let dealCount = 0;
  const dealBreakdown: Record<string, number> = {}; // "Product/Yomi" → count

  for (const c of COMPANIES) {
    // 企業：name で重複防止（既存があれば update）
    // Company は Luma / リージー 共有の企業マスタなので tenant では絞らない
    const existingCompany = await prisma.company.findFirst({ where: { name: c.name } });
    const company = existingCompany
      ? await prisma.company.update({
          where: { id: existingCompany.id },
          data: {
            websiteUrl: c.hp ?? existingCompany.websiteUrl,
            industry: c.industry ?? existingCompany.industry,
            ceoName: c.ceoName ?? existingCompany.ceoName,
            phoneNumber: c.phone ?? existingCompany.phoneNumber,
          },
        })
      : await prisma.company.create({
          data: {
            name: c.name,
            websiteUrl: c.hp,
            industry: c.industry,
            ceoName: c.ceoName,
            phoneNumber: c.phone,
          },
        });
    if (!existingCompany) companyCount++;

    // 連絡先
    if (c.contacts) {
      for (const ct of c.contacts) {
        const dupKey = ct.email ?? ct.name ?? "";
        if (!dupKey) continue;
        const existing = await prisma.contact.findFirst({
          where: {
            companyId: company.id,
            OR: [
              ct.email ? { email: ct.email } : { id: "__none__" },
              ct.name ? { name: ct.name } : { id: "__none__" },
            ],
          },
        });
        if (existing) continue;
        await prisma.contact.create({
          data: {
            companyId: company.id,
            name: ct.name ?? ct.email ?? "（不明）",
            email: ct.email,
            phone: ct.phone,
            isPrimary: ct.isPrimary ?? false,
          },
        });
        contactCount++;
      }
    }

    // 担当者ID解決（最初の1名のみ Deal.ownerUserId に）
    const ownerId =
      c.ownerNames
        .map((n) => userByName.get(n))
        .find((id) => !!id) ?? null;

    // 商談：1 Company = 1 Deal、ヨミがある事業ごとに DealProduct を作成
    const yomiEntries = Object.entries(c.yomi) as [YomiKey, Yomi][];
    const leadSourceId = c.leadSource ? leadSourceByName.get(c.leadSource) ?? null : null;
    const appointmentDate = c.apoDate ? new Date(`${c.apoDate}T00:00:00+09:00`) : null;

    if (yomiEntries.length > 0) {
      // 既存Dealがあれば再利用、なければ新規
      let deal = await prisma.deal.findFirst({
        where: { companyId: company.id, deletedAt: null },
      });
      if (!deal) {
        // 全yomiEntryから最高ステータスを使う
        const statusList = yomiEntries.map(([, y]) => yomiToDealStatus(y));
        const STATUS_RANK: DealStatus[] = [
          DealStatus.LEAD,
          DealStatus.HEARING,
          DealStatus.PROPOSAL,
          DealStatus.NEGOTIATION,
          DealStatus.CLOSING,
          DealStatus.WON,
          DealStatus.LOST,
        ];
        const status = statusList.sort(
          (a, b) => STATUS_RANK.indexOf(b) - STATUS_RANK.indexOf(a),
        )[0];
        // 新タイトル形式：「アポ獲得日 + 顧客名 + 担当者名」
        // 既存タイトルは触らない方針だが、新規シードはこの形式で作成
        const ownerName = ownerId
          ? [...userByName.entries()].find(([, id]) => id === ownerId)?.[0]
          : null;
        const fullOwnerName = ownerId
          ? [...userByEmail.values()].find((u) => u.id === ownerId)?.name
          : null;
        const titleOwner = fullOwnerName ?? ownerName ?? "";
        const titleDate = c.apoDate ? c.apoDate.replaceAll("-", "/") : "";
        const title = [titleDate, c.name, titleOwner].filter(Boolean).join(" ") || `${c.name}様向け 提案`;
        deal = await prisma.deal.create({
          data: {
            companyId: company.id,
            title,
            status,
            pipelineStage: c.pipelineStage,
            ownerUserId: ownerId,
            leadSourceId,
            appointmentDate,
            nextAction: c.nextAction ?? null,
            nextActionAt: c.nextActionDate ? new Date(`${c.nextActionDate}T00:00:00+09:00`) : null,
            // contractDate = KPI実績の集計基準（受注フェーズになった日）
            // 元データ「契約日」をここに格納する。expectedCloseDate(着地予定日) は別概念のため未設定。
            contractDate: c.contractDate
              ? new Date(`${c.contractDate}T00:00:00+09:00`)
              : null,
          },
        });
        dealCount++;
      } else {
        // 既存Dealには leadSource と appointmentDate のバックフィルだけ実施
        await prisma.deal.update({
          where: { id: deal.id },
          data: {
            leadSourceId: deal.leadSourceId ?? leadSourceId,
            appointmentDate: deal.appointmentDate ?? appointmentDate,
          },
        });
      }

      for (const [yomiKey, yomi] of yomiEntries) {
        const { productName, planName } = yomiKeyToProductPlan(yomiKey);
        // 既存DealProductチェック（同 deal × productName）
        const existingDp = await prisma.dealProduct.findFirst({
          where: { dealId: deal.id, productName },
        });
        if (existingDp) continue;
        const probability = yomiToProbability(yomi);
        const amount = c.amount && c.amount > 0 ? c.amount : null;
        // Productマスタを名寄せ
        const productMaster = await prisma.product.findUnique({ where: { tenantId_name: { tenantId: REAGEY_TENANT_ID, name: productName } } });
        await prisma.dealProduct.create({
          data: {
            dealId: deal.id,
            productId: productMaster?.id ?? null,
            productName,
            planName,
            probability,
            amount,
            yomiStatus: yomi,
            ownerUserId: ownerId,
          },
        });
        const key = `${productName}/${yomi}`;
        dealBreakdown[key] = (dealBreakdown[key] ?? 0) + 1;
      }
    }

    // ヨミが空（商談前ベース）の企業はDeal作成スキップだが、商談済みのデータ（meetingDate あり）は
    // 「ヒアリング段階の見込み案件」として最低1件は作っておくと運用が楽。
    // 今回は要件通り「ヨミが空ならDeal作らない」で統一。
  }

  console.log("");
  console.log(`[seed-reagey] done`);
  console.log(`  Users:     ${USERS.length}`);
  console.log(`  Products:  ${PRODUCTS.length}`);
  console.log(`  Companies: ${companyCount} new (total ${COMPANIES.length})`);
  console.log(`  Contacts:  ${contactCount} new`);
  console.log(`  Deals:     ${dealCount} new`);
  console.log(`  Breakdown:`);
  for (const [k, v] of Object.entries(dealBreakdown).sort()) {
    console.log(`    ${k}: ${v}`);
  }
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
