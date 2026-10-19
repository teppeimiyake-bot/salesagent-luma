import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { requireUserAdmin, requireUserAdminRead } from "@/lib/tenant-users";

// 招待の発行・取消は、操作中の会社の管理者のみ（全社共通の User.permission ではなく、その会社での権限で決める）。
// 全社統合ビューでは発行・取消させない。一覧の閲覧は、全社統合ビューならどれかの会社の管理者なら読める。
export async function GET() {
  const me = await requireUserAdminRead();
  if ("error" in me) return NextResponse.json({ error: me.error }, { status: me.status });
  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ invites });
}

const createSchema = z.object({
  // 招待の時点で正規形にしておく。ここが素通しだと、登録されるユーザーの
  // email も非正規形になり、本人がログイン画面で正しく打っても一致しなくなる。
  email: z.string().transform(normalizeEmail).pipe(z.string().email()),
  name: z.string().optional(),
  role: z.enum(["sales", "manager"]).default("sales"),
  permission: z.enum(["admin", "user", "viewer"]).default("user"),
  // 期限（時間）。デフォルト168時間=7日
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
});

export async function POST(req: Request) {
  const me = await requireUserAdmin();
  if ("error" in me) return NextResponse.json({ error: me.error }, { status: me.status });
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { email, name, role, permission } = parsed.data;
  const hours = parsed.data.expiresInHours ?? 168;

  // 既存ユーザーチェック
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  // 既に有効な招待がある場合は再生成（古いものは used 扱いに）
  await prisma.invite.updateMany({
    where: { email, used: false, expiresAt: { gt: new Date() } },
    data: { used: true, usedAt: new Date() },
  });

  const token = randomBytes(24).toString("base64url");
  const invite = await prisma.invite.create({
    data: {
      email,
      name,
      role,
      permission,
      token,
      invitedById: me.userId,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    },
  });
  return NextResponse.json({ invite });
}

export async function DELETE(req: Request) {
  const me = await requireUserAdmin();
  if ("error" in me) return NextResponse.json({ error: me.error }, { status: me.status });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.invite.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
