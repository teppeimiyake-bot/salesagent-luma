import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ meeting });
}

const updateSchema = z.object({
  title: z.string().nullable().optional(),
  minutes: z.string().optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  meetingDate: z.string().datetime().optional(),
  bantBudget: z.string().nullable().optional(),
  bantAuthority: z.string().nullable().optional(),
  bantNeed: z.string().nullable().optional(),
  bantTimeline: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // BANT編集の差分を ai_logs に記録（学習用）
  const before = await prisma.meeting.findUnique({ where: { id } });
  const data = parsed.data;
  const meeting = await prisma.meeting.update({
    where: { id },
    data: {
      ...data,
      meetingDate: data.meetingDate ? new Date(data.meetingDate) : undefined,
    },
  });

  if (before) {
    const editKeys = Object.keys(parsed.data).filter(
      (k) => parsed.data[k as keyof typeof parsed.data] !== undefined,
    );
    const beforeView: Record<string, unknown> = {};
    const afterView: Record<string, unknown> = {};
    for (const k of editKeys) {
      beforeView[k] = (before as Record<string, unknown>)[k];
      afterView[k] = (meeting as Record<string, unknown>)[k];
    }
    if (editKeys.some((k) => beforeView[k] !== afterView[k])) {
      await prisma.aiLog.create({
        data: {
          dealId: meeting.dealId,
          step: "bant_user_edit",
          input: { meetingId: id, before: beforeView } as object,
          output: { after: afterView } as object,
          userEdit: parsed.data as object,
        },
      });
    }
  }

  return NextResponse.json({ meeting });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.meeting.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
