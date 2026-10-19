import { NextResponse } from "next/server";
import { z } from "zod";
import { prismaUnscoped } from "@/lib/db";
import { createSessionToken, hashPassword, setSessionCookie } from "@/lib/auth";
import { normalizeEmail } from "@/lib/email";
import { currentTenantId } from "@/lib/tenant-context";
import { createInvitedUser, ensureTenantMembership } from "@/lib/invite-membership";
import { isSelfRegistrationAllowed, SELF_REGISTRATION_DISABLED_MESSAGE } from "@/lib/self-registration";

const schema = z.object({
  // 保存する値は必ず正規形にする（ログイン時の照合と同じ形に揃える）
  email: z.string().transform(normalizeEmail).pipe(z.string().email()).optional(),
  password: z.string().min(8),
  name: z.string().optional(),
  // 招待トークン（指定時はメール固定・権限/所属会社はトークン由来）
  inviteToken: z.string().optional(),
});

// 招待なしの直接登録を許可するか。既定は不許可（src/lib/self-registration.ts）。
// マルチテナント化後、招待なしで作られたユーザーは user_tenants を持たないため
// ログインできても全画面がテナントコンテキスト無しで落ちる。加えて /register は
// middleware で公開パスなので、開けたままだと実顧客データを持つ本番に
// 誰でもアカウントを作れてしまう。運用上どうしても必要な場合のみ
// Vercel に ALLOW_SELF_REGISTRATION=1 を設定する（TENANT_STRICT=1 では設定しても受け付けない）。

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { password, inviteToken } = parsed.data;

  // ============================================================
  // 招待トークン経由（admin が発行したURL からのみ登録）
  // ------------------------------------------------------------
  // このルートは未ログインで叩かれるためテナントコンテキストが存在しない。
  // テナント境界付きの prisma を使うと本番（TENANT_STRICT=1）では Extension が
  // 例外を投げて必ず 500 になるので、招待の読み書きは prismaUnscoped で行い、
  // テナントは招待レコードが持つ tenant_id から復元する。
  // ============================================================
  if (inviteToken) {
    // 登録はログイン前（会社が決まっていない）。テナント境界つきのクライアントでは既定の会社（Luma）の招待しか
    // 見えないため、招待は境界なしで引き、招待の会社（invite.tenantId）に所属させる。
    const invite = await prismaUnscoped.invite.findUnique({ where: { token: inviteToken } });
    if (!invite) {
      return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
    }
    if (invite.used) {
      return NextResponse.json({ error: "Invite already used" }, { status: 410 });
    }
    if (invite.expiresAt < new Date()) {
      return NextResponse.json({ error: "Invite expired" }, { status: 410 });
    }
    // 招待に所属会社が乗っていないものは受け付けない（fail-closed）。
    // ここを通してしまうと所属なしユーザーができて、ログイン後に全画面が壊れる。
    if (!invite.tenantId) {
      return NextResponse.json(
        { error: "この招待は所属会社が未設定のため使用できません。管理者に再発行を依頼してください。" },
        { status: 409 },
      );
    }
    const tenant = await prismaUnscoped.tenant.findUnique({
      where: { id: invite.tenantId },
      select: { id: true, active: true },
    });
    if (!tenant || !tenant.active) {
      return NextResponse.json(
        { error: "この招待の所属会社が見つかりません。管理者に再発行を依頼してください。" },
        { status: 409 },
      );
    }
    // 招待レコードは正規化前に作られたものが残っている可能性があるため、
    // ここでも必ず正規形に直してから照合・保存する。
    const inviteEmail = normalizeEmail(invite.email);
    const existing = await prismaUnscoped.user.findUnique({ where: { email: inviteEmail } });
    if (existing) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 });
    }
    const passwordHash = await hashPassword(password);

    // ユーザー作成 / 所属(user_tenants)作成 / 招待の使用済み化 は
    // ひとつでも欠けると「ログインできるが会社に所属していない」壊れた状態になるため
    // 必ず同一トランザクションで行う（createInvitedUser）。
    const user = await createInvitedUser(prismaUnscoped, { ...invite, tenantId: invite.tenantId }, {
      email: inviteEmail,
      passwordHash,
      name: parsed.data.name ?? invite.name ?? inviteEmail.split("@")[0],
    });

    const sessionToken = await createSessionToken({ userId: user.id, email: user.email });
    await setSessionCookie(sessionToken);
    return NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name },
    });
  }

  // ============================================================
  // 招待なし（直接登録）
  // ------------------------------------------------------------
  // 既定で無効。所属会社を決めようがないため、通してもログイン後に壊れる。
  // メンバー追加は 管理 > メンバー の「招待URLを発行」か、admin による直接追加
  // （POST /api/users）を使うこと。
  // ============================================================
  // 招待なしの登録は、既定では受け付けない（誰でも既定の会社の利用者として所属できてしまうため）。
  // ALLOW_SELF_REGISTRATION=1 のときだけ受け付け、ログイン時の会社の決まり方に合わせて既定の会社（Luma）に
  // 所属させる。TENANT_STRICT=1 では会社が決まらず使えないので、許可していても受け付けない（src/lib/self-registration.ts）。
  if (!isSelfRegistrationAllowed()) {
    return NextResponse.json({ error: SELF_REGISTRATION_DISABLED_MESSAGE }, { status: 403 });
  }
  const email = parsed.data.email;
  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }
  const existing = await prismaUnscoped.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }
  const passwordHash = await hashPassword(password);
  const user = await prismaUnscoped.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, passwordHash, name: parsed.data.name ?? email.split("@")[0] },
    });
    await ensureTenantMembership(tx, { userId: created.id, tenantId: currentTenantId(), permission: created.permission, role: created.role });
    return created;
  });
  const token = await createSessionToken({ userId: user.id, email: user.email });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
