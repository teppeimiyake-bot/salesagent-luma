import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import {
  INVALID_PRODUCT,
  resolveTemplateProductId,
  templateLineSchema,
  toTemplateLineData,
} from "@/lib/quote-template-server";

/**
 * GET  /api/quote-templates — 有効なテンプレート一覧（明細込み）※既存動作は変更しない
 * POST /api/quote-templates — テンプレートを新規作成（管理者のみ）
 *
 * T17: これまでテンプレートは手動SQLでしか入れられなかった（書き込み経路なし）。
 * 管理画面から作れるようにするための追加。フラグOFF時は 404 で従来どおり存在しない扱い。
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  productId: z.string().nullable().optional(),
  planName: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  lines: z.array(templateLineSchema).min(1),
});

export async function GET() {
  const perm = await getCurrentPermission();
  if (!perm) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ templates: [] });
  const templates = await prisma.quoteTemplate.findMany({
    where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const productId = await resolveTemplateProductId(d.productId);
  if (productId === INVALID_PRODUCT) {
    return NextResponse.json({ error: "指定されたカテゴリが見つかりません" }, { status: 400 });
  }

  try {
    const template = await prisma.quoteTemplate.create({
      data: {
        name: d.name.trim(),
        productId,
        planName: d.planName?.trim() || null,
        sortOrder: d.sortOrder ?? 0,
        lines: { create: d.lines.map(toTemplateLineData) },
      },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    });
    return NextResponse.json({ template });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "同じ名前のテンプレートが既にあります" }, { status: 409 });
    }
    throw e;
  }
}
