import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

// ワーカーマスタ一覧（閲覧は全ロール）
export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const workers = await prisma.msWorker.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ workers });
}

const createSchema = z.object({
  code: z.string().max(20).optional().nullable(),
  name: z.string().min(1).max(100),
  isAgency: z.boolean().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  notes: z.string().max(2000).optional().nullable(),
});

// ワーカー追加は admin のみ
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
  const created = await prisma.msWorker.create({
    data: {
      code: parsed.data.code ?? null,
      name: parsed.data.name,
      isAgency: parsed.data.isAgency ?? false,
      active: parsed.data.active ?? true,
      sortOrder: parsed.data.sortOrder ?? 0,
      notes: parsed.data.notes ?? null,
    },
  });
  return NextResponse.json({ worker: created });
}
