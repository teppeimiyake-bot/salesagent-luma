import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";
import { fetchStored } from "@/lib/storage";

export const maxDuration = 60;

/**
 * GET /api/documents/[id]/download
 *
 * 提案書・見積書・契約書などのドキュメント本体を「アプリの認証を通して」配信するプロキシ。
 * Vercel Blob はプライベートストアなので、blob の生 URL は認証なしでは 401。
 * ここで (1) ログイン認証 (2) 権限チェック（契約書は admin のみ）(3) blob/local からファイル取得 (4) ストリーム返却。
 *
 * ?inline=1 を付けるとブラウザ内表示（Content-Disposition: inline）、なければダウンロード（attachment）。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // 契約書は admin のみ閲覧可（アップロード/削除と同じ制限に揃える）
  if (doc.category === "contract") {
    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { permission: true },
    });
    if (!hasPermission(me?.permission, "admin")) {
      return NextResponse.json({ error: "Forbidden: contracts are admin-only" }, { status: 403 });
    }
  }

  if (!doc.fileUrl || doc.fileUrl.includes(" ")) {
    // "(リンク未登録)" など、ファイル本体が無いレコード
    return NextResponse.json({ error: "このドキュメントにはファイル本体がありません" }, { status: 404 });
  }

  const fetched = await fetchStored(doc.fileUrl);
  if (!fetched) {
    return NextResponse.json(
      { error: "ファイル本体を取得できませんでした（旧データ or ストレージ未設定の可能性）" },
      { status: 404 },
    );
  }

  const inline = new URL(req.url).searchParams.get("inline") === "1";
  const contentType = doc.mimeType || fetched.contentType || "application/octet-stream";
  // ファイル名：日本語等が入りうるので RFC 5987 形式で
  const baseName = (doc.name || "file").replace(/[\r\n"\\]/g, "_");
  const filenameStar = `UTF-8''${encodeURIComponent(baseName)}`;
  const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiFallback(baseName)}"; filename*=${filenameStar}`;

  return new NextResponse(fetched.buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Content-Length": String(fetched.buffer.length),
      // 機密ファイル：キャッシュさせない
      "Cache-Control": "private, no-store",
    },
  });
}

/** Content-Disposition の fil="" 部分用に非 ASCII を _ に落とす。 */
function asciiFallback(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "file";
}
