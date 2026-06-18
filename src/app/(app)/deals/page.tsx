import { Header } from "@/components/layout/header";
import { DealsTable } from "@/components/dashboard/deals-table";
import { NewDealDialog } from "@/components/deals/new-deal-dialog";
import { OwnerTabs } from "@/components/deals/owner-tabs";
import { PhaseTabs } from "@/components/deals/phase-tabs";
import { WonCategoryTabs } from "@/components/deals/won-category-tabs";
import { ProductFilter } from "@/components/deals/product-filter";
import { SortFilter } from "@/components/deals/sort-filter";
import { YomiFilter } from "@/components/deals/yomi-filter";
import {
  YOMI_FILTER_VALUES,
  DEFAULT_YOMI_VALUES,
  expandYomiValues,
  type YomiFilterValue,
} from "@/components/deals/yomi-filter-config";
import { prisma } from "@/lib/db";
import { getSalesUsers } from "@/lib/queries";
import { getSession, hasPermission } from "@/lib/auth";
import {
  totalProposedAmount,
  dealYomiRank,
  type DealProductLite,
} from "@/lib/deal-aggregations";
import { isWonYomi } from "@/lib/yomi-status";
import { categoryFromDealProduct } from "@/lib/product-categories";

export const dynamic = "force-dynamic";

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{
    owner?: string;
    product?: string;
    sort?: string;
    yomi?: string;
    phase?: string;
    cat?: string;
  }>;
}) {
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const canEdit = hasPermission(me?.permission, "user");
  const sp = await searchParams;
  const ownerParam = sp.owner ?? "all";
  const productParam = sp.product ?? null;
  const sortParam = sp.sort ?? "next";
  // 受注前(pre) / 受注後(won) フェーズタブ。デフォルトは受注前。
  const phaseParam = sp.phase === "won" ? "won" : "pre";
  // 受注後タブ内の受注商材サブタブ。"all" or 映像/SNS/CATV/アライアンス。
  const WON_CATEGORIES = ["映像", "SNS", "CATV", "アライアンス"] as const;
  const catParam =
    sp.cat && (WON_CATEGORIES as readonly string[]).includes(sp.cat) ? sp.cat : "all";
  // ヨミフィルタ：
  // - `sp.yomi === undefined`（クエリ無し）→ デフォルト = DEFAULT_YOMI_VALUES
  //   （A+ヨミ/Aヨミ/Bヨミ/Cヨミ の4種。ネタ/NG/受注は受注確度フォーカス運用のため初期非表示）
  // - クエリ有り → 値を解釈（空文字や全て無効値の場合は「全件」=フィルタ無効）
  // ※ ヨミは7段階の独立区分（受注/A+ヨミ/Aヨミ/Bヨミ/Cヨミ/ネタ/NG）。各バッジは個別にトグルする
  // ※「すべて」ボタンは NG/ネタ/C/B/A/A+/受注 を全選択した URL を生成する（手動全件表示）
  const yomiParamRaw = sp.yomi;
  let yomiSelected: YomiFilterValue[];
  if (yomiParamRaw === undefined) {
    yomiSelected = DEFAULT_YOMI_VALUES;
  } else {
    yomiSelected = yomiParamRaw
      .split(",")
      .map((v) => v.trim())
      .filter((v): v is YomiFilterValue =>
        (YOMI_FILTER_VALUES as readonly string[]).includes(v),
      );
  }
  const yomiExpanded = yomiSelected.length > 0 ? expandYomiValues(yomiSelected) : null;
  const ownerUserId =
    ownerParam === "me"
      ? session?.userId
      : ownerParam === "all"
        ? undefined
        : ownerParam;

  // owner: 商談（Deal）の担当者 = Deal.ownerUserId に一致
  //   ※以前は OR で DealProduct.ownerUserId も含めていたが、現状 DealProduct.ownerUserId が
  //     全件 三宅哲平（Notion取り込み時の既定値）に固定されており、その OR 条件が
  //     「全商談ヒット」になって三宅のフィルターボタンが無反応になっていた（2026-06 社長報告）。
  //     商談一覧の担当者フィルタは商談オーナー（Deal.ownerUserId）で判定する。
  // product: DealProduct.productName に一致するものが少なくとも1件
  // yomi: DealProduct.yomiStatus が指定されたヨミ値（接頭辞展開後）のいずれかに一致
  //       product / yomi は AND（同一 DealProduct で全条件を満たす必要は無く、
  //       それぞれ「少なくとも1件」存在すればよい運用とする）
  const productConditions: Array<{
    products: { some: Record<string, unknown> };
  }> = [];
  if (productParam) {
    productConditions.push({ products: { some: { productName: productParam } } });
  }
  if (yomiExpanded) {
    productConditions.push({ products: { some: { yomiStatus: { in: yomiExpanded } } } });
  }

  const where = {
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(productConditions.length > 0 ? { AND: productConditions } : {}),
    deletedAt: null,
    company: { deletedAt: null },
  };

  const [users, deals, productGroups] = await Promise.all([
    getSalesUsers(),
    prisma.deal.findMany({
      where,
      include: {
        company: true,
        owner: { select: { id: true, name: true, avatarColor: true } },
        leadSource: { select: { id: true, name: true } },
        products: true,
        _count: { select: { tasks: true } },
      },
      // DBでのソートはまずupdatedAt/nextActionAtのみ。
      // 集計ベースの並び（金額・確度・期日）はメモリ側で行う。
      orderBy: [{ nextActionAt: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.dealProduct.groupBy({
      by: ["productName"],
      where: {
        // 商品フィルタの選択肢件数も、担当者は商談オーナー（Deal.ownerUserId）で集計を揃える
        deal: {
          ...(ownerUserId ? { ownerUserId } : {}),
          deletedAt: null,
          company: { deletedAt: null },
        },
      },
      _count: { _all: true },
      orderBy: { _count: { productName: "desc" } },
    }),
  ]);

  // メモリ上でソート（集計値ベース）
  const sortedDeals = [...deals];
  switch (sortParam) {
    case "yomi_desc":
      // ヨミ順：受注 > A+ヨミ > Aヨミ > Bヨミ > Cヨミ > ネタ > NG（降順）
      sortedDeals.sort(
        (a, b) =>
          dealYomiRank(b.products as DealProductLite[]) -
          dealYomiRank(a.products as DealProductLite[]),
      );
      break;
    case "close_asc":
      sortedDeals.sort((a, b) => {
        const ax = a.expectedCloseDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bx = b.expectedCloseDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return ax - bx;
      });
      break;
    case "total_desc":
      sortedDeals.sort(
        (a, b) =>
          totalProposedAmount(b.products as DealProductLite[]) -
          totalProposedAmount(a.products as DealProductLite[]),
      );
      break;
    case "updated_desc":
      sortedDeals.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      break;
    default: // "next"
      // 既にDBでnextActionAt asc, updatedAt desc になっている
      break;
  }

  // ---- 受注前 / 受注後 フェーズ振り分け ----
  // 受注後 = 配下 DealProduct のいずれかが isWonYomi。受注前 = それ以外。
  // （isWonYomi は接頭辞除去を伴うため Prisma where では表現せずメモリ側で判定）
  type DealWithProducts = (typeof sortedDeals)[number];
  const isWonDeal = (d: DealWithProducts) =>
    d.products.some((p) => isWonYomi(p.yomiStatus));

  const preDeals = sortedDeals.filter((d) => !isWonDeal(d));
  const wonDeals = sortedDeals.filter((d) => isWonDeal(d));

  // 受注後タブの受注商材カテゴリ判定。
  // PMボードと同じ粒度：映像/SNS/CATV と、それ以外（未分類含む）= アライアンス。
  // 「その企業がどの商材を受注したか」は、受注(isWonYomi)の DealProduct のみで判定する。
  const wonCategoriesOf = (d: DealWithProducts): Set<string> => {
    const set = new Set<string>();
    for (const p of d.products) {
      if (!isWonYomi(p.yomiStatus)) continue;
      const cat = categoryFromDealProduct(p);
      // 映像/SNS/CATV 以外（null 含む）は「アライアンス」に寄せる（PMボードと統一）
      set.add(cat === "映像" || cat === "SNS" || cat === "CATV" ? cat : "アライアンス");
    }
    return set;
  };

  // 受注後タブの各サブタブ件数（複数受注は各カテゴリにカウント）
  const wonCatCounts: Record<string, number> = { all: wonDeals.length };
  for (const c of WON_CATEGORIES) wonCatCounts[c] = 0;
  for (const d of wonDeals) {
    for (const c of wonCategoriesOf(d)) {
      wonCatCounts[c] = (wonCatCounts[c] ?? 0) + 1;
    }
  }

  // 表示対象を確定
  let visibleDeals: DealWithProducts[];
  if (phaseParam === "won") {
    visibleDeals =
      catParam === "all"
        ? wonDeals
        : wonDeals.filter((d) => wonCategoriesOf(d).has(catParam));
  } else {
    visibleDeals = preDeals;
  }

  const products = productGroups.map((p) => ({ name: p.productName, count: p._count._all }));

  // 商談詳細→「商談一覧」戻りリンク用に、現在のフィルタ/並びをクエリ文字列で持ち回す。
  // `?yomi=` が省略されていてもデフォルト4種を意図したフィルタ状態として明示的にエンコードする。
  // 受け側 deals/[id]/page.tsx で `from` をそのまま `/deals?<from>` に展開する。
  const backQueryParams = new URLSearchParams();
  if (ownerParam !== "all") backQueryParams.set("owner", ownerParam);
  if (productParam) backQueryParams.set("product", productParam);
  if (sortParam !== "next") backQueryParams.set("sort", sortParam);
  if (yomiSelected.length > 0) backQueryParams.set("yomi", yomiSelected.join(","));
  if (phaseParam === "won") backQueryParams.set("phase", "won");
  if (phaseParam === "won" && catParam !== "all") backQueryParams.set("cat", catParam);
  const linkQuery = backQueryParams.toString();

  const tableTitle =
    phaseParam === "won"
      ? `受注後${catParam === "all" ? "" : `・${catParam}`} (${visibleDeals.length}件)`
      : `受注前 (${visibleDeals.length}件)`;

  return (
    <>
      <Header
        title="商談一覧"
        subtitle={`${visibleDeals.length} 件 / 全 ${deals.length} 件（企業単位）`}
        right={<NewDealDialog />}
      />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white space-y-3">
        <PhaseTabs selected={phaseParam} preCount={preDeals.length} wonCount={wonDeals.length} />
        {phaseParam === "won" && (
          <WonCategoryTabs selected={catParam} counts={wonCatCounts} />
        )}
        <OwnerTabs users={users} currentUserId={session?.userId ?? ""} selected={ownerParam} />
        <ProductFilter products={products} selected={productParam} />
        <YomiFilter selected={yomiSelected} />
        <SortFilter selected={sortParam} />
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <DealsTable
          deals={visibleDeals}
          title={tableTitle}
          showAllLink={false}
          canDelete={canEdit}
          editable={canEdit}
          linkQuery={linkQuery}
        />
      </div>
    </>
  );
}
