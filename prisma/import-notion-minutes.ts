/**
 * Notion 「🈺 Re;easyヨミ表」 18ページの議事録を salesagent_reagey の Meeting テーブルに投入。
 *
 * 実行：
 *   DATABASE_URL=postgresql://.../salesagent_reagey?... npx tsx prisma/import-notion-minutes.ts
 *
 * 仕様：
 * - 各ページ本文から「初回商談議事録」「2回目商談議事録」セクションを抽出
 * - <empty-block/> のみ／空文字／スペースのみのセクションはスキップ
 * - 抽出した本文を minutes に格納（マークダウンそのまま）
 * - 該当 Company に紐づく Deal が無ければスキップ（ヨミ未設定企業）
 * - Deal が複数ある場合は probability が高い順、同点なら作成日が古い順で先頭1件を選択
 * - 既存 Meeting に同じ source(notion-page-id) + section(初回/2回目) があれば update、
 *   無ければ create（再実行で重複しない）
 * - meta JSON に { source: "notion", notionUrl, section, importedAt } を記録
 *
 * 注意：このスクリプトは Notion MCP で取得した本文をハードコードしている。
 * Notion 側の本文が更新された場合は、ハードコード文字列を更新してから再実行する。
 * （MCP は Claude 側のツールで、tsx スクリプトからは直接呼べないため）
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

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
// Notion 18ページの抽出済み議事録データ
// （Notion MCP fetch 結果から手動で抜き出してハードコード）
// ============================================================
type Section = { kind: "初回" | "2回目"; minutes: string };
interface PageData {
  notionPageId: string;
  notionUrl: string;
  companyName: string;
  // 初回商談日（meetingDate に使用）
  meetingDate: string; // YYYY-MM-DD
  sections: Section[]; // 抽出された議事録（空配列なら本文なし）
}

const PAGES: PageData[] = [
  {
    notionPageId: "35235f9288f38091a83ed8de23736eac",
    notionUrl: "https://app.notion.com/p/35235f9288f38091a83ed8de23736eac",
    companyName: "株式会社システムサポート",
    meetingDate: "2026-05-18",
    sections: [], // 商談未実施・本文 empty-block のみ
  },
  {
    notionPageId: "34035f9288f380a38ac4e1e988f77174",
    notionUrl: "https://app.notion.com/p/34035f9288f380a38ac4e1e988f77174",
    companyName: "株式会社タイヤーサービスセンター",
    meetingDate: "2026-05-15",
    sections: [],
  },
  {
    notionPageId: "34035f9288f38062b97fe13e38ed954e",
    notionUrl: "https://app.notion.com/p/34035f9288f38062b97fe13e38ed954e",
    companyName: "前田特許事務所",
    meetingDate: "2026-05-15",
    sections: [],
  },
  {
    notionPageId: "35235f9288f380cf872bcb4cbdd6aaae",
    notionUrl: "https://app.notion.com/p/35235f9288f380cf872bcb4cbdd6aaae",
    companyName: "株式会社銭形企画",
    meetingDate: "2026-05-12",
    sections: [],
  },
  {
    notionPageId: "35235f9288f3808da9dcf620c99b6b83",
    notionUrl: "https://app.notion.com/p/35235f9288f3808da9dcf620c99b6b83",
    companyName: "熊澤酒造株式会社",
    meetingDate: "2026-04-30",
    sections: [],
  },
  {
    notionPageId: "35235f9288f380e7aa62f6ad56102056",
    notionUrl: "https://app.notion.com/p/35235f9288f380e7aa62f6ad56102056",
    companyName: "水島ゴム工業用品株式会社",
    meetingDate: "2026-04-30",
    sections: [],
  },
  {
    notionPageId: "34c35f9288f3800ab152f87666f79880",
    notionUrl: "https://app.notion.com/p/34c35f9288f3800ab152f87666f79880",
    companyName: "株式会社ジェイマックシステム",
    meetingDate: "2026-04-24",
    sections: [],
  },
  {
    notionPageId: "33735f9288f38012bf8ffc67071e78b3",
    notionUrl: "https://app.notion.com/p/33735f9288f38012bf8ffc67071e78b3",
    companyName: "ダイワサイクル株式会社",
    meetingDate: "2026-04-23",
    sections: [
      {
        kind: "初回",
        minutes: `- ご参加：上野様（営業部）
\t- 基本的には窓口業務
\t\t- たむけんが返ってきたとき
\t\t- 大学に置くパンフレットの印刷など
\t- インスタなどは別の担当がいる
- 学生向けに大学生協と自転車販促をしている形
\t- ほとんどがチラシ
\t- サイネージは何回かやったことはある
- 予算組は秋で来期予算を組む
\t- 予算組の際に、人事や広報につなげてもらい提案`,
      },
    ],
  },
  {
    notionPageId: "33a35f9288f380fbb8dbc2145cfe4e20",
    notionUrl: "https://app.notion.com/p/33a35f9288f380fbb8dbc2145cfe4e20",
    companyName: "株式会社三谷製作所",
    meetingDate: "2026-04-22",
    sections: [
      {
        kind: "初回",
        minutes: `- 今年は入社1名
- 動画の使い方
\t- 企業説明会・HP
\t- スポーツセンター
- 地元がメイン
- 尾道に貢献したい
- 採用課題
\t- 毎年1人くらいは取れている
\t\t- 来た人を採用している
\t\t- 再現性がない
\t\t\t- 運任せになっている
- 広報業務
\t- 絵本を今作っている（知り合いの会社と）
- 提案
\t- リアクションは微妙
\t\t- SNSの発信の必要性は考えているが、いまではない
\t- 採用の母集団形成（インターンシップの母集団形成）
\t\t- 尾道・広島での集客手法について
\t- 小学生にモノづくりの楽しさを発信していきたい
\t- 街の中にオブジェを作成したい

\\<坂井議事録\\>

- 映像の活用
\t- 市の施設や説明会、HPでの放映
- 採用の業務について
\t- 新卒は今年は1人採用
\t- 採用は人事はいるものの、面接などは社長が担当している
\t- 採用は地元（尾道住）がほとんど、たまに県外の方がいる
\t- 毎年1人はとれてるが母数が多いわけではなく、来た人を選んでる
\t\t- 応募が５人来てその中から一人を選ぶのが理想ではある
\t- 採用した人はやめずに続けており定着はできている
\t- 採用は以前マイナビを使っていたが効果がなくもう今はハローワークや学校での集客がメインになっている
\t- 次回、広島において採用手法でどのようなものがあるか提案する
- 尾道に貢献したい、若い人に希望をもって働いてほしい、尾道は若い経営者は多くて魅力があるそこにつながっていくことが多いと思う
- 今後ブランディングで取り組みたいこと
\t- 絵本を作りたい
\t\t- 金属のエラー品をSDGｓの観点で緩和するような絵本を作りたい
\t- 銅像を建てたい
\t\t- 尾道のシンボルになるような銅像
\t\t- 尾道大学や芸術系の学生と自分たちの技術力を使って作っていきたい`,
      },
    ],
  },
  {
    notionPageId: "33a35f9288f3808abfbbf6784e24a734",
    notionUrl: "https://app.notion.com/p/33a35f9288f3808abfbbf6784e24a734",
    companyName: "株式会社セルート",
    meetingDate: "2026-04-22",
    sections: [
      {
        kind: "初回",
        minutes: `- 参加：今村様（広報担当）
\t- 早乙女様はご退職し、今村様のみの参加
\t\t- 今村さんと上長の２人で広報活動をしている体制
- youtube
\t- 採用動画を定期的に更新している
\t- 採用目的で活用している
- SNSを力を入れていきたいという社内の話はある
\t- コンテンツを増やしていく
- HPリニューアルに伴い、社員などの写真を撮影したが、退職者などもいて、使える素材が少なくなっている
\t- 写真１枚で他の素材もできればよいよねというので商談の時間を設けた
- 課題感
\t- ２人態勢になったというのもあり、チェックや調整業務が大変
\t- サイトを充実させるのと、いろんな人に見てもらえるようにしたい
\t\t- 今はサイトを解析して少しずつ変えてはいる
\t\t\t- コンテンツを充実させるのが優先順位としては高い
\t- HPや映像の定期的な刷新が業務をひっ迫している
\t\t- HPは2023年に作成した
\t\t- インタビュー部分や素材を変更するなどで提案の余地ありそう
\t- SNSに力を入れたい
\t\t- Instagramはやりたいが、画像投稿などの工数のハードルが高い

今村様に決裁権はなさそうで意思決定はおそらく難しい。そのため次回上席アポを取りに行く`,
      },
    ],
  },
  {
    notionPageId: "33a35f9288f380c7b67dd3e38feec1e4",
    notionUrl: "https://app.notion.com/p/33a35f9288f380c7b67dd3e38feec1e4",
    companyName: "澤村株式会社",
    meetingDate: "2026-04-20",
    sections: [
      {
        kind: "初回",
        minutes: `- 参加者
\t- 酒谷典秀：総務部長
\t- 奥野部長
\t- 突々次長
- 映像は採用増えたかどうかわからないが面接時に見てなかれば見てもらえるようにしている
- 採用について
\t- 採用体制は2名
\t\t- 新卒
\t\t\t- エージェント
\t\t\t\t- 学生と直接やり取りしているエージェントに相談している
\t\t\t- 女性の担当者
\t\t\t- 説明会
\t\t- 中途
\t\t\t- ハローワーク
\t\t\t- 求人広告
\t\t\t\t- doda
\t\t\t\t- 求人ボックス
\t\t\t- エージェント
\t\t\t\t- ６～７社ほど
\t\t\t- 説明会
\t- 課題感
\t\t- 母集団形成
\t- 工数がかかっている業務
\t\t- 日程調整
\t\t\t- メールのやり取り
\t- 採用の再現性がない（仮説）
\t\t- エージェント依存になってしまっているので採用の運の要素が強い
- 26卒
\t- 3人目標の1人着地
\t\t- 母集団形成が可能
\t\t- リクナビのシステムが変わった（インディードプラス）の影響でエントリーが少なくなった
- SNS
\t- 必要性が分かるが、工数がかかり継続できていない
\t\t- 人数規模もそこまで大きいわけではないので

【追加メモ】
- 通販の写真撮影（ニーズ大あり）
\t- モデルを使った撮影ができない
\t- AIを使ってイメージ画像
\t- 1商品で30カット（カラー展開）×商品数

【ネクストアクション】
- EC画像の要件聞いて見積もり出す`,
      },
    ],
  },
  {
    notionPageId: "34035f9288f380e4a345d15571ebce49",
    notionUrl: "https://app.notion.com/p/34035f9288f380e4a345d15571ebce49",
    companyName: "株式会社日本ビジネスデータープロセシングセンター",
    meetingDate: "2026-04-20",
    sections: [
      {
        kind: "初回",
        minutes: `- 27卒は26卒とほぼ変わらない
- 母集団は地域差がある
- 神戸はうまくいくが、それ以外が苦戦している
- 歩留まりはどのエリアも苦戦
- ふわっとした状態で面接に来る

【中途】
- エンジニア
\t- 関西関東中部
\t- コンスタントに応募は来ている
- 医療関連
\t- 医師事務（注力ポイント）
\t\t- 神戸や他の病院も
\t\t- youtube広告
\t- 自治体事務
\t\t- 全国展開
\t\t\t- 地方エリア（奈良・滋賀）は母集団の部分
\t\t\t- ポスティング施策は行っている状態
\t\t- 市役所での介護保険に関する調査業務
\t\t\t- ケアマネなどの資格が必要
\t\t- 媒体が中心
\t\t\t- ミドルからシニアがターゲット

【冨永メモ】

〈興味がある点〉
- AIを使った動画・画像生成

〈状況〉
- 26卒⇒40〜50名
- 27卒⇒変わらず充実はしている
- 関東 / 大阪⇒承諾までが道のりが長い
- いかにつなぎとめられるか
- 母集団形成
- 神戸で働きたい人は内定承諾までのスピードが速い

〈課題〉
- ふわーとした状態で面接に来るひともいる
- エンジニア（関西・関東・中部）
- 医療事務(神戸市内)
- 自治体の事務
\t- 奈良・滋賀・北部
\t  ⇒物理的なチラシ
\t  ⇒介護保険の調査
\t- 利用・状況
- 外部広報人事

〈動画・画像系〉
◎広報と連携必要
- ミドル/シニア
\t⇒媒体が中心

〈ネクストアクション〉
- チラシ / デザイン　等　次回会った際に三宅から状況伺い

【アジェンダ】
- 帳票関係進捗確認
- 数字（アポ数・進捗確認）
- 井上リボン様 / 提案進捗確認
- 営業資料追加でリバイスするかどうか
- その他相談事項`,
      },
    ],
  },
  {
    notionPageId: "33a35f9288f380a196dded74ced1eb02",
    notionUrl: "https://app.notion.com/p/33a35f9288f380a196dded74ced1eb02",
    companyName: "日本経営グループ",
    meetingDate: "2026-04-20",
    sections: [
      {
        kind: "初回",
        minutes: `- 税理士科目持っているのが4/15くらい
\t- 28卒は税理士持っている人を半分にしたい
\t- 税理士科目を持っている人はBIG4に入ってしまう
- 学生との接点を多く持ちたい
- 人事の内部の業務の工数を削減したい
\t- １次面接〜最終面接までのログをもとに各フェーズで何が聞けていないのか、次の面接で何を聞かなければならないのか
- AIで面接ログの整備
- 候補者ごとにどんな口説き方をすればよいのか、方向性が面接ログからわかるようなプロダクトがあると良い

※大原の取り組み画像が添付されていた`,
      },
    ],
  },
  {
    notionPageId: "33a35f9288f380b48a9af371a5f107f0",
    notionUrl: "https://app.notion.com/p/33a35f9288f380b48a9af371a5f107f0",
    companyName: "マクセル株式会社",
    meetingDate: "2026-04-17",
    sections: [],
  },
  {
    notionPageId: "34035f9288f38082829fcecde290117a",
    notionUrl: "https://app.notion.com/p/34035f9288f38082829fcecde290117a",
    companyName: "井上リボン工業株式会社",
    meetingDate: "2026-04-13",
    sections: [
      {
        kind: "初回",
        minutes: `地元映画館・
新卒やっておらず、中途は欠員が出た場合
認知してもらいたい
ECサイトに掲載する画像をAIに

- 中途採用：40歳以下
\t- 新卒はやっていない
\t- 欠員が出れば順次
- 全世代に知って欲しい
\t- 親にも知って欲しい（オヤカク）
\t- SNSに特化していくのか、全般でやっていくのか

【冨永議事録】
2026.04.15.

◆Lumaの映像
- HPで映像掲載頂いている
- 地元の映画館で流すコマーシャルとしても使用いただいている
- デモとしても流していただいている
- ショート動画にも編集して活用中

◆採用のご状況
- 中途メイン
\t- 計画は立てていない
\t- 随時採用（病人・欠員が出たときに）

◆課題
- 一般認知を上げていく
\t- 会社の存在を知ってもらう
\t- 映画館でCM流すという施策も
- 施策の持続性
\t→専任がいない（ノウハウがない）

◆質問
- AI画像の生成だけ依頼することは可能か？
- ECサイトの立ち上げ
\t→素材必要
\t→カタログからデータを抜き取ってくる

◆ネクストアクション
- 提案
\t→Appendix的にECサイトの件も追加しておく
- Lumaの SNS運用プランと外部広報人事を組み合わせて提案
- SNS広告のバナー

◆TODO
- 提案資料→ぺぇ
- 外部広報人事の提携先→れん
- EC周りの企画(SNSバナー広告)→れん
\t⇒4/20(月)9:00〜 営業定例ですり合わせ`,
      },
      {
        kind: "2回目",
        minutes: `- SNS興味とEC画像はリアクション良かった
\t- 懸念
\t\t- 予算
\t\t- 社員を出した発信
\t\t- 企画作れるかどうか`,
      },
    ],
  },
  {
    notionPageId: "33d35f9288f3808085f5c5a074f3bd80",
    notionUrl: "https://app.notion.com/p/33d35f9288f3808085f5c5a074f3bd80",
    companyName: "g-wic",
    meetingDate: "2026-04-09",
    sections: [],
  },
  {
    notionPageId: "33d35f9288f380fd8ee7db04b44abadd",
    notionUrl: "https://app.notion.com/p/33d35f9288f380fd8ee7db04b44abadd",
    companyName: "Allegro株式会社",
    meetingDate: "2026-04-09",
    sections: [],
  },
  {
    notionPageId: "33735f9288f38086b930f966e83d0f0a",
    notionUrl: "https://app.notion.com/p/33735f9288f38086b930f966e83d0f0a",
    companyName: "オオヨドコーポレーション",
    meetingDate: "2026-01-21",
    sections: [
      {
        kind: "初回",
        minutes: `① https://oyodo-co.jp/
② https://www.seven-three.co.jp/
③ https://oyodo-ptex.com/

上記グループ3社のHP刷新＆動画制作`,
      },
    ],
  },
];

// ============================================================
// 議事録セクションが「実質空」かどうか判定
// ============================================================
function isMeaningfulMinutes(text: string): boolean {
  const stripped = text
    .replace(/<empty-block\s*\/?>/g, "")
    .replace(/<meeting-notes[\s\S]*?<\/meeting-notes>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return stripped.length >= 10; // 最低限の長さ
}

async function main() {
  console.log("[import-notion-minutes] start");
  console.log(`[import-notion-minutes] DB: ${connectionString}`);
  console.log(`[import-notion-minutes] pages: ${PAGES.length}`);
  console.log("");

  let withMinutes = 0;
  let withoutMinutes = 0;
  let noDeal = 0;
  let createdMeetings = 0;
  let updatedMeetings = 0;
  const breakdown: { company: string; result: string; sections?: number }[] = [];

  for (const page of PAGES) {
    const validSections = page.sections.filter((s) => isMeaningfulMinutes(s.minutes));

    if (validSections.length === 0) {
      withoutMinutes++;
      breakdown.push({ company: page.companyName, result: "議事録なし（スキップ）" });
      console.log(`  [skip] ${page.companyName}: 議事録本文なし`);
      continue;
    }
    withMinutes++;

    // Company を name で引く
    const company = await prisma.company.findFirst({
      where: { name: page.companyName },
      select: { id: true, name: true },
    });
    if (!company) {
      breakdown.push({ company: page.companyName, result: "Company未登録（スキップ）" });
      console.log(`  [skip] ${page.companyName}: Company が DB に無い`);
      continue;
    }

    // 該当 Company の Deal を1件選択（1企業=1Dealになったので最も古いものを取る）
    let deal = await prisma.deal.findFirst({
      where: { companyId: company.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true },
    });

    // Deal が無い場合：議事録だけあって紐付け先が無いと参照できなくなるため、
    // 「ネタ」相当の LEAD Deal を自動生成する
    if (!deal) {
      const defaultOwner = await prisma.user.findFirst({
        where: { email: "teppei.miyake@luma-create.com" },
        select: { id: true },
      });
      const created = await prisma.deal.create({
        data: {
          companyId: company.id,
          title: `${company.name}様向け 提案（議事録ベース仮案件）`,
          status: "LEAD",
          pipelineStage: "【商談後】企画中",
          ownerUserId: defaultOwner?.id ?? null,
          products: {
            create: {
              productName: "採用コンサル",
              planName: "スタンダード",
              probability: 20,
              yomiStatus: "ネタ",
              ownerUserId: defaultOwner?.id ?? null,
            },
          },
        },
        select: { id: true, title: true },
      });
      deal = created;
      noDeal++;
      console.log(
        `  [auto-deal] ${page.companyName}: Deal が無いため LEAD/採用コンサル を自動生成`,
      );
    }

    // 各セクションを Meeting として upsert
    for (const sec of validSections) {
      const meta = {
        source: "notion" as const,
        notionPageId: page.notionPageId,
        notionUrl: page.notionUrl,
        section: sec.kind,
        importedAt: new Date().toISOString(),
      };
      const title = `Notion議事録（${sec.kind}商談）`;
      // 同じ source + section の Meeting があれば update、無ければ create
      // meta は JSON カラムなので path 指定で検索
      const existing = await prisma.meeting.findFirst({
        where: {
          dealId: deal.id,
          AND: [
            { meta: { path: ["notionPageId"], equals: page.notionPageId } },
            { meta: { path: ["section"], equals: sec.kind } },
          ],
        },
        select: { id: true },
      });

      if (existing) {
        await prisma.meeting.update({
          where: { id: existing.id },
          data: {
            title,
            minutes: sec.minutes,
            meetingDate: new Date(`${page.meetingDate}T10:00:00+09:00`),
            meta,
          },
        });
        updatedMeetings++;
        console.log(
          `  [update] ${page.companyName} (${deal.title}) - ${sec.kind}商談 (${sec.minutes.length}文字)`,
        );
      } else {
        await prisma.meeting.create({
          data: {
            dealId: deal.id,
            title,
            minutes: sec.minutes,
            meetingDate: new Date(`${page.meetingDate}T10:00:00+09:00`),
            meta,
          },
        });
        createdMeetings++;
        console.log(
          `  [create] ${page.companyName} (${deal.title}) - ${sec.kind}商談 (${sec.minutes.length}文字)`,
        );
      }
    }

    breakdown.push({
      company: page.companyName,
      result: "投入完了",
      sections: validSections.length,
    });
  }

  console.log("");
  console.log("[import-notion-minutes] done");
  console.log(`  Notionページ総数:        ${PAGES.length}`);
  console.log(`  議事録ありページ:        ${withMinutes}`);
  console.log(`  議事録なしページ:        ${withoutMinutes}`);
  console.log(`  Deal未作成スキップ:      ${noDeal}`);
  console.log(`  Meeting 新規作成:        ${createdMeetings}`);
  console.log(`  Meeting 更新（再実行）:  ${updatedMeetings}`);
  console.log("");
  console.log("[breakdown]");
  for (const b of breakdown) {
    const sec = b.sections ? ` (${b.sections}セクション)` : "";
    console.log(`  ${b.company}: ${b.result}${sec}`);
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
