import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth";

/**
 * GET /api/products
 * プロダクト（= カテゴリ）一覧。プランを include して返す。
 *   - active=all → 無効も含む（管理画面用、admin限定）
 *   - 既定: active=true のみ
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const all = url.searchParams.get("active") === "all";

  // 管理画面が active=all を取得するときは admin チェック
  if (all) {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { permission: true },
    });
    if (!hasPermission(me?.permission, "admin")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const products = await prisma.product.findMany({
    where: all ? {} : { active: true },
    orderBy: { name: "asc" },
    include: {
      plans: {
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      },
    },
  });
  return NextResponse.json({ products });
}

const createSchema = z.object({
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  // 初期プランをまとめて作成（任意）
  plans: z
    .array(
      z.object({
        name: z.string().min(1),
        basePrice: z.number().int().nullable().optional(),
        description: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { permission: true },
  });
  if (!hasPermission(me?.permission, "admin")) {
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
  const { plans, ...productData } = parsed.data;
  const product = await prisma.product.create({
    data: {
      ...productData,
      ...(plans && plans.length > 0
        ? {
            plans: {
              create: plans.map((p, i) => ({
                name: p.name,
                basePrice: p.basePrice ?? null,
                description: p.description ?? null,
                sortOrder: p.sortOrder ?? i,
              })),
            },
          }
        : {}),
    },
    include: {
      plans: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  return NextResponse.json({ product });
}
