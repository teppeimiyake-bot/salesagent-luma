import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { prisma } from "@/lib/db";
import { listMyTenants, getRequestTenant } from "@/lib/tenant-context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const s = await getSession();
  if (!s) redirect("/login");
  const [user, tenants, ctx] = await Promise.all([
    prisma.user.findUnique({
      where: { id: s.userId },
      select: { id: true, name: true, email: true, avatarColor: true, avatarUrl: true, permission: true },
    }),
    listMyTenants(),
    getRequestTenant(),
  ]);
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
      />
      <div className="flex-1 flex flex-col overflow-hidden">{children}</div>
    </div>
  );
}
