import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

const schema = z.object({
  name: z
    .string()
    .min(1, "氏名を入力してください")
    .max(100, "氏名は100文字以内で入力してください"),
});

/**
 * 自分自身のプロフィール（現状は氏名のみ）を更新する
 * - 認証必須（getSession）
 * - email / role / permission は受け付けない（admin専用なので /admin/users 側で対応）
 * - 自分の users.name のみ UPDATE
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
  const { name } = parsed.data;
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return NextResponse.json({ error: "氏名を入力してください" }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { name: trimmed },
  });

  return NextResponse.json({ ok: true, name: trimmed });
}
