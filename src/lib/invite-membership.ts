/**
 * 招待・自己登録で作ったユーザーに、会社の所属（user_tenants）を作る。
 * ------------------------------------------------------------
 * ユーザーの一覧（担当者・管理画面・/api/users）は所属で会社ごとに絞る（src/lib/tenant-users.ts）。
 * 所属が無いユーザーはどの会社の一覧にも出ず、ログインしても会社が決まらない（TENANT_STRICT=1 では使えない）。
 *
 * ログイン前（セッションが無い）に動く処理なので、テナント境界の無いクライアント（prismaUnscoped、
 * src/auth.ts の専用クライアント）を受け取る。
 */
import type { Invite, Prisma, PrismaClient } from "@prisma/client";

type MembershipClient = Pick<Prisma.TransactionClient, "userTenant">;

/**
 * 会社の所属を作る。既にあれば作らない（既存の権限・役職は変えない）。
 * そのユーザーの最初の所属なら、ログイン直後に選ばれる既定の会社にする。
 */
export async function ensureTenantMembership(
  client: MembershipClient,
  { userId, tenantId, permission, role }: { userId: string; tenantId: string; permission: string; role: string | null },
) {
  const existing = await client.userTenant.count({ where: { userId } });
  return client.userTenant.upsert({
    where: { userId_tenantId: { userId, tenantId } },
    create: { userId, tenantId, permission, role, isDefault: existing === 0 },
    update: {},
  });
}

/**
 * 招待からユーザーを作る。権限・役職は招待の値、所属は招待の会社。招待は使用済みにする。
 * ユーザー・所属・招待の更新を1つのトランザクションで行う（途中で失敗して所属の無いユーザーを残さない）。
 */
export async function createInvitedUser(
  client: Pick<PrismaClient, "$transaction">,
  invite: Pick<Invite, "id" | "tenantId" | "role" | "permission">,
  data: Omit<Prisma.UserCreateInput, "role" | "permission">,
) {
  return client.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { ...data, role: invite.role, permission: invite.permission } });
    await ensureTenantMembership(tx, { userId: user.id, tenantId: invite.tenantId, permission: invite.permission, role: invite.role });
    await tx.invite.update({ where: { id: invite.id }, data: { used: true, usedAt: new Date() } });
    return user;
  });
}
