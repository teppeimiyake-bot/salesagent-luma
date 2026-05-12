import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { deleteFile } from "@/lib/storage";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (me?.permission === "viewer") {
    return NextResponse.json({ error: "Forbidden: viewer cannot delete" }, { status: 403 });
  }
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // 契約書の削除は admin のみ
  if (doc.category === "contract" && !hasPermission(me?.permission, "admin")) {
    return NextResponse.json(
      { error: "Forbidden: contracts can only be deleted by admin" },
      { status: 403 },
    );
  }
  await prisma.document.delete({ where: { id } });
  // ファイル本体も削除（local / blob 両対応。"(リンク未登録)" 等は storage.deleteFile 内で無視）
  await deleteFile(doc.fileUrl);
  return NextResponse.json({ ok: true });
}
