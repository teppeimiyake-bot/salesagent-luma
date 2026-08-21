/**
 * Notion「Luma PM-dev / マスタ」→ ProductionProject 同期。
 *
 *   dry-run: npx tsx prisma/scripts/sync-pm-from-notion.ts
 *   反映   : npx tsx prisma/scripts/sync-pm-from-notion.ts --apply
 *
 * 背景：受注（PMタブ）の案件が全件 BEFORE_SHOOT・担当者/日付すべて空のまま
 * 商談から自動生成されていたため、Notion の実データで上書きする。
 *
 * NOTION_ROWS は Notion MCP（query_data_sources）で取得した内容をハードコードしている。
 * tsx から MCP は呼べないため、Notion 側が更新されたらここを貼り替えて再実行すること。
 * データソース: collection://da447732-2d5d-4736-89f3-91eb5d23cef8
 *
 * 突合ルール：
 *  - 会社名/プロジェクト名を正規化（法人格・敬称・記号・全半角を落とす）して照合。
 *    正規化で寄らないものは ALIAS で明示的に対応付ける。
 *  - 同名が複数ある場合は納品予定日の新しい順に並べて先頭から対応付ける。
 *  - DB 側は category=映像 を優先（Notion マスタは映像制作のPMボードのため）。
 *  - Notion 側のステータスが空の行は、納品済チェックが立っていれば DELIVERED、
 *    そうでなければ「情報なし」として触らない。
 */
import { PrismaClient, type ProductionStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

const APPLY = process.argv.includes("--apply");
// 既定はローカルDB（.env）。--prod で本番 Neon、--staging でステージング。
const PROD = process.argv.includes("--prod");
const STAGING = process.argv.includes("--staging");

dotenv.config({
  path: PROD ? ".env.production.local" : STAGING ? ".env.staging" : ".env",
  override: true,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ------------------------------------------------------------
// Notion「マスタ」スナップショット（2026-08-09 取得）
// ------------------------------------------------------------
type NotionRow = {
  name: string;
  status: string | null;
  delivered: boolean;
  shoot?: string | null;
  delivery?: string | null;
  /** 仮納品予定日。2026-08にPM機能から廃止したため取込対象外（スナップショットの記録としてのみ保持）。 */
  provisional?: string | null;
  director?: string | null;
  camera?: string | null;
  editor?: string | null;
  note?: string | null;
};

const NOTION_ROWS: NotionRow[] = [
  { name: "大冷工業株式会社", status: null, delivered: false, delivery: "2026-10-31" },
  { name: "株式会社サンセイアールアンドディ", status: null, delivered: false, delivery: "2026-10-31" },
  { name: "株式会社プラセム", status: "撮影前", delivered: false, delivery: "2026-10-31" },
  { name: "日本ビジネスデーター プロセシングセンター", status: "撮影前", delivered: false, delivery: "2026-10-31" },
  { name: "明治飼糧株式会社", status: null, delivered: false, delivery: "2026-10-31" },
  { name: "株式会社江田商会", status: null, delivered: false, delivery: "2026-10-31" },
  { name: "岩泉町役場", status: null, delivered: false, delivery: "2026-10-31" },
  { name: "山晃住宅", status: "撮影前", delivered: false, delivery: "2026-07-31", camera: "坂井" },
  { name: "ZACROS", status: "撮影前", delivered: false, delivery: "2026-07-31" },
  { name: "北野病院", status: "修正中", delivered: false, delivery: "2026-05-31" },
  { name: "メディアリンク株式会社", status: "修正中", delivered: false, delivery: "2026-05-31" },
  { name: "株式会伸晃", status: "撮影前", delivered: false, delivery: "2026-05-31" },
  {
    name: "株式会社カーテンじゅうたん王国",
    status: "編集中",
    delivered: false,
    shoot: "2026-03-09",
    delivery: "2026-05-31",
    director: "BlueTape",
    camera: "BlueTape",
  },
  {
    name: "交換できるくん",
    status: "編集中",
    delivered: false,
    delivery: "2026-04-30",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "児童養護施設 積慶園",
    status: "納品済み",
    delivered: false,
    delivery: "2026-04-15",
    provisional: "2026-01-15",
    director: "松本, 坂井",
    camera: "坂井",
    editor: "傍田, 松本",
  },
  {
    name: "株式会社プラス",
    status: "納品済み",
    delivered: false,
    delivery: "2026-04-15",
    provisional: "2025-12-31",
    director: "松本, 西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  { name: "竹内産業", status: "納品済み", delivered: true, delivery: "2026-03-31" },
  { name: "オチアイ", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "近鉄（近鉄ゴルフアンドリゾート）", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "日本海総合病院", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "JAほくさい", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "近鉄（宝生苑）", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "近鉄（近鉄リテーリング）", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "八尾トーヨー住器", status: "納品済み", delivered: false, delivery: "2026-03-31", editor: "傍田" },
  {
    name: "株式会社読宣",
    status: "納品済み",
    delivered: false,
    shoot: "2026-03-05",
    delivery: "2026-03-31",
    provisional: "2026-03-20",
    camera: "BlueTape",
  },
  { name: "草野作工", status: "納品済み", delivered: true, delivery: "2026-03-31", camera: "坂井", editor: "傍田" },
  { name: "丸水設備株式会社", status: "納品済み", delivered: true, delivery: "2026-03-31" },
  { name: "財務省関税局", status: "納品済み", delivered: false, delivery: "2026-03-31" },
  { name: "株式会社ウィザス", status: "納品済み", delivered: false, delivery: "2026-03-16" },
  // 内山アドバンスと三友エンジニヤリングは Notion では別行だが DB では1社1案件。
  // DB の会社名が「内山アドバンス（三友エンジニアリング）」なので内山アドバンス側を優先して当てる。
  { name: "内山アドバンス", status: "先方チェック待ち", delivered: false, delivery: "2026-02-28" },
  { name: "三友エンジニヤリング", status: "修正中", delivered: false, delivery: "2026-02-28" },
  { name: "株式会社BSNアイネット", status: "納品済み", delivered: false, delivery: "2026-02-28" },
  {
    name: "日本経営",
    status: "納品済み",
    delivered: true,
    delivery: "2026-02-28",
    director: "傍田",
    camera: "坂井",
    editor: "傍田",
  },
  {
    name: "bbs金明",
    status: "納品済み",
    delivered: true,
    delivery: "2026-02-28",
    director: "傍田",
    camera: "坂井",
    editor: "傍田",
  },
  {
    name: "前田特許事務所",
    status: "納品済み",
    delivered: true,
    delivery: "2026-02-28",
    provisional: "2026-01-31",
    director: "松本, 坂井",
    camera: "坂井",
  },
  {
    name: "ユニオンテクノロジー",
    status: "納品済み",
    delivered: false,
    delivery: "2026-01-31",
    director: "西村さん",
    camera: "西村さん",
  },
  {
    name: "ベネフィット",
    status: "納品済み",
    delivered: true,
    delivery: "2025-12-31",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  { name: "三谷製作所", status: "納品済み", delivered: true, delivery: "2025-12-31", director: "坂井", camera: "坂井" },
  {
    name: "京都社会福祉協会",
    status: "納品済み",
    delivered: true,
    delivery: "2025-12-31",
    director: "傍田",
    camera: "傍田",
    editor: "傍田",
  },
  {
    name: "トクシン電気",
    status: "編集中",
    delivered: false,
    shoot: "2025-05-26",
    delivery: "2025-12-26",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "岡谷酸素株式会社",
    status: "撮影前",
    delivered: false,
    delivery: "2025-12-10",
    provisional: "2025-11-30",
    director: "松本",
  },
  { name: "株式会社フィグニ―", status: "納品済み", delivered: true, delivery: "2025-11-30", editor: "傍田" },
  {
    name: "KFB福島放送",
    status: "納品済み",
    delivered: true,
    shoot: "2025-10-03",
    delivery: "2025-11-30",
    provisional: "2025-10-31",
    editor: "傍田",
  },
  { name: "株式会社イープラス", status: "納品済み", delivered: true, delivery: "2025-11-28", provisional: "2025-11-14" },
  {
    name: "JMAC",
    status: "納品済み",
    delivered: true,
    delivery: "2025-10-31",
    provisional: "2025-09-30",
    director: "傍田",
    camera: "西村さん",
    editor: "傍田",
  },
  {
    name: "三恭工業株式会社",
    status: "納品済み",
    delivered: true,
    shoot: "2025-08-26",
    delivery: "2025-10-31",
    provisional: "2025-09-15",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "株式会社studio D plus",
    status: "納品済み",
    delivered: true,
    delivery: "2025-10-31",
    provisional: "2025-10-17",
    editor: "flatfieldさん",
  },
  {
    name: "パナソニックリビング",
    status: "納品済み",
    delivered: true,
    delivery: "2025-10-31",
    provisional: "2025-10-20",
    editor: "flatfieldさん",
  },
  {
    name: "東急リニューアル株式会社",
    status: "納品済み",
    delivered: true,
    shoot: "2025-07-05",
    delivery: "2025-09-30",
    provisional: "2025-08-15",
    director: "松本, 西村さん, 坂井",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "若林電設株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-09-30",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "株式会社SKB",
    status: "納品済み",
    delivered: true,
    shoot: "2025-07-15",
    delivery: "2025-09-15",
    provisional: "2025-08-31",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "辻商店",
    status: "納品済み",
    delivered: true,
    delivery: "2025-07-31",
    provisional: "2025-07-28",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "澤村株式会社",
    status: "納品済み",
    delivered: true,
    shoot: "2025-06-19",
    delivery: "2025-07-30",
    provisional: "2025-07-03",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "新栄ダクトグループ",
    status: "納品済み",
    delivered: true,
    shoot: "2025-04-15",
    delivery: "2025-06-30",
    provisional: "2025-04-21",
    director: "坂井",
    camera: "坂井",
    editor: "傍田",
  },
  {
    name: "アペックス",
    status: "納品済み",
    delivered: true,
    shoot: "2025-06-16",
    delivery: "2025-06-30",
    director: "坂井",
    camera: "坂井",
    editor: "木戸さん",
  },
  {
    name: "日本ビジネスデータープロセシングセンター",
    status: "納品済み",
    delivered: true,
    delivery: "2025-05-31",
    provisional: "2025-03-31",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "ヤマショー金属株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-05-31",
    provisional: "2025-04-30",
    director: "松本",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "愛泉会病院",
    status: "納品済み",
    delivered: true,
    delivery: "2025-05-30",
    provisional: "2024-12-03",
    director: "桑田さん",
    camera: "傍田",
    editor: "桑田さん",
  },
  {
    name: "システム機器販売株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-04-30",
    director: "坂井",
    camera: "坂井",
    editor: "矢尾さん",
  },
  {
    name: "HTBエナジー",
    status: "納品済み",
    delivered: true,
    shoot: "2025-03-28",
    delivery: "2025-04-30",
    provisional: "2025-04-15",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "アイティーフォー",
    status: "納品済み",
    delivered: true,
    shoot: "2025-04-02",
    delivery: "2025-04-25",
    provisional: "2025-04-25",
    director: "マーティンさん",
    camera: "マーティンさん",
    editor: "マーティンさん",
  },
  {
    name: "一般財団法人 沖縄美ら島財団",
    status: "納品済み",
    delivered: true,
    delivery: "2025-04-12",
    provisional: "2025-02-15",
    director: "尾山",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "株式会社プライムアシスタンス",
    status: "納品済み",
    delivered: true,
    delivery: "2025-03-31",
    provisional: "2025-03-25",
    director: "マーティンさん",
    camera: "マーティンさん",
    editor: "マーティンさん",
  },
  {
    name: "平和鋼材株式会社",
    status: "納品済み",
    delivered: true,
    shoot: "2025-03-10",
    delivery: "2025-03-31",
    provisional: "2025-02-15",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  { name: "ウィザス", status: "納品済み", delivered: true, delivery: "2025-03-27", editor: "木戸さん" },
  {
    name: "株式会社POT RIVER",
    status: "納品済み",
    delivered: true,
    shoot: "2025-02-21",
    delivery: "2025-03-26",
    provisional: "2025-03-26",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "ガーデン光房",
    status: "納品済み",
    delivered: true,
    delivery: "2025-03-10",
    provisional: "2025-02-04",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "井上リボン株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-02-28",
    provisional: "2025-01-06",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "総合教育研究所",
    status: "納品済み",
    delivered: true,
    delivery: "2025-02-28",
    provisional: "2025-02-28",
    director: "尾山",
  },
  {
    name: "石巻合板工業株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-02-28",
    provisional: "2025-01-31",
    director: "西村さん",
    camera: "西村さん",
    editor: "西村さん",
  },
  {
    name: "目黒外科",
    status: "納品済み",
    delivered: true,
    delivery: "2025-02-10",
    provisional: "2025-01-28",
    director: "桑田さん",
    camera: "傍田",
    editor: "桑田さん",
  },
  {
    name: "千代田精機株式会社",
    status: "納品済み",
    delivered: true,
    delivery: "2025-01-31",
    provisional: "2024-12-16",
    director: "マーティンさん",
    camera: "マーティンさん",
    editor: "マーティンさん",
  },
  {
    name: "有限会社秋山産業",
    status: "納品済み",
    delivered: true,
    delivery: "2024-10-31",
    provisional: "2024-10-15",
    director: "Futaさん",
    camera: "Futaさん",
    editor: "Futaさん",
  },
  { name: "タイミングット", status: null, delivered: true, delivery: "2024-09-30" },
  { name: "エクラート", status: "納品済み", delivered: true, delivery: "2024-08-31", note: "２８万円は納品後振込" },
  {
    name: "小西化学工業",
    status: "納品済み",
    delivered: true,
    delivery: "2024-08-31",
    director: "松本",
    camera: "マーティンさん",
    editor: "マーティンさん",
  },
  { name: "チェリオコーポレーション", status: "納品済み", delivered: true, delivery: "2024-08-31", director: "松本" },
  { name: "リゾートトラスト", status: null, delivered: true, delivery: "2024-08-31", note: "交通費のみ別途請求" },
  { name: "松岡運送株式会社様", status: null, delivered: true, delivery: "2024-07-31" },
  { name: "株式会社トーシン", status: null, delivered: true, delivery: "2024-07-31" },
  { name: "アサヒサンクリーン株式会社", status: null, delivered: true, delivery: "2024-07-31" },
  { name: "三好ロジテック", status: null, delivered: true, delivery: "2024-06-30" },
  {
    name: "スカイジャパン",
    status: "納品済み",
    delivered: true,
    delivery: "2024-02-29",
    director: "松本",
    camera: "Futaさん",
    editor: "Futaさん",
  },
  { name: "ダイワボウ情報システム", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "修光学園", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "藤原運輸", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "PHG大阪マネジメント", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "明清建設", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "大原野こども園", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "近畿労働金庫", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "タカラスタンダード", status: null, delivered: true, delivery: "2024-01-31" },
  { name: "株式会社マクセル様", status: null, delivered: true, delivery: "2023-12-31" },
  { name: "スーパーホテル", status: null, delivered: true, delivery: "2023-12-31" },
  { name: "株式会社セレクティ様", status: null, delivered: true, delivery: "2023-11-30" },
  {
    name: "株式会社渕上ファインズ様",
    status: "納品済み",
    delivered: true,
    delivery: "2023-11-30",
    director: "松本",
    camera: "Futaさん",
    editor: "Futaさん",
  },
  { name: "三菱ロジスネクスト株式会社様", status: null, delivered: true, delivery: "2023-11-30" },
  { name: "三宝電機", status: null, delivered: true, delivery: "2023-09-30" },
  { name: "日本経営ウィル税理士法人様", status: null, delivered: true, delivery: "2023-09-30" },
  { name: "鴻池組", status: null, delivered: true, delivery: "2023-09-30" },
  { name: "キヤノンシステムアンドサポート株式会社様", status: null, delivered: true, delivery: "2023-09-30" },
  { name: "鹿児島県森林組合連合会様", status: null, delivered: true, delivery: "2023-08-31" },
  { name: "ホテルリバーサイド嵐山様", status: null, delivered: true, delivery: "2023-08-15" },
  { name: "社会医療法人　信愛会様", status: null, delivered: true, delivery: "2023-07-31" },
  { name: "社会福祉法人　小田原福祉会様", status: null, delivered: true, delivery: "2023-07-31" },
  { name: "株式会社セルート様", status: null, delivered: true, delivery: "2023-07-25" },
  { name: "パナソニックリビング株式会社様", status: null, delivered: true, delivery: "2023-06-30" },
  { name: "東京都中小企業振興社", status: null, delivered: true, delivery: "2023-03-31" },
  { name: "港湾冷蔵株式会社", status: null, delivered: true, delivery: "2023-01-01" },
  { name: "タイヤーサービスセンター", status: null, delivered: true, delivery: "2023-01-01" },
  { name: "八尾トーヨー株式会社様", status: null, delivered: true, delivery: "2023-01-01" },
  { name: "水島ゴム工業用品株式会社", status: null, delivered: true, delivery: "2023-01-01" },
];

/** Notion側にしか無い表記 → DB(Company.name)側の表記。正規化前の生文字列で書く。 */
const ALIAS: Record<string, string> = {
  JMAC: "株式会社日本能率協会コンサルティング",
  アイティーフォー: "株式会社アイティフォー",
  新栄ダクトグループ: "新栄ダクト製作所㈱",
  エクラート: "株式会社ECLART",
  JAほくさい: "ほくさい農業協同組合",
  北野病院: "公益財団法人田附興風会 医学研究所北野病院",
  株式会伸晃: "株式会社伸晃",
  日本経営: "日本経営グループ",
  bbs金明: "株式会社BBS金明",
  ユニオンテクノロジー: "株式会社ユニオン・テクノロジー",
  株式会社読宣: "株式会社讀宣",
  井上リボン株式会社: "井上リボン工業株式会社",
  財務省関税局: "財務省 関税局",
  "株式会社フィグニ―": "フィグニー株式会社",
  タイミングット: "株式会社タイミングッド",
  三友エンジニヤリング: "株式会社内山アドバンス（三友エンジニアリング）",
  内山アドバンス: "株式会社内山アドバンス（三友エンジニアリング）",
  "八尾トーヨー株式会社様": "八尾トーヨー住器株式会社",
  "日本ビジネスデーター プロセシングセンター": "株式会社日本ビジネスデータープロセシングセンター",
  日本ビジネスデータープロセシングセンター: "株式会社日本ビジネスデータープロセシングセンター",
  渕上ファインズ: "渕上ファインズ",
  ベネフィット: "", // DB に該当なし（明示的に対象外）
  山晃住宅: "",
  岩泉町役場: "",
  株式会社サンセイアールアンドディ: "",
  "株式会社POT RIVER": "",
  チェリオコーポレーション: "",
  藤原運輸: "",
  日本経営ウィル税理士法人様: "", // 日本経営グループと区別できないため対象外
  "近鉄（近鉄ゴルフアンドリゾート）": "",
  "近鉄（宝生苑）": "",
  "近鉄（近鉄リテーリング）": "",
};

const STATUS_BY_LABEL: Record<string, ProductionStatus> = {
  撮影前: "BEFORE_SHOOT",
  編集中: "EDITING",
  修正中: "REVISING",
  先方チェック待ち: "CLIENT_REVIEW",
  修正待ち: "REVISION_WAIT",
  納品間近: "NEAR_DELIVERY",
  納品済み: "DELIVERED",
};

/** 法人格・敬称・記号・全半角ゆれを落とした照合キー */
function norm(raw: string): string {
  let s = raw.normalize("NFKC").trim();
  s = s.replace(
    /(株式会社|有限会社|合同会社|一般財団法人|公益財団法人|一般社団法人|公益社団法人|社会福祉法人|社会医療法人|医療法人|学校法人|\(株\)|\(有\)|㈱|㈲)/g,
    "",
  );
  s = s.replace(/様$/g, "");
  s = s.replace(/[\s・･,，、／\/\-‐-―ー－_（）()【】]/g, "");
  return s.toLowerCase();
}

function toDate(s: string | null | undefined): Date | null {
  return s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const expected = PROD ? "ep-round-band-aoj5sgyq" : STAGING ? "ep-wispy-sun-ao9ahi1c" : "salesagent_luma";
  if (!url.includes(expected)) {
    throw new Error(`想定外のDBに接続しています（期待: ${expected}）: ${url.slice(0, 60)}`);
  }
  const envName = PROD ? "本番 Neon" : STAGING ? "ステージング" : "ローカル";
  console.log(`接続先: ${envName} / ${url.replace(/:[^:@/]+@/, ":***@").slice(0, 70)}`);

  const dbRows = await prisma.productionProject.findMany({
    select: {
      id: true,
      projectName: true,
      category: true,
      status: true,
      createdAt: true,
      company: { select: { name: true } },
    },
  });

  // DB を正規化名でグルーピング（映像 → その他 の順、同カテゴリ内は作成順）
  const CATEGORY_RANK: Record<string, number> = { 映像: 0, CATV: 1, アライアンス: 2, SNS: 3 };
  const dbByKey = new Map<string, typeof dbRows>();
  for (const r of dbRows) {
    const key = norm(r.company?.name ?? r.projectName);
    const list = dbByKey.get(key) ?? [];
    list.push(r);
    dbByKey.set(key, list);
  }
  for (const list of dbByKey.values()) {
    list.sort(
      (a, b) =>
        (CATEGORY_RANK[a.category ?? ""] ?? 9) - (CATEGORY_RANK[b.category ?? ""] ?? 9) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  // Notion を正規化名でグルーピング（納品予定日の新しい順）
  const notionByKey = new Map<string, NotionRow[]>();
  const excluded: string[] = [];
  for (const row of NOTION_ROWS) {
    if (row.name.includes("複製して使用") || row.name === "CG案件") continue;
    const alias = ALIAS[row.name];
    if (alias === "") {
      excluded.push(row.name);
      continue;
    }
    const key = norm(alias ?? row.name);
    const list = notionByKey.get(key) ?? [];
    list.push(row);
    notionByKey.set(key, list);
  }
  for (const list of notionByKey.values()) {
    list.sort((a, b) => (b.delivery ?? "").localeCompare(a.delivery ?? ""));
  }

  const updates: { id: string; label: string; before: string; after: string; data: Record<string, unknown> }[] = [];
  const unmatched: string[] = [];
  const surplus: string[] = [];

  for (const [key, nRows] of notionByKey) {
    const dRows = dbByKey.get(key);
    if (!dRows || dRows.length === 0) {
      unmatched.push(`${nRows[0].name}（Notion ${nRows.length}件）`);
      continue;
    }
    if (nRows.length > dRows.length) {
      surplus.push(`${nRows[0].name}: Notion ${nRows.length}件 / DB ${dRows.length}件 → 先頭${dRows.length}件のみ反映`);
    }
    const n = Math.min(nRows.length, dRows.length);
    for (let i = 0; i < n; i++) {
      const nr = nRows[i];
      const dr = dRows[i];
      const status: ProductionStatus | null = nr.status
        ? (STATUS_BY_LABEL[nr.status] ?? null)
        : nr.delivered
          ? "DELIVERED"
          : null;

      const data: Record<string, unknown> = {
        delivered: nr.delivered,
        shootDate: toDate(nr.shoot),
        deliveryDate: toDate(nr.delivery),
        directorName: nr.director ?? null,
        cameraName: nr.camera ?? null,
        editorName: nr.editor ?? null,
      };
      if (status) data.status = status;
      if (nr.note) data.note = nr.note;

      updates.push({
        id: dr.id,
        label: `${dr.company?.name ?? dr.projectName}[${dr.category}] ← Notion「${nr.name}」`,
        before: dr.status,
        after: status ?? `${dr.status}(据置)`,
        data,
      });
    }
  }

  console.log(`=== 突合結果 ===`);
  console.log(`DB案件: ${dbRows.length}件 / Notion: ${NOTION_ROWS.length}行`);
  console.log(`更新対象: ${updates.length}件`);
  console.log(`\n--- 更新内容 ---`);
  for (const u of updates) console.log(`  ${u.before} → ${u.after}  ${u.label}`);
  console.log(`\n--- DBに該当なし（未反映） ${unmatched.length}件 ---`);
  for (const u of unmatched) console.log(`  ${u}`);
  if (excluded.length) {
    console.log(`\n--- 対象外（DB未登録 or 特定不能） ${excluded.length}件 ---`);
    console.log(`  ${excluded.join(" / ")}`);
  }
  if (surplus.length) {
    console.log(`\n--- 件数不一致 ---`);
    for (const s of surplus) console.log(`  ${s}`);
  }

  const touched = new Set(updates.map((u) => u.id));
  const untouched = dbRows.filter((r) => !touched.has(r.id));
  console.log(`\n--- Notionに情報が無くBEFORE_SHOOTのまま残る案件: ${untouched.length}件 ---`);
  for (const r of untouched) console.log(`  ${r.company?.name ?? r.projectName}[${r.category}]`);

  if (!APPLY) {
    console.log(`\n*** dry-run です。反映するには --apply を付けて再実行してください。 ***`);
    return;
  }

  // ロールバック用スナップショット（更新対象の現在値）
  const snapshot = await pool.query(
    `SELECT id, status::text, pm_name, director_name, camera_name, editor_name,
            shoot_date, delivery_date, delivered, note
       FROM production_projects WHERE id = ANY($1::text[])`,
    [updates.map((u) => u.id)],
  );
  const snapPath = `pm-sync-backup-${PROD ? "prod" : STAGING ? "staging" : "local"}.json`;
  (await import("node:fs")).writeFileSync(snapPath, JSON.stringify(snapshot.rows, null, 1));
  console.log(`\nバックアップ: ${snapPath}（${snapshot.rowCount}件）`);

  let ok = 0;
  for (const u of updates) {
    // select を絞る：ローカルDBは production_projects に tenant_id が無い（スキーマドリフト）ため、
    // 全列 RETURNING だと ColumnNotFound で落ちる。
    await prisma.productionProject.update({ where: { id: u.id }, data: u.data, select: { id: true } });
    ok++;
  }
  console.log(`\n*** ${ok}件を更新しました。 ***`);

  const after = await pool.query<{ status: string; count: string }>(
    `SELECT status::text AS status, count(*)::text AS count FROM production_projects GROUP BY status ORDER BY 2 DESC`,
  );
  console.log("=== 反映後のステータス分布 ===");
  for (const g of after.rows) console.log(`  ${g.status}: ${g.count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
