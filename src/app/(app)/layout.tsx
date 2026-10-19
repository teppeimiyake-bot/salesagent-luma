import { redirect } from "next/navigation";
import { getCurrentPermission, getSession } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { prisma } from "@/lib/db";
import { listMyTenants, getRequestTenant } from "@/lib/tenant-context";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await getSession();
  if (!s) redirect("/login");
  const [profile, tenants, ctx, tenantPermission] = await Promise.all([
    prisma.user.findUnique({
      where: { id: s.userId },
      select: { id: true, name: true, email: true, avatarColor: true, avatarUrl: true },
    }),
    listMyTenants(),
    getRequestTenant(),
    getCurrentPermission(),
  ]);
  // サイドバーの権限表示・管理メニューは、操作中の会社での権限（全社共通の User.permission ではない）。
  // 全社統合ビューは閲覧のみ。
  const user = profile ? { ...profile, permission: tenantPermission ?? "viewer" } : null;
  return (
    // data-tenant で画面全体の基調色が切り替わる（globals.css の末尾を参照）。
    // Luma=オレンジ / リージー=緑。全社ビューは Luma の色のまま（合算表示のため）。
    <div className="flex h-screen overflow-hidden bg-zinc-50" data-tenant={ctx?.code ?? "luma"}>
      <Sidebar
        user={user}
        tenants={tenants}
        activeTenantCode={ctx?.code ?? tenants[0]?.code ?? "luma"}
        // 全社タブは cross_tenant_read を持ち、かつ2社以上に所属している人だけ
        canViewAllTenants={tenants.some((t) => t.crossTenantRead) && tenants.length > 1}
        // T17: 見積テンプレート管理は見積書PDF v2 のフラグがONのときだけメニューに出す
        quoteTemplatesEnabled={isQuotePdfV2Enabled()}
      />
      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
    </div>
  );
}
