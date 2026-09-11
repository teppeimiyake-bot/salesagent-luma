import { NextResponse } from "next/server";
import { prismaUnscoped } from "@/lib/db";

// ============================================================
// 招待トークンの検証（未ログインで叩かれる公開エンドポイント）
// ------------------------------------------------------------
// ここは「まだアカウントを持っていない人」が招待URLを開いた瞬間に呼ばれる。
// つまりセッションが無く、テナントコンテキストが決まらない。
// この状態でテナント境界付きの prisma（src/lib/db.ts の Extension）を使うと
// 招待リンクは必ず壊れる:
//
//   - TENANT_STRICT=1（本番 Vercel で設定済み）
//       → Extension が「テナントコンテキストなしで Invite.findUnique が呼ばれました」で
//         例外を投げる → 500 → 招待リンクを開くと「エラー」になる（本不具合の直接原因）
//   - TENANT_STRICT 未設定（ローカル）
//       → 既定テナント(Luma)に強制されるため、リージーのタブで発行した招待は
//         findUnique 後の tenantId 突合で弾かれて 404「Invalid invite」になる
//
// invites.token は randomBytes(24) の推測不能な秘密で、かつテナントをまたいで
// グローバルに @unique。「トークンを持っていること」自体が認可なので、
// ここだけは prismaUnscoped で引き、テナントは招待レコード側から復元する。
// ============================================================
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token) return NextResponse.json({ error: "Invalid invite" }, { status: 404 });

  const invite = await prismaUnscoped.invite.findUnique({ where: { token } });
  if (!invite) return NextResponse.json({ error: "Invalid invite" }, { status: 404 });
  if (invite.used) return NextResponse.json({ error: "Invite already used" }, { status: 410 });
  if (invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invite expired" }, { status: 410 });
  }

  // すでに同じメールのユーザーが存在する場合は、登録画面まで進ませても
  // 最後に 409 で落ちるだけなので、この時点で理由を返す。
  const existingUser = await prismaUnscoped.user.findUnique({
    where: { email: invite.email },
    select: { id: true },
  });
  if (existingUser) {
    return NextResponse.json(
      { error: "このメールアドレスは既に登録済みです。ログイン画面からサインインしてください。" },
      { status: 409 },
    );
  }

  // どの会社に招待されているかを画面に出す（Luma / リージーの取り違え防止）
  const tenant = invite.tenantId
    ? await prismaUnscoped.tenant.findUnique({
        where: { id: invite.tenantId },
        select: { code: true, name: true, shortName: true },
      })
    : null;

  return NextResponse.json({
    invite: {
      email: invite.email,
      name: invite.name,
      role: invite.role,
      permission: invite.permission,
      expiresAt: invite.expiresAt,
      tenantCode: tenant?.code ?? null,
      tenantName: tenant?.name ?? null,
      tenantShortName: tenant?.shortName ?? null,
    },
  });
}
