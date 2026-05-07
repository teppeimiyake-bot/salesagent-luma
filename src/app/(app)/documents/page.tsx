import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentList } from "@/components/documents/document-list";
import { DocumentsTabs } from "@/components/documents/documents-tabs";
import { KnowledgeSearch } from "@/components/documents/knowledge-search";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 3カテゴリ分類ルール
// knowledge = 導入事例 / テンプレ / その他（社内ナレッジ全般）
// contract  = 契約書（admin のみアップロード可）
// proposal  = 提案書
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

  const tab = (["knowledge", "contract", "proposal"] as const).includes(
    (sp.tab ?? "knowledge") as "knowledge" | "contract" | "proposal",
  )
    ? ((sp.tab ?? "knowledge") as "knowledge" | "contract" | "proposal")
    : "knowledge";

  const docs = await prisma.document.findMany({
    where: { scope: "global" },
    orderBy: [{ category: "asc" }, { createdAt: "desc" }],
    include: { uploadedBy: { select: { id: true, name: true } } },
  });

  const filtered = docs.filter((d) => TAB_FILTERS[tab](d.category));
  const counts = {
    knowledge: docs.filter((d) => TAB_FILTERS.knowledge(d.category)).length,
    contract: docs.filter((d) => TAB_FILTERS.contract(d.category)).length,
    proposal: docs.filter((d) => TAB_FILTERS.proposal(d.category)).length,
  };

  return (
    <>
      <Header
        title="ナレッジ・契約書・提案書"
        subtitle={`全社共通 ${docs.length} 件`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50 space-y-5">
        <KnowledgeSearch />
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
