import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { putFile, deleteFile, fetchStored, StorageConfigError } from "@/lib/storage";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX = 5 * 1024 * 1024; // 5MB

/**
 * GET /api/auth/avatar — ログイン中ユーザー自身のアバター画像を配信するプロキシ。
 * Blob はプライベートストアなので、avatarUrl に保存した pathname を直接 <img src> にはできない。
 * ?u=<userId> で他ユーザーのアバターも取得可（ログインしていれば誰でも閲覧可、プロフィール画像なので問題なし）。
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const targetId = new URL(req.url).searchParams.get("u") || session.userId;
  const user = await prisma.user.findUnique({
    where: { id: targetId },
    select: { avatarUrl: true },
  });
  if (!user?.avatarUrl) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const fetched = await fetchStored(user.avatarUrl);
  if (!fetched) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(fetched.buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": fetched.contentType || "image/jpeg",
      "Cache-Control": "private, max-age=60",
    },
  });
}

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

  const ext = file.type === "image/png"
    ? "png"
    : file.type === "image/webp"
      ? "webp"
      : file.type === "image/gif"
        ? "gif"
        : "jpg";
  const filename = `${session.userId}-${Date.now()}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  let url: string;
  try {
    ({ url } = await putFile({
      dir: "avatars",
      filename,
      buffer: buf,
      contentType: file.type,
    }));
  } catch (e) {
    const err = e as Error;
    console.error("[api/auth/avatar] putFile failed:", {
      name: err?.name,
      message: err?.message,
      blobConfigured: !!process.env.BLOB_READ_WRITE_TOKEN,
      onVercel: !!process.env.VERCEL,
    });
    const base = e instanceof StorageConfigError ? err.message : "画像の保存に失敗しました";
    const detail = e instanceof StorageConfigError ? undefined : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
    return NextResponse.json(
      { error: detail ? `${base}（詳細: ${detail}）` : base },
      { status: 500 },
    );
  }

  // 旧アバターを削除（local / blob どちらにも対応）
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { avatarUrl: true },
  });
  if (me?.avatarUrl) {
    await deleteFile(me.avatarUrl);
  }

  await prisma.user.update({
    where: { id: session.userId },
    data: { avatarUrl: url },
  });

  return NextResponse.json({ ok: true, avatarUrl: url });
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
