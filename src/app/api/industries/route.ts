import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

/**
 * GET /api/industries
 *   業種ピッカーの選択肢用にマスタを返す。
 *   ?includeInactive=true で無効分も含む（管理画面用）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeInactive = url.searchParams.get("includeInactive") === "true";
  const industries = await prisma.industry.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ industries });
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
  const name = parsed.data.name.trim();
  // 重複チェック（無効化済みの同名があれば有効化して返す＝重複作成を避ける）
  const exists = await prisma.industry.findFirst({ where: { name } });
  if (exists) {
    if (!exists.active) {
      const reactivated = await prisma.industry.update({
        where: { id: exists.id },
        data: { active: true },
      });
      return NextResponse.json({ industry: reactivated, reactivated: true });
    }
    return NextResponse.json({ error: "同名の業種が既に存在します" }, { status: 409 });
  }
  const created = await prisma.industry.create({
    data: {
      name,
      active: parsed.data.active ?? true,
      sortOrder: parsed.data.sortOrder ?? 0,
    },
  });
  return NextResponse.json({ industry: created });
}
