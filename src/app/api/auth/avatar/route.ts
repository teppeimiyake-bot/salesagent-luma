import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { putFile, deleteFile } from "@/lib/storage";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX = 5 * 1024 * 1024; // 5MB

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Invalid form" }, { status: 400 });
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "ファイルが指定されていません" }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { error: "画像形式は PNG / JPEG / WebP / GIF のいずれかにしてください" },
      { status: 400 },
    );
  }
  if (file.size > MAX) {
    return NextResponse.json({ error: "ファイルサイズは 5MB まで" }, { status: 400 });
  }

  const ext =
    file.type === "image/png"
      ? "png"
      : file.type === "image/webp"
        ? "webp"
        : file.type === "image/gif"
          ? "gif"
          : "jpg";

  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await putFile(buf, {
    dir: "avatars",
    ext,
    originalName: file.name,
    contentType: file.type,
  });

  // 旧アバターを削除（Blob/ローカル 両対応）
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { avatarUrl: true },
  });
  if (me?.avatarUrl) {
    await deleteFile(me.avatarUrl);
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { avatarUrl: stored.url },
  });

  return NextResponse.json({ ok: true, avatarUrl: stored.url });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { avatarUrl: true },
  });
  if (me?.avatarUrl) {
    await deleteFile(me.avatarUrl);
  }
  await prisma.user.update({
    where: { id: session.userId },
    data: { avatarUrl: null },
  });
  return NextResponse.json({ ok: true });
}
