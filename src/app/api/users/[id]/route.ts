import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { normalizeEmail } from "@/lib/email";
import { belongsToOtherTenant, isTenantMember, requireUserAdmin } from "@/lib/tenant-users";

const schema = z.object({
  permission: z.enum(["admin", "user", "viewer"]).optional(),
  role: z.string().optional(),
  // メール/氏名は admin のみ編集可能。
  // メールは正規化してから保存する（管理画面から非正規形を入れられると
  // その人だけログインできなくなるため）。
  email: z
    .string()
    .transform(normalizeEmail)
    .pipe(z.string().email("メールアドレスの形式が不正です"))
    .optional(),
  name: z.string().min(1, "名前は必須です").max(100).optional(),
  // フリガナ（カタカナ読み）。担当者をカナでも検索できるようにする。空文字は null 化。
  nameKana: z.string().max(100).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // 管理者かどうかは操作中の会社での権限で決め、操作中の会社に所属するユーザーだけを変更できる
  const scope = await requireUserAdmin();
  if ("error" in scope) return NextResponse.json({ error: scope.error }, { status: scope.status });
  const { id } = await params;
  if (!(await isTenantMember(id, scope.tenantId))) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const current = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!current) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // ほかの会社にも所属するユーザーの全社共通の値は、この会社の管理者だけでは変えない。
  // メールは Google ログインの紐付け（allowDangerousEmailAccountLinking）に使うため、書き換えると
  // ほかの会社でのアカウントを乗っ取れてしまう。
  const sharedWithOtherTenant = await belongsToOtherTenant(id, scope.tenantId);
  if (sharedWithOtherTenant && parsed.data.email !== undefined && parsed.data.email !== current.email) {
    return NextResponse.json(
      { error: "このユーザーはほかの会社にも所属しているため、メールアドレスはここでは変更できません。" },
      { status: 409 },
    );
  }
  // email 重複チェック（自分以外で同メールが既に居たら拒否）
  if (parsed.data.email) {
    const dup = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (dup && dup.id !== id) {
      return NextResponse.json(
        { error: "そのメールアドレスは既に他のユーザーで使用されています" },
        { status: 409 },
      );
    }
  }
  const { permission, role, ...profile } = parsed.data;
  // 権限・役職は、この会社での値（UserTenant）を変える。全社共通の User の値は、ほかの会社に所属が無いときだけ
  // 合わせて変える（User.permission を見る既存の処理と食い違わないように）。
  const tenantFields = { ...(permission !== undefined ? { permission } : {}), ...(role !== undefined ? { role } : {}) };
  const membership = Object.keys(tenantFields).length
    ? await prisma.userTenant.update({
        where: { userId_tenantId: { userId: id, tenantId: scope.tenantId } },
        data: tenantFields,
        select: { permission: true, role: true },
      })
    : await prisma.userTenant.findFirst({ where: { userId: id, tenantId: scope.tenantId }, select: { permission: true, role: true } });
  // nameKana は空文字を null に正規化（未設定扱いに戻せるように）
  const data: Prisma.UserUpdateInput = { ...profile, ...(sharedWithOtherTenant ? {} : tenantFields) };
  if (profile.nameKana !== undefined) {
    data.nameKana = profile.nameKana.trim() === "" ? null : profile.nameKana.trim();
  }
  const select = { id: true, name: true, nameKana: true, email: true, role: true, permission: true, avatarColor: true } as const;
  const user = Object.keys(data).length
    ? await prisma.user.update({ where: { id }, data, select })
    : await prisma.user.findUnique({ where: { id }, select });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // 画面には、この会社での権限・役職を返す
  return NextResponse.json({ user: { ...user, permission: membership?.permission ?? user.permission, role: membership?.role ?? user.role } });
}

// ============================================================
// DELETE /api/users/[id]
// admin のみ。自分自身は削除不可。
// 削除前に関連リソースを切り離し（Deal/Document の owner を null へ）→ User を delete。
// ChatMessage / Goal は schema 上 onDelete: Cascade なので自動削除される。
// 同 email の Invite トークンも掃除する。
// ============================================================
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // 管理者かどうかは操作中の会社での権限で決める。操作中の会社に所属するユーザーだけを削除できる。
  // ほかの会社にも所属するユーザーは、削除するとその会社からも消えてしまうため、ここでは削除しない。
  const scope = await requireUserAdmin();
  if ("error" in scope) return NextResponse.json({ error: scope.error }, { status: scope.status });

  const { id } = await params;
  if (id === scope.userId) {
    return NextResponse.json({ error: "自分自身は削除できません" }, { status: 400 });
  }
  if (!(await isTenantMember(id, scope.tenantId))) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (await belongsToOtherTenant(id, scope.tenantId)) {
    return NextResponse.json(
      { error: "このユーザーはほかの会社にも所属しているため、ここでは削除できません。" },
      { status: 409 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // 関連レコードを切り離し → User削除（トランザクション）
  // Deal.ownerUserId / Document.uploadedById は schema で SetNull だが、
  // DBアダプタによっては DELETE 前に明示的に null 化したほうが安全なので明示。
  // ChatMessage / Goal は Cascade（自動削除）。
  // Invite は外部キー無し → 同 email の招待を used でない限り削除。
  const [updatedDeals, updatedDocs, deletedInvites] = await prisma.$transaction([
    prisma.deal.updateMany({
      where: { ownerUserId: id },
      data: { ownerUserId: null },
    }),
    prisma.document.updateMany({
      where: { uploadedById: id },
      data: { uploadedById: null },
    }),
    prisma.invite.deleteMany({
      where: { email: target.email, used: false },
    }),
  ]);

  await prisma.user.delete({ where: { id } });

  return NextResponse.json({
    ok: true,
    deletedUser: target,
    detached: {
      deals: updatedDeals.count,
      documents: updatedDocs.count,
      invites: deletedInvites.count,
    },
  });
}
