import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

const createSchema = z.object({
  name: z.string().min(1),
  basePrice: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

/**
 * POST /api/products/[id]/plans
 * 指定プロダクトに新規プランを追加（admin）
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (!hasPermission(me?.permission, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id: productId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // sortOrder未指定なら末尾
  let sortOrder = parsed.data.sortOrder;
  if (sortOrder === undefined) {
    const last = await prisma.productPlan.findFirst({
      where: { productId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    sortOrder = (last?.sortOrder ?? -1) + 1;
  }
  try {
    const plan = await prisma.productPlan.create({
      data: {
        productId,
        name: parsed.data.name,
        basePrice: parsed.data.basePrice ?? null,
        description: parsed.data.description ?? null,
        sortOrder,
        active: parsed.data.active ?? true,
      },
    });
    return NextResponse.json({ plan });
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "P2002") {
      return NextResponse.json(
        { error: "同じプラン名が既に存在します" },
        { status: 409 },
      );
    }
    throw e;
  }
}
