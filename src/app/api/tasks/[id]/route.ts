import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { TaskStatus } from "@prisma/client";

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: z.nativeEnum(TaskStatus).optional(),
  priority: z.string().nullable().optional(),
  impact: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  expectedOutcome: z.string().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const task = await prisma.task.update({
    where: { id },
    data: {
      ...data,
      dueDate: data.dueDate === undefined ? undefined : data.dueDate ? new Date(data.dueDate) : null,
      completedAt: data.status === TaskStatus.DONE ? new Date() : undefined,
    },
  });

  // 学習機構：AI生成 ToDo にユーザー編集が入った場合 ai_logs に差分を記録
  if (task.isAiGenerated) {
    const original = await prisma.aiLog.findFirst({
      where: { dealId: task.dealId, step: "task_generated", input: { equals: { taskId: task.id } } },
      orderBy: { createdAt: "desc" },
    });
    if (original) {
      await prisma.aiLog.create({
        data: {
          dealId: task.dealId,
          step: "task_user_edit",
          input: original.output ?? {},
          output: { task: { title: task.title, description: task.description } },
          userEdit: data,
        },
      });
    }
  }

  return NextResponse.json({ task });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.task.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
