import { NextResponse } from "next/server";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { generateContractDraft } from "@/lib/contract-generate";

export const maxDuration = 60;

/**
 * POST /api/deal-products/[id]/contract
 * この DealProduct（映像/SNS）から契約書ドラフトを手動生成する。
 *   既存ドラフトがあればスキップ（重複生成防止）。?force=1 で再生成。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const force = new URL(req.url).searchParams.get("force") === "1";
  const session = await getSession();

  const res = await generateContractDraft(id, session?.userId ?? null, force);
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }
  return NextResponse.json({
    ok: true,
    documentId: res.documentId,
    skipped: res.skipped,
    category: res.category,
  });
}
