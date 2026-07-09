import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, getCurrentPermission, hasPermission } from "@/lib/auth";

export const dynamic = "force-dynamic";

// 候補の承認 / 却下 / 差し戻し（admin）。取り込み済みは変更不可。
const patchSchema = z.object({
  action: z.enum(["approve", "reject", "pending"]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const cand = await prisma.agentCandidate.findUnique({ where: { id } });
  if (!cand) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (cand.reviewStatus === "ingested") {
    return NextResponse.json(
      { error: "取り込み済みの候補は変更できません" },
      { status: 400 },
    );
  }

  const session = await getSession();
  const reviewStatus =
    parsed.data.action === "approve"
      ? "approved"
      : parsed.data.action === "reject"
        ? "rejected"
        : "pending";

  const candidate = await prisma.agentCandidate.update({
    where: { id },
    data: {
      reviewStatus,
      reviewedById: session?.userId ?? null,
      reviewedAt: new Date(),
    },
  });

  return NextResponse.json({ candidate });
}
