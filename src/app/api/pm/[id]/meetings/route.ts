import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getCurrentPermission, hasPermission } from "@/lib/auth";

const createSchema = z.object({
  title: z.string().nullable().optional(),
  minutes: z.string().min(1),
  meetingDate: z.string().nullable().optional(),
});

/**
 * POST /api/pm/[id]/meetings
 * 案件詳細から議事録メモ(Meeting.minutes)を新規追加する。
 * プロジェクトの dealId に紐づける。user 権限以上。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const perm = await getCurrentPermission();
  if (!hasPermission(perm, "user")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const project = await prisma.productionProject.findUnique({
    where: { id },
    select: { dealId: true },
  });
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const d = parsed.data;
  const meetingDate = d.meetingDate ? new Date(d.meetingDate) : new Date();
  const meeting = await prisma.meeting.create({
    data: {
      dealId: project.dealId,
      title: d.title?.trim() || null,
      minutes: d.minutes,
      meetingDate: Number.isNaN(meetingDate.getTime()) ? new Date() : meetingDate,
    },
    select: {
      id: true,
      title: true,
      meetingDate: true,
      minutes: true,
      summary: true,
      recordingUrl: true,
    },
  });

  return NextResponse.json({ meeting });
}
