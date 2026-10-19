import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { getSession, hasPermission, getCurrentPermission } from "@/lib/auth";
import { expectedPartBytes, readUploadManifest, uploadPartPath, uploadSessionExpired } from "@/lib/meetings/upload-sessions";
import { writeForbidden } from "@/lib/write-guard";

export const maxDuration = 60;

/** PUT /api/meetings/upload-sessions/[uploadId]/parts/[index] — 本文は録画の該当バイト列そのもの。 */
export async function PUT(req: Request, { params }: { params: Promise<{ uploadId: string; index: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = { permission: await getCurrentPermission() };
  if (!hasPermission(user?.permission, "user")) return await writeForbidden();

  const { uploadId, index: rawIndex } = await params;
  const manifest = await readUploadManifest(uploadId);
  // 他の利用者のアップロードは存在しないものとして扱う。
  if (!manifest || manifest.userId !== session.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (manifest.completedMeetingId) return NextResponse.json({ error: "このアップロードは完了済みです。" }, { status: 409 });
  if (uploadSessionExpired(manifest)) return NextResponse.json({ error: "アップロードの有効期限が切れました。最初から添付し直してください。" }, { status: 410 });

  const index = /^\d{1,5}$/.test(rawIndex) ? Number(rawIndex) : -1;
  const expected = expectedPartBytes(manifest, index);
  if (expected === null) return NextResponse.json({ error: "パート番号が不正です。" }, { status: 400 });
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) !== expected) {
    return NextResponse.json({ error: "パートのサイズが一致しません。最初から添付し直してください。" }, { status: 400 });
  }
  const body = Buffer.from(await req.arrayBuffer());
  if (body.byteLength !== expected) {
    return NextResponse.json({ error: "パートのサイズが一致しません。通信が途中で切れた可能性があります。" }, { status: 400 });
  }
  // 同じパートの再送は上書きする（通信失敗後の再試行）。
  await fs.writeFile(uploadPartPath(uploadId, index), body);
  return NextResponse.json({ received: index });
}
