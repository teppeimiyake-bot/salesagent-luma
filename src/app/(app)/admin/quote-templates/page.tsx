import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuoteTemplatesManager } from "@/components/admin/quote-templates-manager";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

/**
 * T17: 見積テンプレート管理（管理者のみ）
 *
 * これまでテンプレートは手動SQLでしか登録できなかった。ここから作成・編集できるようにする。
 * FEATURE_QUOTE_PDF_V2 がOFFのときは 404 にせず「未有効」の案内だけ出す
 * （管理者が設定の在り処を見失わないようにするため。APIは404のままなので操作はできない）。
 */
export default async function AdminQuoteTemplatesPage() {
  const session = await getSession();
  const me = session ? { permission: await getCurrentPermission() } : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const enabled = isQuotePdfV2Enabled();

  if (!enabled) {
    return (
      <>
        <Header title="見積テンプレート" subtitle="管理者のみ" />
        <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
          <Card className="border-zinc-200">
            <CardContent className="p-8">
              <p className="text-[15px] font-semibold text-zinc-900">この機能は未有効です</p>
              <p className="mt-2 text-sm text-zinc-600 leading-relaxed">
                見積テンプレートは見積書PDF v2（<code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">FEATURE_QUOTE_PDF_V2</code>）
                と一緒に動く機能です。環境変数を有効にすると、この画面からテンプレートの作成・編集ができるようになります。
              </p>
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  const [templates, products] = await Promise.all([
    prisma.quoteTemplate.findMany({
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.product.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return (
    <>
      <Header
        title="見積テンプレート"
        subtitle={`${templates.length} 件 ／ 管理者のみ`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card className="border-zinc-200">
          <CardContent className="p-6">
            <p className="text-[15px] text-zinc-600 mb-5 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              商談画面の「明細テンプレート」に出る雛形を管理します。過去に発行した見積には影響しません。
            </p>
            <QuoteTemplatesManager
              initial={templates.map((t) => ({
                id: t.id,
                name: t.name,
                productId: t.productId,
                planName: t.planName,
                active: t.active,
                sortOrder: t.sortOrder,
                lines: t.lines.map((l) => ({
                  name: l.name,
                  detail: l.detail,
                  qty: l.qty,
                  unit: l.unit,
                  unitPrice: l.unitPrice,
                  taxCategory: l.taxCategory === "non_taxable" ? "non_taxable" : "taxable",
                  taxRate: l.taxRate,
                })),
              }))}
              products={products}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
