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
 * GET    /api/quote-templates/[id] — 1件（明細込み）
 * PATCH  /api/quote-templates/[id] — 名前・カテゴリ・表示順・有効フラグの更新／明細は全置換
 * DELETE /api/quote-templates/[id] — 既定は非表示化（active=false）。?hard=1 のときだけ実削除。
 *
 * T17: 管理画面からテンプレートを保守するための追加。
 * 削除は既定で「消さない」側に倒す（過去の見積は明細をコピー済みなので影響は無いが、
 * 誤操作でテンプレート資産を失わないようにするため）。
 */

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  productId: z.string().nullable().optional(),
  planName: z.string().nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  lines: z.array(templateLineSchema).min(1).optional(),
});

async function guard(required: "admin" = "admin") {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, required)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isQuotePdfV2Enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await params;
  const template = await prisma.quoteTemplate.findUnique({
    where: { id },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!template) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ template });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await prisma.quoteTemplate.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let productId: string | null | undefined;
  if (d.productId !== undefined) {
    const resolved = await resolveTemplateProductId(d.productId);
    if (resolved === INVALID_PRODUCT) {
      return NextResponse.json({ error: "指定されたカテゴリが見つかりません" }, { status: 400 });
    }
    productId = resolved;
  }

  try {
    // 明細は全置換（編集UIは行配列を丸ごと送る前提）。ヘッダと明細をまとめて1トランザクションで。
    const template = await prisma.$transaction(async (tx) => {
      await tx.quoteTemplate.update({
        where: { id },
        data: {
          ...(d.name !== undefined ? { name: d.name.trim() } : {}),
          ...(productId !== undefined ? { productId } : {}),
          ...(d.planName !== undefined ? { planName: d.planName?.trim() || null } : {}),
          ...(d.active !== undefined ? { active: d.active } : {}),
          ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
        },
      });
      if (d.lines) {
        await tx.quoteTemplateLine.deleteMany({ where: { templateId: id } });
        for (const [index, line] of d.lines.entries()) {
          await tx.quoteTemplateLine.create({
            data: { templateId: id, ...toTemplateLineData(line, index) },
          });
        }
      }
      return tx.quoteTemplate.findUnique({
        where: { id },
        include: { lines: { orderBy: { sortOrder: "asc" } } },
      });
    });
    return NextResponse.json({ template });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "同じ名前のテンプレートが既にあります" }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard();
  if (denied) return denied;
  const { id } = await params;

  const existing = await prisma.quoteTemplate.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const hard = new URL(req.url).searchParams.get("hard") === "1";
  if (!hard) {
    // 既定は非表示化。見積作成のプルダウンから消えるだけで、データは残す。
    const template = await prisma.quoteTemplate.update({ where: { id }, data: { active: false } });
    return NextResponse.json({ ok: true, mode: "soft", template });
  }
  // 明細は onDelete: Cascade で一緒に消える
  await prisma.quoteTemplate.delete({ where: { id } });
  return NextResponse.json({ ok: true, mode: "hard" });
}
