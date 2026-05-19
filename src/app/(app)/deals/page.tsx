import { Header } from "@/components/layout/header";
import { DealsTable } from "@/components/dashboard/deals-table";
import { NewDealDialog } from "@/components/deals/new-deal-dialog";
import { OwnerTabs } from "@/components/deals/owner-tabs";
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

export const dynamic = "force-dynamic";

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{
    owner?: string;
    product?: string;
    sort?: string;
    yomi?: string;
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

  // owner: Deal.ownerUserId または DealProduct.ownerUserId のどちらかに一致
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
    ...(ownerUserId
      ? {
          OR: [
            { ownerUserId },
            { products: { some: { ownerUserId } } },
          ],
        }
      : {}),
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
        ...(ownerUserId
          ? {
              OR: [
                { ownerUserId },
                { deal: { ownerUserId } },
              ],
            }
          : {}),
        deal: { deletedAt: null, company: { deletedAt: null } },
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

  const products = productGroups.map((p) => ({ name: p.productName, count: p._count._all }));

  // 商談詳細→「商談一覧」戻りリンク用に、現在のフィルタ/並びをクエリ文字列で持ち回す。
  // `?yomi=` が省略されていてもデフォルト4種を意図したフィルタ状態として明示的にエンコードする。
  // 受け側 deals/[id]/page.tsx で `from` をそのまま `/deals?<from>` に展開する。
  const backQueryParams = new URLSearchParams();
  if (ownerParam !== "all") backQueryParams.set("owner", ownerParam);
  if (productParam) backQueryParams.set("product", productParam);
  if (sortParam !== "next") backQueryParams.set("sort", sortParam);
  if (yomiSelected.length > 0) backQueryParams.set("yomi", yomiSelected.join(","));
  const linkQuery = backQueryParams.toString();

  return (
    <>
      <Header title="商談一覧" subtitle={`${deals.length} 件（企業単位）`} right={<NewDealDialog />} />
      <div className="px-8 py-3 border-b border-zinc-200 bg-white space-y-3">
        <OwnerTabs users={users} currentUserId={session?.userId ?? ""} selected={ownerParam} />
        <ProductFilter products={products} selected={productParam} />
        <YomiFilter selected={yomiSelected} />
        <SortFilter selected={sortParam} />
      </div>
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <DealsTable
          deals={sortedDeals}
          title={`商談 (${deals.length}件)`}
          showAllLink={false}
          canDelete={canEdit}
          editable={canEdit}
          linkQuery={linkQuery}
        />
      </div>
    </>
  );
}
