import { redirect } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProductsAdmin } from "@/components/admin/products-admin";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage() {
  const session = await getSession();
  const me = session ? await prisma.user.findUnique({ where: { id: session.userId } }) : null;
  if (!hasPermission(me?.permission, "admin")) redirect("/dashboard");

  const products = await prisma.product.findMany({
    orderBy: { name: "asc" },
    include: {
      plans: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });

  return (
    <>
      <Header
        title="カテゴリ管理"
        subtitle={`${products.length} 件 ／ 管理者のみ`}
      />
      <div className="flex-1 overflow-y-auto p-6 bg-zinc-50">
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-zinc-600 mb-4 inline-flex items-center gap-2">
              <Badge variant="danger">管理者専用</Badge>
              カテゴリ（旧プロダクト）と各プラン×ベース価格を管理。商談新規作成時の選択肢になります。
            </p>
            <ProductsAdmin initial={products} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
