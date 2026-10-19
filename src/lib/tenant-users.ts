/**
 * ユーザー（User）を、操作中の会社（テナント）に絞るための共通処理。
 * ------------------------------------------------------------
 * User は tenant_id を持たない（テナント所有モデルではない）ため、src/lib/db.ts の Prisma Extension では
 * 絞られない。所属（user_tenants）で、Extension と同じ考え方で絞る。
 *   - 会社が決まっている: その会社に所属するユーザー（runAsUserTenant 等で張った会社を優先）
 *   - 全社統合ビュー: Extension がテナント条件を入れない（Luma＋リージー合算）のに合わせ、
 *     有効な会社のどれかに所属するユーザー（どこにも所属しないユーザーは出さない）。書き込みはさせない。
 *   - 会社が決まらない: 移行期は既定の会社（Luma）、TENANT_STRICT=1 では失敗させる
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { currentTenant, currentTenantId, getRequestTenant, type TenantCtx } from "@/lib/tenant-context";
import { CROSS_TENANT_USER_ADMIN_REASON } from "@/lib/tenant-user-admin";

export class TenantUserScopeError extends Error {}

async function userScopeTenant(): Promise<TenantCtx | undefined> {
  const ctx = currentTenant() ?? (await getRequestTenant()) ?? undefined;
  if (!ctx && process.env.TENANT_STRICT === "1") {
    throw new TenantUserScopeError("テナントコンテキストなしでユーザー一覧が呼ばれました。withTenant() / runAsTenant() で包んでください。");
  }
  return ctx;
}

/** 操作中の会社に所属するユーザーの条件（User の where に足す）。 */
export async function currentTenantUserWhere(): Promise<Prisma.UserWhereInput> {
  const ctx = await userScopeTenant();
  return {
    userTenants: ctx?.crossTenant
      ? { some: { tenant: { active: true } } }
      : { some: { tenantId: ctx?.tenantId ?? currentTenantId() } },
  };
}

/**
 * 操作中の会社のユーザー一覧（作成順）。
 * tenantRoles: true のときは、権限・役職をその会社での値（UserTenant.permission / role）にする
 * （全社統合ビューでは会社が1つに決まらないので、全社共通の User の値のまま）。
 */
export async function listCurrentTenantUsers<S extends Prisma.UserSelect>(
  select: S,
  where: Prisma.UserWhereInput = {},
  { tenantRoles = false }: { tenantRoles?: boolean } = {},
) {
  const ctx = await userScopeTenant();
  const scope = await currentTenantUserWhere();
  const tenantId = ctx?.crossTenant ? null : (ctx?.tenantId ?? currentTenantId());
  if (!tenantRoles || !tenantId) {
    return prisma.user.findMany({ where: { ...where, ...scope }, select, orderBy: { createdAt: "asc" } });
  }
  const rows = await prisma.user.findMany({
    where: { ...where, ...scope },
    select: { ...select, userTenants: { where: { tenantId }, select: { permission: true, role: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => {
    const { userTenants, ...user } = row as typeof row & { userTenants: { permission: string; role: string | null }[] };
    const own = userTenants[0];
    return {
      ...user,
      ...("permission" in select && own ? { permission: own.permission } : {}),
      ...("role" in select && own ? { role: own.role } : {}),
    } as unknown as Prisma.UserGetPayload<{ select: S }>;
  });
}

type AdminScope = { tenantId: string; userId: string } | { error: string; status: number };

/**
 * ユーザー管理（追加・変更・削除・招待の発行と取消）をしてよいか。
 * 管理者かどうかは全社共通の User.permission ではなく、操作中の会社での権限（UserTenant.permission）で決める。
 * 全社統合ビューでは書き込ませない（Extension と同じ）。戻り値の error は日本語の理由と HTTP ステータス。
 */
export async function requireUserAdmin(): Promise<AdminScope> {
  const session = await getSession();
  if (!session) return { error: "Unauthorized", status: 401 };
  let ctx: TenantCtx | undefined;
  try {
    ctx = await userScopeTenant();
  } catch (e) {
    if (e instanceof TenantUserScopeError) return { error: "操作中の会社を確認できませんでした。再読み込みしてください。", status: 403 };
    throw e;
  }
  if (ctx?.crossTenant) return { error: CROSS_TENANT_USER_ADMIN_REASON, status: 403 };
  if (!ctx?.tenantId || ctx.userId !== session.userId || ctx.permission !== "admin") {
    return { error: "Forbidden: admin only", status: 403 };
  }
  return { tenantId: ctx.tenantId, userId: session.userId };
}

/**
 * 読み取り（招待の一覧など）用。全社統合ビューでは、どれかの会社の管理者なら読める。
 */
export async function requireUserAdminRead(): Promise<{ userId: string } | { error: string; status: number }> {
  const session = await getSession();
  if (!session) return { error: "Unauthorized", status: 401 };
  const ctx = currentTenant() ?? (await getRequestTenant()) ?? undefined;
  if (ctx?.crossTenant) {
    return (await isAdminSomewhere(session.userId)) ? { userId: session.userId } : { error: "Forbidden: admin only", status: 403 };
  }
  const scope = await requireUserAdmin();
  return "error" in scope ? scope : { userId: scope.userId };
}

async function isAdminSomewhere(userId: string): Promise<boolean> {
  return !!(await prisma.userTenant.findFirst({
    where: { userId, permission: "admin", tenant: { active: true } },
    select: { userId: true },
  }));
}

/**
 * 管理画面（ユーザー権限）に入れるか、と操作を無効にする理由。
 * 会社を選んでいるときはその会社の管理者だけ。全社統合ビューでは、どれかの会社の管理者なら閲覧だけできる。
 */
export async function userAdminAccess(): Promise<{ allowed: boolean; readOnlyReason: string | null }> {
  const session = await getSession();
  if (!session) return { allowed: false, readOnlyReason: null };
  const ctx = currentTenant() ?? (await getRequestTenant()) ?? undefined;
  if (ctx?.crossTenant) {
    return { allowed: await isAdminSomewhere(session.userId), readOnlyReason: CROSS_TENANT_USER_ADMIN_REASON };
  }
  const scope = await requireUserAdmin();
  if ("error" in scope) return { allowed: false, readOnlyReason: null };
  return { allowed: true, readOnlyReason: null };
}

/** そのユーザーが会社に所属しているか。 */
export async function isTenantMember(userId: string, tenantId: string): Promise<boolean> {
  return !!(await prisma.userTenant.findFirst({ where: { userId, tenantId }, select: { userId: true } }));
}

/** そのユーザーが、指定の会社以外にも所属しているか（削除するとほかの会社からも消える）。 */
export async function belongsToOtherTenant(userId: string, tenantId: string): Promise<boolean> {
  const rows = await prisma.userTenant.findMany({ where: { userId }, select: { tenantId: true } });
  return rows.some((row) => row.tenantId !== tenantId);
}
