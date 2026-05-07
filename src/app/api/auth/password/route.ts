import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hashPassword, verifyPassword } from "@/lib/auth";

const schema = z.object({
  currentPassword: z.string().min(1, "現在のパスワードを入力してください"),
  newPassword: z
    .string()
    .min(8, "新しいパスワードは8文字以上で入力してください")
    .max(128, "新しいパスワードが長すぎます"),
});

/**
 * 自分自身のパスワードを変更する
 * - 認証必須
 * - 現在のパスワードを bcrypt で検証
 * - 新パスワードを bcrypt でハッシュ化して保存
 * - 他人のパスワード変更は不可（adminによるリセットは別エンドポイントで対応予定）
 */
export async function PATCH(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "入力に誤りがあります" },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword } = parsed.data;

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: "現在と異なるパスワードを設定してください" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!user.passwordHash) {
    // Googleログイン専用ユーザー：別途パスワード設定UI/APIを用意するまでは変更不可
    return NextResponse.json(
      { error: "このアカウントはGoogleログイン専用のためパスワード変更はできません" },
      { status: 400 },
    );
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "現在のパスワードが正しくありません" }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  return NextResponse.json({ ok: true });
}
