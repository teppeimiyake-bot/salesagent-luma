import { LUMA_VALUE_PROPOSITION } from "@/lib/ai/luma-value-proposition";
import { currentTenant, getRequestTenant, type TenantCtx } from "@/lib/tenant-context";

const CACHE_TTL_MS = 3 * 60 * 1000;

/**
 * Sonnet 4.6 のプロンプトキャッシュ下限は 1024 トークン。
 * カタログ本文だけだと約 250 トークンで黙って無効になるため、
 * 全プロンプト共通の使い方を同じキャッシュ対象に含める。
 */
export const MIN_LUMA_CACHE_PREFIX_CHARS = 1800;

export const LUMA_CONTEXT_USAGE_RULES = `
# 商材コンテキストの使い方（全タスク共通）
このブロックは議事録生成・BANT集約・事前準備リサーチで同じものを使う。タスク固有の出力形式は、このブロックの外の system に従う。

## 名前
- 商材名・プラン名・企画型は、このコンテキストと案件の提案中商材に書かれた実在名だけを使う。ここに無い商品名を作らない。
- 「映像」「動画」「SNS」だけのような短縮名で済ませない。カタログまたは提案中商材の正式名を使う。例: 採用動画、会社紹介動画、商品PR動画、SNS運用代行（6ヶ月）、スポット制作、CM枠出稿。
- 現在の商材提案で使ってよい正式名は、案件の提案中商材またはカタログに実在する採用動画、会社紹介動画、商品PR動画、SNS運用代行（6ヶ月）、スポット制作、CM枠出稿だけ。カタログが更新された場合も、その時点で実在する正式名だけを使う。
- 新商品X、オリジナル企画、独自パッケージのような invent した名前は使わない。マスタに無いサービスをLumaの提供物として書かない。
- 案件の提案中商材があるときは、それを提案の中心に置く。カタログは代替案や補強に使う。

## 価格と見積
- 価格は基準価格を言い方の目安にする。「80万円前後」「目安」はよい。確定見積、値引き率、他社より安い、という断定はしない。
- 見積の基本内訳は初期費用／映像制作費／映像素材費／撮影交通費。案件によりキャスティングやナレーションが加わる、とだけ述べる。
- 基準価格が未設定のプランは、金額を推測して埋めない。

## 事実と仮説
- 公開情報で裏付けできない事実は「確認できず」と書く。推測は仮説と明示し、事実と混ぜない。
- 出典URLが無い事実文は書かない。仮説には確度（high / medium / low）を付ける。
- 統計は出典ページに書かれた母集団・対象業種・企業規模のまま使う。全業種や全企業の数字を、食品・菓子メーカー固有の数字に狭めない。
- 公開情報の倍率・割合・人数・金額・日付・期間は、引用する出典URLでその値自体を確認できる場合だけ事実として書く。社内情報の数値・日付は、議事録などに同じ値が明記されている場合だけ事実として書く。どちらでも確認できなければ「確認できず」と書くか削除する。
- 顧客の社内データ（議事録、BANT、商談メモ）は社内根拠として使ってよい。それを公開事実のように装わない。
- 議事録の事実から、書かれていない因果関係や人物の内心を作らない。因果は仮説として扱い、人事部長などの未確認の認識・意図は確認論点に回す。
- 議事録に無い精度の日付・期間を引用扱いしない。「次年度新卒採用開始前」を根拠なく「約4ヶ月後」に変換しない。マスタにも議事録にも無い制作期間（例: 目安8週間）を作らない。不明なら「制作期間は未確定」とする。
- 架空の企業名・採用媒体の掲載有無・従業員数を、コンテキストや案件データに無いのに断定しない。

## 提案の範囲
- Lumaの提案領域は採用向けの映像制作とSNSコンテンツである。採用広報、応募前理解、現場の雰囲気伝達に効く言い方にする。
- 無関係な商材（採用管理システム、求人広告代理、人事制度コンサル等）をLumaの本業のように書かない。
- 効果イメージは仮説として書く。出典の無い「エントリーが増える傾向」「離職が下がる」を事実にせず、KPIを捏造しない。
- 採用サイトリニューアルの同期設計・スケジュール管理、役員会向けROI資料の共同作成は、現行マスタに無いのでLumaの提供機能として断定しない。必要なら実施可否の確認論点に回す。
## 言い換えの例
- 悪い例: 「映像で採用を強化します」。良い例: 「採用動画で、現場の雰囲気を応募前に伝えます」。
- 悪い例: 「独自の新パッケージA」。良い例: 提案中商材が採用動画なら「採用動画」、SNS運用代行があるならその正式名。
- 悪い例: 「制作費は確実に80万円です」。良い例: 「採用動画の基準価格はマスタ上 800,000円なので、目安として80万円前後と伝え、確定は見積で確認する」。
- 悪い例: 「マイナビに掲載している」。掲載がコンテキストにも案件データにも無いなら「確認できず」。
- 悪い例: 全業種の従業員300人未満企業の求人倍率を「食品・菓子メーカーの求人倍率」と狭める。良い例: 出典どおり「全業種の従業員300人未満企業」と書く。
- 悪い例: 出典URLで確認できない3.05倍・1.33倍や、議事録に無い約4ヶ月後、マスタに無い「制作期間（目安8週間）」を事実・引用として書く。良い例: 公開数値はURL、社内数値は議事録で同じ値を確認し、確認できなければ「確認できず」または具体値を省く。制作期間がマスタに無ければ未確定と書く。
- 悪い例: 「動画が古いことが応募30%減の原因」「人事部長はナビ出稿では解決しないと考えている」。良い例: 因果は仮説、内心は確認論点にする。
- 悪い例: 「動画掲載企業はエントリーが増える傾向」「採用動画で離職率が下がる」と出典なしで断定する。良い例: 効果仮説として商談で確認する。
- 悪い例: 「Lumaは採用サイトとの同期スケジュール管理や役員会向けROI資料作成を提供する」。良い例: マスタに無い支援は実施可否の確認論点にする。
- 議事録では、顧客が言っていない商材効果を決定事項にしない。BANTでは手修正項目を断定で上書きする文を作らない。事前準備では出典のない業界断定を本文に置かない。
- 提案ストーリーを書くときは、つかみ・課題共感・商材提案・効果イメージ・確認論点の流れでも、商材提案の見出し内に実在商材名を1つ以上入れる。効果は仮説として書き、数値KPIを捏造しない。
- 会社紹介動画と採用動画は別プランである。混同して「紹介動画兼採用動画」のようなマスタに無い束ね方を、確定提案として書かない。SNS運用代行（6ヶ月）とスポット制作も別プランとして扱う。
`.trim();

export type LumaContextProductPlan = {
  name: string;
  basePrice: number | null;
  description?: string | null;
  sortOrder?: number | null;
};

export type LumaContextProduct = {
  name: string;
  description?: string | null;
  plans?: LumaContextProductPlan[];
};

export type LumaContextPlanProposal = {
  name: string;
  displayOrder?: number | null;
};

export type LumaContextDealProduct =
  | string
  | {
      productName?: string | null;
      planName?: string | null;
      planProposals?: string[] | null;
      yomiStatus?: string | null;
      amount?: number | null;
    };

export type FormatLumaContextInput = {
  products: LumaContextProduct[];
  proposals: LumaContextPlanProposal[];
  dealProducts?: LumaContextDealProduct[];
  valueProposition?: string;
};

type CachedLumaContext = {
  expiresAt: number;
  text: string;
};

// 商材マスタはテナント所有データ。キャッシュを共有すると、別テナント（検証用の空カタログ等）の
// 内容が他社の生成に混入し、事前準備が「商材未登録」と誤判定する。テナントIDごとに分け、
// テナント不明・全社ビューではキャッシュを使わない。
const cachedCatalogTextByTenant = new Map<string, CachedLumaContext>();
const latestContextTextByTenant = new Map<string, string>();

function tenantCacheKey(ctx: TenantCtx | null | undefined): string | null {
  return ctx && !ctx.crossTenant && ctx.tenantId ? ctx.tenantId : null;
}

function trimOneLine(value: string | null | undefined, max = 120): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatPrice(value: number | null | undefined): string {
  if (value == null) return "基準価格未設定";
  return `基準価格 ${value.toLocaleString("ja-JP")}円`;
}

function sortProducts(products: LumaContextProduct[]): LumaContextProduct[] {
  return [...products].sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

function sortPlans(plans: LumaContextProductPlan[] = []): LumaContextProductPlan[] {
  return [...plans].sort((a, b) => {
    const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return order || a.name.localeCompare(b.name, "ja");
  });
}

function sortProposals(proposals: LumaContextPlanProposal[]): LumaContextPlanProposal[] {
  return [...proposals].sort((a, b) => {
    const order = (a.displayOrder ?? 0) - (b.displayOrder ?? 0);
    return order || a.name.localeCompare(b.name, "ja");
  });
}

function formatProductCatalog(products: LumaContextProduct[]): string {
  const sortedProducts = sortProducts(products);
  if (sortedProducts.length === 0) return "商材マスタ未登録";

  return sortedProducts
    .map((product) => {
      const productDescription = trimOneLine(product.description);
      const planLines = sortPlans(product.plans)
        .map((plan) => {
          const planDescription = trimOneLine(plan.description);
          return `  - ${plan.name} / ${formatPrice(plan.basePrice)}${planDescription ? ` / ${planDescription}` : ""}`;
        })
        .join("\n");
      const header = `- ${product.name}${productDescription ? ` / ${productDescription}` : ""}`;
      return planLines ? `${header}\n${planLines}` : `${header}\n  - プラン未登録`;
    })
    .join("\n");
}

function formatPlanProposals(proposals: LumaContextPlanProposal[]): string {
  const sorted = sortProposals(proposals);
  if (sorted.length === 0) return "企画型マスタ未登録";
  return sorted.map((proposal) => `- ${proposal.name}`).join("\n");
}

function formatDealProduct(product: LumaContextDealProduct): string {
  if (typeof product === "string") return product.trim();
  const parts = [
    product.productName,
    product.planName ? `プラン=${product.planName}` : "",
    product.planProposals?.length ? `企画型=${product.planProposals.join(", ")}` : "",
    product.yomiStatus ? `ヨミ=${product.yomiStatus}` : "",
    product.amount != null ? `金額=${product.amount.toLocaleString("ja-JP")}円` : "",
  ].filter((part): part is string => !!part && part.trim().length > 0);
  return parts.join(" / ");
}

function formatDealProducts(dealProducts: LumaContextDealProduct[] | undefined): string {
  const lines = dealProducts?.map(formatDealProduct).filter(Boolean) ?? [];
  if (lines.length === 0) return "未設定";
  return lines.map((line) => `- ${line}`).join("\n");
}

export function formatLumaContextText({
  products,
  proposals,
  dealProducts,
  valueProposition = LUMA_VALUE_PROPOSITION,
}: FormatLumaContextInput): string {
  return `
# Luma提供価値
${valueProposition.trim()}

# 商材カタログ
${formatProductCatalog(products)}

# 企画型一覧
${formatPlanProposals(proposals)}

${LUMA_CONTEXT_USAGE_RULES}

# この案件の提案中商材
${formatDealProducts(dealProducts)}
`.trim();
}

async function loadCatalogText(tenantKey: string | null): Promise<string> {
  const now = Date.now();
  const cached = tenantKey ? cachedCatalogTextByTenant.get(tenantKey) : undefined;
  if (cached && cached.expiresAt > now) {
    return cached.text;
  }

  const { prisma } = await import("@/lib/db");
  const [products, proposals] = await Promise.all([
    prisma.product.findMany({
      where: { active: true },
      orderBy: [{ name: "asc" }],
      select: {
        name: true,
        description: true,
        plans: {
          where: { active: true },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: {
            name: true,
            basePrice: true,
            description: true,
            sortOrder: true,
          },
        },
      },
    }),
    prisma.planProposal.findMany({
      where: { active: true },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      select: { name: true, displayOrder: true },
    }),
  ]);

  const text = formatLumaContextText({ products, proposals });
  if (tenantKey) {
    for (const [key, entry] of cachedCatalogTextByTenant) {
      if (entry.expiresAt <= now) cachedCatalogTextByTenant.delete(key);
    }
    cachedCatalogTextByTenant.set(tenantKey, { text, expiresAt: now + CACHE_TTL_MS });
  }
  return text;
}

export async function getLumaContextText(
  options: { dealProducts?: LumaContextDealProduct[] } = {},
): Promise<string> {
  // src/lib/db.ts と同じ順序で解決し、実際に読み込むテナントをキーにする。
  const tenantKey = tenantCacheKey(currentTenant() ?? (await getRequestTenant()));
  const catalogText = await loadCatalogText(tenantKey);
  const text = options.dealProducts?.length
    ? catalogText.replace(
        /# この案件の提案中商材[\s\S]*$/u,
        `# この案件の提案中商材\n${formatDealProducts(options.dealProducts)}`,
      )
    : catalogText;
  if (tenantKey) latestContextTextByTenant.set(tenantKey, text);
  return text;
}

/** 同期APIのため、明示的に張られたテナントコンテキストで読み込んだ分だけを返す。 */
export function getCachedLumaContextText(): string {
  const tenantKey = tenantCacheKey(currentTenant());
  return tenantKey ? latestContextTextByTenant.get(tenantKey) ?? "" : "";
}

export function formatLumaContextForPrompt(contextText: string): string {
  return `# Luma商材コンテキスト\n${contextText.trim()}`;
}

export function lumaContextMeetsCacheMinimum(contextText: string): boolean {
  return formatLumaContextForPrompt(contextText).length >= MIN_LUMA_CACHE_PREFIX_CHARS;
}
