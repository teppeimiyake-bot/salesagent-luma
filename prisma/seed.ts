import { PrismaClient, DealStatus, TaskStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  console.log("[seed] start");

  // ============================================================
  // ユーザー（自社の営業メンバー）
  // ============================================================
  const passwordHash = await bcrypt.hash("demo1234", 10);
  const demo = await prisma.user.upsert({
    where: { email: "demo@salesagent.local" },
    update: { permission: "admin" },
    create: {
      email: "demo@salesagent.local",
      passwordHash,
      name: "宮武 哲平",
      role: "manager",
      permission: "admin",
      avatarColor: "#6366f1",
    },
  });
  const tanaka = await prisma.user.upsert({
    where: { email: "tanaka@salesagent.local" },
    update: { permission: "user" },
    create: {
      email: "tanaka@salesagent.local",
      passwordHash,
      name: "田中 健太",
      role: "sales",
      permission: "user",
      avatarColor: "#10b981",
    },
  });
  const sato = await prisma.user.upsert({
    where: { email: "sato@salesagent.local" },
    update: { permission: "user" },
    create: {
      email: "sato@salesagent.local",
      passwordHash,
      name: "佐藤 美咲",
      role: "sales",
      permission: "user",
      avatarColor: "#f59e0b",
    },
  });
  const suzuki = await prisma.user.upsert({
    where: { email: "suzuki@salesagent.local" },
    update: { permission: "user" },
    create: {
      email: "suzuki@salesagent.local",
      passwordHash,
      name: "鈴木 翔太",
      role: "sales",
      permission: "user",
      avatarColor: "#ec4899",
    },
  });
  // 閲覧のみユーザー（デモ用）
  await prisma.user.upsert({
    where: { email: "viewer@salesagent.local" },
    update: { permission: "viewer" },
    create: {
      email: "viewer@salesagent.local",
      passwordHash,
      name: "閲覧 太郎",
      role: "sales",
      permission: "viewer",
      avatarColor: "#64748b",
    },
  });

  // ============================================================
  // プロダクトマスタ
  // ============================================================
  await prisma.product.deleteMany();
  const products = [
    {
      name: "工場IoTダッシュボード",
      category: "製造業",
      description: "設備稼働率の可視化、ダウンタイム削減",
      planNames: ["Standard（1工場）", "Enterprise（5工場）", "PoC（1ライン）"],
      basePrice: 8_000_000,
    },
    {
      name: "MES連携 拡張モジュール",
      category: "製造業",
      description: "MES（製造実行システム）との API 連携",
      planNames: ["Add-on", "Enterprise Add-on"],
      basePrice: 4_000_000,
    },
    {
      name: "CRM刷新パッケージ",
      category: "営業組織",
      description: "Salesforce/HubSpot からの移行＋AI支援",
      planNames: ["Standard", "Enterprise + 移行支援"],
      basePrice: 18_000_000,
    },
    {
      name: "営業AI支援パッケージ",
      category: "営業組織",
      description: "AIエージェントによる営業活動の自動化",
      planNames: ["PoC", "Standard", "Enterprise"],
      basePrice: 6_000_000,
    },
    {
      name: "配車最適化AI",
      category: "物流",
      description: "AIによる配送ルート最適化",
      planNames: ["Standard", "Enterprise"],
      basePrice: 30_000_000,
    },
    {
      name: "編集ワークフローSaaS",
      category: "メディア",
      description: "編集チームの進捗・原稿管理",
      planNames: ["Lite", "Standard", "Enterprise"],
      basePrice: 2_500_000,
    },
    {
      name: "音声記録AI",
      category: "医療・専門サービス",
      description: "対面の音声を自動構造化",
      planNames: ["Standard", "Enterprise"],
      basePrice: 6_500_000,
    },
  ];
  for (const p of products) await prisma.product.create({ data: p });

  // クリア
  await prisma.aiLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.meeting.deleteMany();
  await prisma.roleplaySession.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.company.deleteMany();
  await prisma.document.deleteMany();
  await prisma.goal.deleteMany();
  await prisma.chatMessage.deleteMany();

  // ============================================================
  // 全社共通ドキュメント
  // ============================================================
  const docs = [
    { name: "標準提案書テンプレート v3.2", category: "proposal", description: "業界共通版／Aパターン" },
    { name: "業務委託契約書 ひな形", category: "contract", description: "リーガル承認済 2026-04" },
    { name: "秘密保持契約書 NDA", category: "contract", description: "双方向／3年" },
    { name: "ROI 試算シート", category: "template", description: "Excel / 入力で自動算出" },
    { name: "導入事例：製造業A社（生産性40%改善）", category: "case_study", description: "PDF / 業界別営業ツール" },
    { name: "導入事例：金融B社（CRM刷新で受注率2倍）", category: "case_study", description: "PDF" },
  ];
  const docTags: Record<string, string[]> = {
    "標準提案書テンプレート v3.2": ["proposal", "general"],
    "業務委託契約書 ひな形": ["contract"],
    "秘密保持契約書 NDA": ["contract", "nda"],
    "ROI 試算シート": ["roi", "template"],
    "導入事例：製造業A社（生産性40%改善）": ["製造業", "生産性", "IoT", "ダウンタイム"],
    "導入事例：金融B社（CRM刷新で受注率2倍）": ["金融", "CRM", "受注率", "営業組織"],
  };
  for (const d of docs) {
    await prisma.document.create({
      data: {
        name: d.name,
        category: d.category,
        scope: "global",
        description: d.description,
        fileUrl: `/documents/${encodeURIComponent(d.name)}.pdf`,
        mimeType: "application/pdf",
        uploadedById: demo.id,
        tags: docTags[d.name] ?? [],
      },
    });
  }
  // 顧客事例カテゴリの追加事例
  const caseStudies = [
    {
      name: "導入事例：物流C社（配送ルート最適化で15%コスト削減）",
      description: "全国90拠点／配車最適化／3PL",
      tags: ["物流", "配車最適化", "コスト削減", "3PL"],
    },
    {
      name: "導入事例：医療D社（音声記録で診療時間30%短縮）",
      description: "クリニックチェーン／臨床現場／音声AI",
      tags: ["医療", "音声AI", "診療効率", "クリニック"],
    },
    {
      name: "導入事例：IT-E社（営業AI支援で商談数2倍）",
      description: "中堅SIer／営業60名／AI伴走",
      tags: ["IT", "SIer", "営業AI", "商談増加"],
    },
  ];
  for (const cs of caseStudies) {
    await prisma.document.create({
      data: {
        name: cs.name,
        category: "case_study",
        scope: "global",
        description: cs.description,
        fileUrl: `/documents/${encodeURIComponent(cs.name)}.pdf`,
        mimeType: "application/pdf",
        uploadedById: demo.id,
        tags: cs.tags,
      },
    });
  }

  // ============================================================
  // 受注目標（年間KGI / 四半期KPI / 月次KPI の3階層）
  // ============================================================
  const YEAR = 2026;

  // 年間KGI
  await prisma.goal.create({ data: { period: `${YEAR}`, targetAmount: 320_000_000 } }); // 組織
  await prisma.goal.create({ data: { period: `${YEAR}`, targetAmount: 120_000_000, ownerUserId: tanaka.id } });
  await prisma.goal.create({ data: { period: `${YEAR}`, targetAmount: 100_000_000, ownerUserId: sato.id } });
  await prisma.goal.create({ data: { period: `${YEAR}`, targetAmount: 100_000_000, ownerUserId: suzuki.id } });
  await prisma.goal.create({ data: { period: `${YEAR}`, targetAmount: 80_000_000, ownerUserId: demo.id } });

  // 四半期KPI（Q1〜Q4 各 80,000,000 を組織目標、個人はざっくり按分）
  const quarterOrg = [70_000_000, 80_000_000, 85_000_000, 85_000_000];
  for (let q = 1; q <= 4; q++) {
    const period = `${YEAR}-Q${q}`;
    await prisma.goal.create({ data: { period, targetAmount: quarterOrg[q - 1] } });
    await prisma.goal.create({ data: { period, targetAmount: 30_000_000, ownerUserId: tanaka.id } });
    await prisma.goal.create({ data: { period, targetAmount: 25_000_000, ownerUserId: sato.id } });
    await prisma.goal.create({ data: { period, targetAmount: 25_000_000, ownerUserId: suzuki.id } });
    await prisma.goal.create({ data: { period, targetAmount: 20_000_000, ownerUserId: demo.id } });
  }

  // 月次KPI（12ヶ月。組織は月平均 約27M、個人は約8〜10M）
  const monthOrgTargets = [
    20_000_000, 25_000_000, 25_000_000, // Q1: 1-3月（年初は低め）
    25_000_000, 28_000_000, 27_000_000, // Q2: 4-6月
    27_000_000, 30_000_000, 28_000_000, // Q3: 7-9月
    28_000_000, 30_000_000, 27_000_000, // Q4: 10-12月
  ];
  for (let m = 1; m <= 12; m++) {
    const period = `${YEAR}-${String(m).padStart(2, "0")}`;
    await prisma.goal.create({ data: { period, targetAmount: monthOrgTargets[m - 1] } });
    // 個人月次は控えめに
    await prisma.goal.create({ data: { period, targetAmount: 10_000_000, ownerUserId: tanaka.id } });
    await prisma.goal.create({ data: { period, targetAmount: 8_000_000, ownerUserId: sato.id } });
    await prisma.goal.create({ data: { period, targetAmount: 8_000_000, ownerUserId: suzuki.id } });
    await prisma.goal.create({ data: { period, targetAmount: 7_000_000, ownerUserId: demo.id } });
  }

  // ============================================================
  // 顧客企業 + 連絡先 + 商談（プロダクト別に複数）
  // ============================================================
  const today = new Date();
  const addDays = (d: number) => new Date(today.getTime() + d * 86400 * 1000);

  const seedData = [
    {
      company: {
        name: "株式会社サクラ製作所",
        industry: "製造業（精密射出成型）",
        websiteUrl: "https://sakura-mfg.example.co.jp",
        websiteSummary:
          "栃木拠点の精密射出成型メーカー（従業員約320名）。自動車部品・医療機器筐体を主軸。2026年3月期は売上98億円、前年比+12%。スマートファクトリー化と歩留まり改善を経営目標に掲げ、IoT投資に積極姿勢。",
        address: "栃木県宇都宮市清原工業団地7-3",
        ceoName: "桜井 高志",
        establishedYear: 1987,
        employeeCount: 318,
        capital: "9,800万円",
        phoneNumber: "028-555-0100",
        logoColor: "#dc2626",
      },
      contacts: [
        { name: "山田 一郎", role: "DX推進部 部長", email: "yamada@sakura-mfg.example", phone: "028-555-0101", isPrimary: true },
        { name: "岡崎 真理", role: "製造本部長", email: "okazaki@sakura-mfg.example", phone: "028-555-0102", isDecisionMaker: true },
      ],
      deals: [
        {
          productName: "工場IoTダッシュボード",
          planName: "Enterprise（5工場）",
          title: "第3工場の射出成型機可視化",
          status: DealStatus.PROPOSAL,
          probability: 65,
          amount: 12_400_000,
          ownerUserId: tanaka.id,
          nextActionAt: addDays(2),
          nextAction: "決裁者面談の調整",
          expectedCloseDate: addDays(35),
          tasks: [
            { title: "決裁者面談の日程調整メールを送付", priority: "high", impact: "high", isAi: true, reason: "BANTのAuthorityが未確定。来週の提案前に必須。", dueInDays: 0 },
            { title: "ROIシート v2 を作成（人件費換算で再提示）", priority: "medium", impact: "high", isAi: true, reason: "前回MTGで価格交渉あり。ROI起点で握り直す。", dueInDays: 2 },
          ],
          minutes: `# 商談要約（2026-04-25 第2回MTG）
## 出席者
- 顧客側: 山田部長（DX推進）／ 岡崎本部長（不在・決裁者）
- 当社: 田中

## 議論ポイント
- 第3工場の射出成型機ダウンタイムが月20h超 → 半減で年数千万円のインパクト
- 半期内立ち上げ希望／決裁は岡崎本部長
- A社が並行提案中（価格軸）

## 決定事項
- 本部長向けROI 1枚の作成（当社が作成）
- 次回は本部長同席で15分セット予定

## 宿題
- 本部長日程の確認 → 山田氏が今週返答`,
        },
        {
          productName: "MES連携 拡張モジュール",
          planName: "Add-on",
          title: "MESとのAPI連携拡張",
          status: DealStatus.HEARING,
          probability: 30,
          amount: 4_800_000,
          ownerUserId: tanaka.id,
          nextActionAt: addDays(7),
          nextAction: "PoC範囲のすり合わせ",
          expectedCloseDate: addDays(60),
          tasks: [],
          minutes: "ヒアリング初回。既存MES（Andon）との接続要件を整理中。",
        },
      ],
    },
    {
      company: {
        name: "Nexus Holdings",
        industry: "金融（ノンバンク）",
        websiteUrl: "https://nexus-hd.example.com",
        websiteSummary:
          "ノンバンク中堅。営業組織は約200名、CRMはSalesforceを長年運用するもカスタマイズ重荷で刷新検討中。2026年度はDX投資2倍。",
        address: "東京都千代田区大手町1-9-2",
        ceoName: "近藤 隆志",
        establishedYear: 2003,
        employeeCount: 412,
        capital: "5億円",
        phoneNumber: "03-5555-0200",
        logoColor: "#0ea5e9",
      },
      contacts: [
        { name: "近藤 涼介", role: "営業本部 副本部長", email: "kondo@nexus-hd.example", phone: "03-5555-0201", isPrimary: true, isDecisionMaker: true },
      ],
      deals: [
        {
          productName: "CRM刷新パッケージ",
          planName: "Enterprise + 移行支援",
          title: "営業組織のCRM刷新",
          status: DealStatus.NEGOTIATION,
          probability: 71,
          amount: 28_000_000,
          ownerUserId: sato.id,
          nextActionAt: addDays(0),
          nextAction: "見積書の再送付",
          expectedCloseDate: addDays(14),
          tasks: [
            { title: "修正版見積書を本日17:00までに送付", priority: "high", impact: "high", isAi: true, reason: "レスポンス遅延でリスク上昇。", dueInDays: 0 },
          ],
          minutes: "価格交渉フェーズ。決裁者のコミット獲得済み。残課題は契約条件のすり合わせ。",
        },
      ],
    },
    {
      company: {
        name: "藍染テクノロジー",
        industry: "IT（SIer）",
        websiteUrl: "https://aizome-tech.example.jp",
        websiteSummary: "中堅SIer。営業60名。社内ナレッジ共有とAI活用に強い関心。",
        address: "東京都渋谷区桜丘町14-10",
        ceoName: "緒方 新一",
        establishedYear: 2011,
        employeeCount: 87,
        capital: "3,000万円",
        phoneNumber: "03-5555-0300",
        logoColor: "#6366f1",
      },
      contacts: [
        { name: "緒方 結衣", role: "事業企画", email: "ogata@aizome-tech.example", phone: "03-5555-0301", isPrimary: true },
      ],
      deals: [
        {
          productName: "営業AI支援パッケージ",
          planName: "PoC",
          title: "営業AI支援PoC",
          status: DealStatus.HEARING,
          probability: 40,
          amount: 8_200_000,
          ownerUserId: suzuki.id,
          nextActionAt: addDays(1),
          nextAction: "導入事例資料の共有",
          expectedCloseDate: addDays(75),
          tasks: [
            { title: "競合と比較した3軸の導入事例を明日までに共有", priority: "medium", impact: "medium", isAi: true, reason: "競合比較フェーズ。自社の土俵に再設定する。", dueInDays: 1 },
          ],
          minutes: "PoC前のヒアリング。本提案前に事例での比較が必要。",
        },
      ],
    },
    {
      company: {
        name: "Meridian Logistics",
        industry: "物流（3PL）",
        websiteUrl: "https://meridian-logi.example.com",
        websiteSummary: "全国90拠点の物流企業。配送ルート最適化と人手不足対応がテーマ。",
        address: "大阪府大阪市港区築港3-2-1",
        ceoName: "西原 雅彦",
        establishedYear: 1972,
        employeeCount: 1240,
        capital: "12億円",
        phoneNumber: "06-5555-0400",
        logoColor: "#0d9488",
      },
      contacts: [
        { name: "西原 健", role: "経営企画 部長", email: "nishihara@meridian-logi.example", phone: "06-5555-0401", isPrimary: true, isDecisionMaker: true },
        { name: "木村 友香", role: "現場オペレーション統括", email: "kimura@meridian-logi.example", isPrimary: false },
      ],
      deals: [
        {
          productName: "配車最適化AI",
          planName: "Enterprise",
          title: "全国拠点への一斉導入",
          status: DealStatus.CLOSING,
          probability: 88,
          amount: 45_000_000,
          ownerUserId: tanaka.id,
          nextActionAt: addDays(1),
          nextAction: "契約書のレビュー",
          expectedCloseDate: addDays(7),
          tasks: [
            { title: "契約書ドラフトを法務に回し、48時間以内に先方へ返送", priority: "high", impact: "high", isAi: false, reason: "クロージング段階。スピードが受注確度を決める。", dueInDays: 1 },
          ],
          minutes: "クロージング段階。契約条件もほぼ合意。最終法務確認待ち。",
        },
      ],
    },
    {
      company: {
        name: "緑風出版株式会社",
        industry: "メディア（出版）",
        websiteUrl: "https://ryokufu-pub.example.jp",
        websiteSummary: "実用書中心の中堅出版社。編集ワークフロー刷新を検討。",
        address: "東京都新宿区神楽坂6-12",
        ceoName: "高橋 信一",
        establishedYear: 1958,
        employeeCount: 64,
        capital: "5,000万円",
        phoneNumber: "03-5555-0500",
        logoColor: "#16a34a",
      },
      contacts: [
        { name: "高橋 直人", role: "編集統括", email: "takahashi@ryokufu-pub.example", isPrimary: true },
      ],
      deals: [
        {
          productName: "編集ワークフローSaaS",
          planName: "Standard",
          title: "編集ワークフロー刷新",
          status: DealStatus.LEAD,
          probability: 25,
          amount: 3_600_000,
          ownerUserId: demo.id,
          nextActionAt: addDays(5),
          nextAction: "初回MTG設定",
          expectedCloseDate: addDays(120),
          tasks: [],
          minutes: "問い合わせ受領。初回ヒアリング前。",
        },
      ],
    },
    {
      company: {
        name: "蒼天ヘルスケア",
        industry: "医療（クリニックチェーン）",
        websiteUrl: "https://souten-hc.example.com",
        websiteSummary: "クリニックチェーン。臨床現場の音声記録AIを試験導入し、本格契約済。",
        address: "福岡県福岡市博多区博多駅前2-1-1",
        ceoName: "大谷 麻衣",
        establishedYear: 2014,
        employeeCount: 156,
        capital: "8,000万円",
        phoneNumber: "092-555-0600",
        logoColor: "#a21caf",
      },
      contacts: [
        { name: "大谷 麻衣", role: "理事長", email: "otani@souten-hc.example", isPrimary: true, isDecisionMaker: true },
      ],
      deals: [
        {
          productName: "音声記録AI",
          planName: "Enterprise",
          title: "臨床音声記録AI 本契約",
          status: DealStatus.WON,
          probability: 100,
          amount: 9_800_000,
          ownerUserId: sato.id,
          nextActionAt: addDays(7),
          nextAction: "キックオフMTG",
          expectedCloseDate: addDays(-30),
          tasks: [],
          minutes: "受注済。キックオフMTG準備中。",
        },
      ],
    },
  ];

  // 案件タイトル → BANT集約サマリ（デモ用）
  const bantByTitle: Record<
    string,
    {
      budget: string;
      authority: string;
      need: string;
      timeline: string;
      summary: string;
      confidence: number;
    }
  > = {
    "第3工場の射出成型機可視化": {
      budget:
        "Enterprise（5工場）想定で 12.4M / 年。製造部長予算枠から執行。第3工場PoC枠として2026年期内に確保済。",
      authority:
        "推進＝山田部長（DX推進）／決裁＝岡崎本部長（製造本部長・本部長同席MTG調整中）。社長承認は1.5億超のみ。",
      need:
        "射出成型機ダウンタイム 月20h超 → 半減で年数千万円インパクト。第3工場の歩留まり改善が経営目標KPIに直結。",
      timeline:
        "2026-Q3 半期内 立ち上げ希望。本部長判断は5月中、契約は6月、稼働開始は7月想定。",
      summary:
        "BANTはB/N/T揃い、A（決裁者面談）が最後の鍵。A社並行提案中のため本部長同席ROI 1枚で握り直す必要あり。次は本部長日程の確定と価格根拠の再提示。",
      confidence: 72,
    },
    "営業組織のCRM刷新": {
      budget:
        "Enterprise + 移行支援で 28M。2026年度DX投資2倍枠から執行。価格交渉中（−10%要望あり）。",
      authority:
        "決裁者＝近藤副本部長本人。コミット獲得済。社長承認は3,000万以下不要。",
      need:
        "Salesforce長年運用でカスタマイズが重荷。AI連携と乗り換え一体運用が必須要件。",
      timeline:
        "2026-Q2 内に契約。導入は7月から3ヶ月。",
      summary:
        "BANT全項目クリア、価格条件のすり合わせのみ。修正版見積を本日中に送付して締めに向かう。",
      confidence: 92,
    },
    "営業AI支援PoC": {
      budget:
        "PoC 8.2M。事業企画予算で執行可。本契約はEnterprise想定（30M〜）で別枠。",
      authority:
        "推進＝緒方氏（事業企画）／決裁＝緒方社長（同姓・同会社）。本契約時は社長承認必須。",
      need:
        "営業60名のナレッジ共有とAI活用検討中。競合と並列比較中で意思決定根拠が未確定。",
      timeline:
        "PoC契約は2026-Q3 開始希望。本契約判断は2027-Q1。",
      summary:
        "競合並走中、自社差別化軸（AI伴走の質）を導入事例で具体化が必要。次は事例3件の比較資料を明日送付。",
      confidence: 48,
    },
    "全国拠点への一斉導入": {
      budget:
        "Enterprise 45M。物流DX投資枠から執行決定済。2026年度予算確定。",
      authority:
        "決裁＝西原健 経営企画部長（決裁者）／推進＝木村 現場統括。社長承認も済。",
      need:
        "全国90拠点 配車最適化と人手不足対応。15%コスト削減を経営計画に織り込み済。",
      timeline:
        "2026-Q2 中に契約。導入は5月から3ヶ月で全拠点展開。",
      summary:
        "クロージング段階。BANT全項目クリア。法務最終確認のみで48時間以内に契約可能。",
      confidence: 95,
    },
    "編集ワークフロー刷新": {
      budget:
        "Standard 想定 3.6M。編集部予算で執行可。ただし2026-Q4以降の予算枠で検討中。",
      authority:
        "推進＝高橋編集統括／決裁＝高橋社長（同姓・同会社）。意思決定はトップダウン。",
      need:
        "編集進捗・原稿管理が属人化。月刊・季刊5誌の進行が遅延。具体KPI未設定。",
      timeline:
        "意思決定は2026-Q3 想定。導入は2026-Q4 〜 2027-Q1。",
      summary:
        "リード段階。初回ヒアリングMTGでN（必要性）の具体化と、KPI設定を取りに行く必要あり。",
      confidence: 25,
    },
    "MESとのAPI連携拡張": {
      budget: "Add-on 4.8M。第3工場案件のオプション扱い。",
      authority: "山田部長判断。岡崎本部長承認は親案件成立後にまとめて。",
      need: "既存MES（Andon）との接続要件を整理中。具体仕様は未確定。",
      timeline: "親案件（第3工場）契約後の追加発注想定。2026-Q3。",
      summary:
        "親案件の成立に紐づく。先に第3工場案件をクロージング、その後にPoCスコープを握る順序。",
      confidence: 40,
    },
    "臨床音声記録AI 本契約": {
      budget: "Enterprise 9.8M で確定。",
      authority: "理事長 大谷氏 決裁済。",
      need: "クリニック診療効率化（30%短縮実証済）。継続契約。",
      timeline: "2026-04 契約済。キックオフMTG準備中。",
      summary: "受注済。BANT情報は契約条件として確定。次フェーズはオンボーディング。",
      confidence: 100,
    },
  };

  for (const sd of seedData) {
    const company = await prisma.company.create({ data: sd.company });
    for (const c of sd.contacts) {
      await prisma.contact.create({ data: { ...c, companyId: company.id } });
    }
    for (const d of sd.deals) {
      const { tasks, minutes, ...dealData } = d;
      const bant = bantByTitle[dealData.title];
      const deal = await prisma.deal.create({
        data: {
          ...dealData,
          companyId: company.id,
          ...(bant ? { bant, bantUpdatedAt: addDays(-1) } : {}),
        },
      });
      if (minutes) {
        await prisma.meeting.create({
          data: { dealId: deal.id, minutes, meetingDate: addDays(-2) },
        });
      }
      for (const t of tasks) {
        await prisma.task.create({
          data: {
            dealId: deal.id,
            title: t.title,
            priority: t.priority,
            impact: t.impact,
            status: TaskStatus.OPEN,
            isAiGenerated: t.isAi,
            reason: t.reason,
            dueDate: addDays(t.dueInDays),
          },
        });
      }
    }
  }

  console.log("[seed] done");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
