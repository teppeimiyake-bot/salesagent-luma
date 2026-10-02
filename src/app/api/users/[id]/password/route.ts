import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getSession, hasPermission, hashPassword } from "@/lib/auth";

// ============================================================
// POST /api/users/[id]/password  — 管理者によるパスワード再発行
// ------------------------------------------------------------
// なぜ必要か:
//   パスワードは bcrypt ハッシュでしか保存されていないため復元できない。
//   これ自体は正しい設計だが、これまで「社員がログインできない」たびに
//   エンジニアが本番 Neon の接続情報を持ち出して使い捨てスクリプトを書く
//   運用になっていた（scripts/reset-password-katamoto.ts /
//   scripts/reset-password-watanabe.ts …）。
//   本番DBへの直接UPDATEが常用手段になっている状態そのものが事故の温床なので、
//   管理者が画面から実行できる正規の復旧経路をプロダクト側に用意する。
//
// 安全側の作り:
//   - admin のみ実行可能
//   - 自分自身には使わせない（自分のパスワード変更は /api/auth/password）
//   - 相手が自分と同じ会社(tenant)に所属している場合のみ許可。
//     User はテナント横断の共有マスタなので、ここを見ないと
//     Luma の管理者がリージー専属メンバーのパスワードを発行できてしまう。
//   - 生成した平文はこのレスポンスで1回だけ返し、保存もログ出力もしない
// ============================================================

/** 紛らわしい文字（0/O/1/l/I）を除いた、口頭・チャットで伝えられる文字種 */
const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generatePassword(len = 16): string {
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CHARSET[buf[i]! % CHARSET.length];
  return out;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, permission: true },
  });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  const { id } = await params;
  if (id === session.userId) {
    return NextResponse.json(
      { error: "自分自身のパスワードは「設定 > パスワード変更」から変更してください" },
      { status: 400 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, passwordHash: true },
  });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // 同じ会社に所属しているか（UserTenant はテナント境界の対象外なので素で引ける）
  const myTenantIds = (
    await prisma.userTenant.findMany({
      where: { userId: session.userId },
      select: { tenantId: true },
    })
  ).map((t) => t.tenantId);
  const shared = await prisma.userTenant.findFirst({
    where: { userId: id, tenantId: { in: myTenantIds } },
    select: { id: true },
  });
  if (!shared) {
    return NextResponse.json(
      { error: "このユーザーはあなたと同じ会社に所属していないため操作できません" },
      { status: 403 },
    );
  }

  const newPassword = generatePassword(16);
  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  return NextResponse.json({
    ok: true,
    user: { id: target.id, name: target.name, email: target.email },
    // 平文は再表示できない。画面側で「いま控えてください」と明示すること。
    password: newPassword,
    // これまでパスワード未設定（Googleログイン専用）だった場合の注記用
    wasPasswordless: !target.passwordHash,
  });
}
