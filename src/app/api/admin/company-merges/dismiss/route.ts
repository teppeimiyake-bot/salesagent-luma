import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";
import { dismissKey } from "@/lib/company-dedup";

export const dynamic = "force-dynamic";

const dismissSchema = z.object({
  // 「別会社」と判断した企業 id 群（グループ単位）。全ペアを記録して再提示しない。
  companyIds: z.array(z.string().min(1)).min(2),
});

/**
 * POST /api/admin/company-merges/dismiss
 * 重複候補グループを「別会社（統合しない）」として記録（admin only）。
 * グループ内の全ペアを CompanyMergeDismissed に upsert（companyIdA<companyIdB にソート）。
 */
export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const session = await getSession();

  const body = await req.json().catch(() => null);
  const parsed = dismissSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const ids = [...new Set(parsed.data.companyIds)];

  try {
    let recorded = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = dismissKey(ids[i], ids[j]);
        await prisma.companyMergeDismissed.upsert({
          where: { companyIdA_companyIdB: key },
          create: { ...key, dismissedById: session?.userId ?? null },
          update: {},
        });
        recorded++;
      }
    }
    return NextResponse.json({ ok: true, recordedPairs: recorded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[POST /api/admin/company-merges/dismiss] error:", msg);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
