import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dealId = url.searchParams.get("dealId");
  const status = url.searchParams.get("status");

  const tasks = await prisma.task.findMany({
    where: {
      ...(dealId ? { dealId } : {}),
      ...(status ? { status: status as never } : {}),
    },
    include: { deal: { include: { company: true } } },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
  });
  return NextResponse.json({ tasks });
}

const createSchema = z.object({
  dealId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.string().optional(),
  impact: z.string().optional(),
  reason: z.string().optional(),
  expectedOutcome: z.string().optional(),
  dueDate: z.string().datetime().optional(),
  isAiGenerated: z.boolean().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;
  const task = await prisma.task.create({
    data: {
      ...data,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
    },
  });
  return NextResponse.json({ task });
}
