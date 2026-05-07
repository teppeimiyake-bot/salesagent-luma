import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

const schema = z.object({
  permission: z.enum(["admin", "user", "viewer"]).optional(),
  role: z.string().optional(),
  // メール/氏名は admin のみ編集可能
  email: z.string().email("メールアドレスの形式が不正です").optional(),
  name: z.string().min(1, "名前は必須です").max(100).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { permission: true } });
  if (!hasPermission(me?.permission, "admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
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
  const user = await prisma.user.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true, email: true, role: true, permission: true, avatarColor: true },
  });
  return NextResponse.json({ user });
}

// ============================================================
// DELETE /api/users/[id]
// admin のみ。自分自身は削除不可。
// 削除前に関連リソースを切り離し（Deal/Document の owner を null へ）→ User を delete。
// ChatMessage / Goal は schema 上 onDelete: Cascade なので自動削除される。
// 同 email の Invite トークンも掃除する。
// ============================================================
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const { id } = await params;
  if (id === session.userId) {
    return NextResponse.json({ error: "自分自身は削除できません" }, { status: 400 });
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
