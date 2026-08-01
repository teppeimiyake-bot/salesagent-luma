import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const stages = await prisma.pipelineStage.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { value: "asc" }],
  });
  return NextResponse.json({ stages });
}

const createSchema = z.object({
  value: z.string().min(1).max(80),
  label: z.string().min(1).max(80).optional(),
  group: z.enum(["before", "after", "contract"]),
  badgeBg: z.string().min(1).max(40),
  badgeText: z.string().min(1).max(40),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const exists = await prisma.pipelineStage.findFirst({
    where: { value: parsed.data.value },
  });
  if (exists) {
    return NextResponse.json(
      { error: "同じ値のステージが既に存在します" },
      { status: 409 },
    );
  }
  const stage = await prisma.pipelineStage.create({
    data: {
      value: parsed.data.value,
      label: parsed.data.label ?? parsed.data.value,
      group: parsed.data.group,
      badgeBg: parsed.data.badgeBg,
      badgeText: parsed.data.badgeText,
      active: parsed.data.active ?? true,
      sortOrder: parsed.data.sortOrder ?? 999,
    },
  });
  return NextResponse.json({ stage });
}
