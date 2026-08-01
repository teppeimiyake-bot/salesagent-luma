import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listMyTenants, getRequestTenant } from "@/lib/tenant-context";

/**
 * ログイン中のユーザーが所属する会社（テナント）一覧と、現在選択中の会社を返す。
 * 新規商談ダイアログの「登録先」セレクトなど、クライアント側の選択肢に使う。
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [tenants, ctx] = await Promise.all([listMyTenants(), getRequestTenant()]);
  return NextResponse.json({
    tenants: tenants.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      shortName: t.shortName,
      // viewer は登録できないので、選択肢から外せるようにフラグを返す
      canWrite: t.permission !== "viewer",
    })),
    // 全社ビュー中は tenantId が null。その場合クライアント側で明示選択させる
    activeTenantId: ctx?.tenantId ?? null,
    activeCode: ctx?.code ?? null,
  });
}
