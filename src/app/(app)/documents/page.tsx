import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentList } from "@/components/documents/document-list";
import { DocumentsTabs } from "@/components/documents/documents-tabs";
import { KnowledgeSearch } from "@/components/documents/knowledge-search";
import {
  IndividualProposalSearch,
  type IndividualProposal,
} from "@/components/documents/individual-proposal-search";
import {
  IndividualContractSearch,
  type IndividualContract,
} from "@/components/documents/individual-contract-search";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { buildIndustryOptions } from "@/lib/industry";
import { getFullyWonDealIds } from "@/lib/deal-status-server";

export const dynamic = "force-dynamic";

type TabKey = "knowledge" | "contract" | "proposal" | "plan" | "deal-contract";

// カテゴリ分類ルール
// knowledge = 導入事例 / テンプレ / その他（社内ナレッジ全般）
// contract  = 契約書（admin のみアップロード可）
// proposal  = 提案書（全社共通）
// plan      = 企画書（= 商談ごとの個別提案書を横断検索）
const TAB_FILTERS: Record<"knowledge" | "contract" | "proposal", (cat: string) => boolean> = {
  knowledge: (c) => c === "case_study" || c === "template" || c === "other" || c === "knowledge",
  contract: (c) => c === "contract",
  proposal: (c) => c === "proposal",
};

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const session = await getSession();
  const me = session
    ? await prisma.user.findUnique({
        where: { id: session.userId },
        select: { permission: true },
      })
    : null;
  const permission = me?.permission ?? "viewer";

  const tab: TabKey = (
    ["knowledge", "contract", "proposal", "plan", "deal-contract"] as const
  ).includes((sp.tab ?? "knowledge") as TabKey)
    ? ((sp.tab ?? "knowledge") as TabKey)
    : "knowledge";

  // 全社共通ドキュメント（ナレッジ / 契約書 / 提案書タブ用）
  const docs = await prisma.document.findMany({
    where: { scope: "global" },
    orderBy: [{ category: "asc" }, { createdAt: "desc" }],
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  // 企画書タブ＝個別提案書：商談ごとに登録された提案書ドキュメント（scope=deal / category=proposal）
  // 業界・社名は商談の顧客企業から、プロダクト（企画提案）は商談のプロダクト構成から取得
  const planDocs = await prisma.document.findMany({
    where: {
      scope: "deal",
      category: "proposal",
      deal: { is: { deletedAt: null } },
    },
    orderBy: { createdAt: "desc" },
    include: {
      uploadedBy: { select: { name: true } },
      deal: {
        select: {
          id: true,
          title: true,
          company: { select: { name: true, industry: true } },
          products: { select: { productName: true, planProposals: true } },
        },
      },
    },
  });

  const proposals: IndividualProposal[] = planDocs
    .filter((d) => d.deal !== null)
    .map((d) => {
      const deal = d.deal!;
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        fileUrl: d.fileUrl,
        sourceType: d.sourceType,
        version: d.version,
        createdAt: d.createdAt.toISOString(),
        uploadedByName: d.uploadedBy?.name ?? null,
        dealId: deal.id,
        dealTitle: deal.title,
        companyName: deal.company.name,
        industry: deal.company.industry,
        products: Array.from(
          new Set(deal.products.map((p) => p.productName).filter(Boolean)),
        ),
        planProposals: Array.from(
          new Set(deal.products.flatMap((p) => p.planProposals).filter(Boolean)),
        ),
      };
    });

  // 個別契約書タブ：商談ごとに登録された契約書ドキュメント（scope=deal / category=contract）。
  // 表示対象は「受注」ステータスの商談のみ。
  // 受注判定は商談一覧と同じロジックを流用：
  //   - Deal.status === "WON"（DealStatus enum の受注） … または
  //   - getFullyWonDealIds()（全 DealProduct.yomiStatus が 受注/締結済み = 完全受注）
  // どちらかを満たす商談を「受注企業」とみなす（取りこぼし防止のため OR 判定）。
  const fullyWonIds = await getFullyWonDealIds();
  const dealContractDocs = await prisma.document.findMany({
    where: {
      scope: "deal",
      category: "contract",
      deal: {
        is: {
          deletedAt: null,
          OR: [
            { status: "WON" },
            ...(fullyWonIds.length > 0 ? [{ id: { in: fullyWonIds } }] : []),
          ],
        },
      },
    },
    orderBy: { createdAt: "desc" },
    include: {
      uploadedBy: { select: { name: true } },
      deal: {
        select: {
          id: true,
          title: true,
          company: { select: { name: true, industry: true } },
        },
      },
    },
  });

  const dealContracts: IndividualContract[] = dealContractDocs
    .filter((d) => d.deal !== null)
    .map((d) => {
      const deal = d.deal!;
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        fileUrl: d.fileUrl,
        sourceType: d.sourceType,
        version: d.version,
        createdAt: d.createdAt.toISOString(),
        uploadedByName: d.uploadedBy?.name ?? null,
        dealId: deal.id,
        dealTitle: deal.title,
        companyName: deal.company.name,
        industry: deal.company.industry,
      };
    });

  // フィルター選択肢（実データに存在するものだけ）
  // industry は「,」区切りで複数業界を持ちうる。「,」で分割した個別業界をチップにする
  // （「・」は1業界名の一部なので分割しない）。件数降順→五十音順で並べる。
  const industries = buildIndustryOptions(proposals.map((p) => p.industry));
  const productOptions = Array.from(
    new Set(proposals.flatMap((p) => [...p.products, ...p.planProposals])),
  ).sort((a, b) => a.localeCompare(b, "ja"));
  // 個別契約書タブの業界選択肢（受注企業のみが対象）
  const contractIndustries = buildIndustryOptions(
    dealContracts.map((c) => c.industry),
  );

  // ナレッジ/契約書/提案書タブのみ全社共通ドキュメントを絞り込む。
  // plan / deal-contract タブは横断検索コンポーネントが自前でフィルターするため対象外。
  const filtered =
    tab === "knowledge" || tab === "contract" || tab === "proposal"
      ? docs.filter((d) => TAB_FILTERS[tab](d.category))
      : [];
  const counts: Record<TabKey, number> = {
    knowledge: docs.filter((d) => TAB_FILTERS.knowledge(d.category)).length,
    contract: docs.filter((d) => TAB_FILTERS.contract(d.category)).length,
    proposal: docs.filter((d) => TAB_FILTERS.proposal(d.category)).length,
    plan: proposals.length,
    "deal-contract": dealContracts.length,
  };

  return (
    <>
      <Header
        title="ナレッジ・契約書・提案書"
        subtitle={`全社共通 ${docs.length} 件 ／ 個別提案書 ${proposals.length} 件 ／ 個別契約書 ${dealContracts.length} 件`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50 space-y-5">
        {tab !== "plan" && tab !== "deal-contract" && <KnowledgeSearch />}
        <DocumentsTabs tab={tab} counts={counts} permission={permission} />

        {/* 選択中タブのドキュメント一覧 */}
        {tab === "knowledge" && (
          <KnowledgeSection
            docs={filtered}
            permission={permission}
          />
        )}
        {tab === "contract" && (
          <ContractSection docs={filtered} permission={permission} />
        )}
        {tab === "proposal" && (
          <ProposalSection docs={filtered} permission={permission} />
        )}
        {tab === "plan" && (
          <IndividualProposalSearch
            proposals={proposals}
            industries={industries}
            products={productOptions}
          />
        )}
        {tab === "deal-contract" && (
          <IndividualContractSearch
            contracts={dealContracts}
            industries={contractIndustries}
          />
        )}
      </div>
    </>
  );
}

type Doc = Awaited<ReturnType<typeof prisma.document.findMany>>[number] & {
  uploadedBy: { id: string; name: string } | null;
};

function SectionEmpty({
  label,
  hint,
}: {
  label: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="p-10 text-center text-base text-zinc-500">
        まだ{label}がありません。
        <br />
        <span className="text-xs">{hint}</span>
      </CardContent>
    </Card>
  );
}

function KnowledgeSection({ docs, permission }: { docs: Doc[]; permission: string }) {
  if (docs.length === 0)
    return (
      <SectionEmpty
        label="ナレッジ（導入事例・テンプレート等）"
        hint={
          permission === "viewer"
            ? "閲覧のみ権限のため、アップロードできません。"
            : "右上の「アップロード」から導入事例・テンプレートを追加してください。"
        }
      />
    );
  // カテゴリ別にグルーピング
  const grouped = docs.reduce<Record<string, Doc[]>>((acc, d) => {
    (acc[d.category] ??= []).push(d);
    return acc;
  }, {});
  const LABELS: Record<string, string> = {
    case_study: "導入事例",
    template: "テンプレート",
    other: "その他",
    knowledge: "社内ナレッジ",
  };
  return (
    <>
      {Object.entries(grouped).map(([cat, list]) => (
        <div key={cat}>
          <div className="flex items-center gap-2 mb-2 px-1">
            <h2 className="text-base font-bold text-zinc-700">{LABELS[cat] ?? cat}</h2>
            <Badge variant="secondary">{list.length}</Badge>
          </div>
          <Card>
            <CardContent className="p-0">
              <DocumentList docs={list} canEdit={permission !== "viewer"} />
            </CardContent>
          </Card>
        </div>
      ))}
    </>
  );
}

function ContractSection({ docs, permission }: { docs: Doc[]; permission: string }) {
  return (
    <>
      <div className="rounded-lg border border-red-200 bg-gradient-to-br from-red-50 to-rose-50 p-4 flex items-start gap-3">
        <Badge variant="danger">管理者専用</Badge>
        <div className="text-sm text-red-900 leading-relaxed">
          契約書は<strong>管理者のみアップロード・編集可能</strong>です。利用者・閲覧者はダウンロードのみ可能です。
        </div>
      </div>
      {docs.length === 0 ? (
        <SectionEmpty
          label="契約書"
          hint={
            permission === "admin"
              ? "右上の「アップロード」から契約書を追加してください（カテゴリ=契約書を選択）。"
              : "管理者にアップロードを依頼してください。"
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DocumentList
              docs={docs}
              canEdit={permission === "admin"}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ProposalSection({ docs, permission }: { docs: Doc[]; permission: string }) {
  return (
    <>
      {docs.length === 0 ? (
        <SectionEmpty
          label="提案書"
          hint={
            permission === "viewer"
              ? "閲覧のみ権限のため、アップロードできません。"
              : "右上の「アップロード」から提案書を追加してください（カテゴリ=提案書）。"
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DocumentList docs={docs} canEdit={permission !== "viewer"} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
