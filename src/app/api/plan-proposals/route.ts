import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const items = await prisma.planProposal.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ planProposals: items });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().min(1).max(20).optional(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const exists = await prisma.planProposal.findFirst({ where: { name: parsed.data.name } });
  if (exists) {
    return NextResponse.json({ error: "同名の企画提案が既に存在します" }, { status: 409 });
  }
  // displayOrder 未指定なら末尾
  let displayOrder = parsed.data.displayOrder;
  if (displayOrder == null) {
    const max = await prisma.planProposal.aggregate({ _max: { displayOrder: true } });
    displayOrder = (max._max.displayOrder ?? 0) + 1;
  }
  const created = await prisma.planProposal.create({
    data: {
      name: parsed.data.name,
      color: parsed.data.color ?? "default",
      displayOrder,
      active: parsed.data.active ?? true,
    },
  });
  return NextResponse.json({ planProposal: created });
}
