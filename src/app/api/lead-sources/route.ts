import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const sources = await prisma.leadSource.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ leadSources: sources });
}

const createSchema = z.object({
  name: z.string().min(1).max(50),
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
  // 重複チェック
  const exists = await prisma.leadSource.findFirst({ where: { name: parsed.data.name } });
  if (exists) {
    return NextResponse.json({ error: "同名のリード獲得経由が既に存在します" }, { status: 409 });
  }
  const created = await prisma.leadSource.create({
    data: {
      name: parsed.data.name,
      active: parsed.data.active ?? true,
      sortOrder: parsed.data.sortOrder ?? 0,
    },
  });
  return NextResponse.json({ leadSource: created });
}
