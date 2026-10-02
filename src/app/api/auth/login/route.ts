import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSessionToken, setSessionCookie, verifyPassword } from "@/lib/auth";
import { normalizeEmail } from "@/lib/email";

// メールは必ず正規化してから検証・照合する。
// users.email は正規化済みの値で保存されているため、ここで揃えないと
// 「大文字が混ざっていた」「IMEで全角になっていた」「前後に空白が入っていた」
// だけでアカウントは存在するのに Invalid credentials になる。
const schema = z.object({
  email: z.string().transform(normalizeEmail).pipe(z.string().email()),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  if (!user.passwordHash) {
    // Googleログイン専用ユーザー（パスワード未設定）
    return NextResponse.json(
      { error: "このアカウントはGoogleログイン専用です。Googleでログインしてください" },
      { status: 401 },
    );
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  const token = await createSessionToken({ userId: user.id, email: user.email });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
