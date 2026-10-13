import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { BULK_TX_OPTIONS, ingestApprovedCandidates } from "@/lib/agent-candidate-ingest";

export const dynamic = "force-dynamic";

// 承認済み(reviewStatus="approved")候補を Company/Contact へ正式反映する（admin・「取り込み」ボタン）。
// dedupe は company-dedup の normalizeName/domainOf を再利用。冪等（Company.sourceKey ＋ 候補状態）。
// 件数に比例して DB 往復が増えない書き方は src/lib/agent-candidate-ingest.ts を参照。
export async function POST() {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }

  try {
    const result = await prisma.$transaction(
      (tx) => ingestApprovedCandidates(tx),
      BULK_TX_OPTIONS,
    );
    if (result.ingested === 0) {
      return NextResponse.json({ ok: true, ...result, message: "承認済みの候補がありません" });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[admin/agent-candidates/ingest] 取り込みに失敗", err);
    return NextResponse.json(
      {
        error: "取り込みに失敗しました",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      },
      { status: 500 },
    );
  }
}
