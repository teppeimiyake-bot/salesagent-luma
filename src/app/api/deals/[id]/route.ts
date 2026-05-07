import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DealStatus } from "@prisma/client";
import { getCurrentPermission, hasPermission } from "@/lib/auth";
import { syncDealAppointmentDateToNotion } from "@/lib/notion-sync";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deal = await prisma.deal.findUnique({
    where: { id },
    include: {
      company: { include: { contacts: true } },
      owner: { select: { id: true, name: true, avatarColor: true, email: true } },
      leadSource: { select: { id: true, name: true } },
      products: {
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          product: {
            select: {
              id: true,
              name: true,
              plans: {
                where: { active: true },
                orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
                select: { id: true, name: true, basePrice: true },
              },
            },
          },
        },
        orderBy: [{ amount: "desc" }, { createdAt: "asc" }],
      },
      meetings: { orderBy: { meetingDate: "desc" } },
      tasks: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (deal.deletedAt || deal.company.deletedAt) {
    return NextResponse.json({ error: "Deleted" }, { status: 410 });
  }
  return NextResponse.json({ deal });
}

const bantSchema = z
  .object({
    budget: z.string().optional(),
    authority: z.string().optional(),
    need: z.string().optional(),
    timeline: z.string().optional(),
    summary: z.string().optional(),
    confidence: z.number().int().min(0).max(100).optional(),
  })
  .partial();

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.nativeEnum(DealStatus).optional(),
  pipelineStage: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  nextActionAt: z.string().datetime().nullable().optional(),
  appointmentDate: z.string().datetime().nullable().optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  contractDate: z.string().datetime().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  leadSourceId: z.string().uuid().nullable().optional(),
  leadSourceMemo: z.string().nullable().optional(),
  bant: bantSchema.optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const data = parsed.data;

  let bantPatch: { bant?: object; bantUpdatedAt?: Date } = {};
  if (data.bant) {
    const existing = await prisma.deal.findUnique({
      where: { id },
      select: { bant: true },
    });
    const merged = {
      ...((existing?.bant as Record<string, unknown> | null) ?? {}),
      ...data.bant,
    };
    bantPatch = { bant: merged, bantUpdatedAt: new Date() };
  }

  const { bant: _bantIgnored, ...rest } = data;
  void _bantIgnored;

  const deal = await prisma.deal.update({
    where: { id },
    data: {
      ...rest,
      nextActionAt:
        data.nextActionAt === undefined
          ? undefined
          : data.nextActionAt
            ? new Date(data.nextActionAt)
            : null,
      appointmentDate:
        data.appointmentDate === undefined
          ? undefined
          : data.appointmentDate
            ? new Date(data.appointmentDate)
            : null,
      expectedCloseDate:
        data.expectedCloseDate === undefined
          ? undefined
          : data.expectedCloseDate
            ? new Date(data.expectedCloseDate)
            : null,
      contractDate:
        data.contractDate === undefined
          ? undefined
          : data.contractDate
            ? new Date(data.contractDate)
            : null,
      ...bantPatch,
    },
  });

  // 初回商談日（appointmentDate）が変更された場合、Notionの「商談日」プロパティに反映
  // - DBは保存済み。Notion失敗してもAPI本体は止めない
  // - notionSync: "ok" | "skipped" | "failed" を返す
  let notionSync: "ok" | "skipped" | "failed" = "skipped";
  if (data.appointmentDate !== undefined) {
    const dateForNotion = data.appointmentDate ? new Date(data.appointmentDate) : null;
    const result = await syncDealAppointmentDateToNotion(id, dateForNotion);
    if (result.ok) {
      notionSync = result.skipped ? "skipped" : "ok";
    } else {
      notionSync = "failed";
    }
  }

  return NextResponse.json({ deal, notionSync });
}

/**
 * DELETE
 *  - デフォルト：ソフト削除（user/admin）
 *  - ?permanent=true：物理削除（admin only、関連は onDelete: Cascade で消える）
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
    await prisma.deal.delete({ where: { id } });
    return NextResponse.json({ ok: true, mode: "permanent" });
  }

  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await prisma.deal.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return NextResponse.json({ ok: true, mode: "soft" });
}
