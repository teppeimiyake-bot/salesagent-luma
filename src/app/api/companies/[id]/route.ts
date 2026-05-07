import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const company = await prisma.company.findUnique({
    where: { id },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      deals: {
        where: { deletedAt: null },
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          _count: { select: { tasks: true, meetings: true } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!company) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }
  return NextResponse.json({ company });
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().nullable().optional(),
  websiteUrl: z.string().url().nullable().optional(),
  websiteSummary: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  ceoName: z.string().nullable().optional(),
  establishedYear: z.number().int().nullable().optional(),
  employeeCount: z.number().int().nullable().optional(),
  capital: z.string().nullable().optional(),
  phoneNumber: z.string().nullable().optional(),
  logoColor: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const company = await prisma.company.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ company });
}

/**
 * DELETE
 *  - デフォルト：ソフト削除（user/admin）。紐づくDealも一括ソフト削除
 *  - ?permanent=true：物理削除（admin only、Cascadeで全関連削除）
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const permanent = url.searchParams.get("permanent") === "true";
  const perm = await getCurrentPermission();

  if (permanent) {
    if (!hasPermission(perm, "admin")) {
      return NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 });
    }
    await prisma.company.delete({ where: { id } });
    return NextResponse.json({ ok: true, mode: "permanent" });
  }

  // ソフト削除：Company＋紐づくDealをまとめて
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.deal.updateMany({
      where: { companyId: id, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.company.update({
      where: { id },
      data: { deletedAt: now },
    }),
  ]);
  return NextResponse.json({ ok: true, mode: "soft" });
}
