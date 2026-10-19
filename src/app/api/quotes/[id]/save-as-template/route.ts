import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { isQuotePdfV2Enabled } from "@/lib/feature-flags";
import { INVALID_PRODUCT, resolveTemplateProductId } from "@/lib/quote-template-server";
import { writeForbidden } from "@/lib/write-guard";

/**
 * POST /api/quotes/[id]/save-as-template — いま作った見積の明細をテンプレートとして登録する。
 *
 * T17: 「テンプレートの新規作成はできない？」（三宅さん）への直接の答え。
 * 管理画面へ行かなくても、商談画面で組んだ見積からそのままテンプレート化できるようにする。
 * テンプレート管理そのものは admin だが、これは日常の営業操作なので user 以上で許可する。
 */

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  productId: z.string().nullable().optional(),
  planName: z.string().nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return await writeForbidden();
  }
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "テンプレート名を入力してください" }, { status: 400 });
  }
  const d = parsed.data;

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } }, dealProduct: { select: { planName: true } } },
  });
  if (!quote) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (quote.lines.length === 0) {
    return NextResponse.json({ error: "明細が無い見積はテンプレートにできません" }, { status: 400 });
  }

  const productId = await resolveTemplateProductId(d.productId);
  if (productId === INVALID_PRODUCT) {
    return NextResponse.json({ error: "指定されたカテゴリが見つかりません" }, { status: 400 });
  }

  try {
    const template = await prisma.quoteTemplate.create({
      data: {
        name: d.name.trim(),
        productId,
        // 明示指定が無ければ見積の出所 DealProduct のプラン名を引き継ぐ
        planName: d.planName?.trim() || quote.dealProduct?.planName || null,
        sortOrder: 0,
        // 見積固有の項目（quoteId / 発行番号など）は持ち込まず、明細の中身だけコピーする
        lines: {
          create: quote.lines.map((line, index) => ({
            name: line.name,
            detail: line.detail,
            qty: line.qty,
            unit: line.unit,
            unitPrice: line.unitPrice,
            taxCategory: line.taxCategory,
            taxRate: line.taxRate,
            sortOrder: index,
          })),
        },
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
