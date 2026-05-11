import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { excludeDoneAndNGDealsWhere } from "@/lib/deal-status-server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dealId = url.searchParams.get("dealId");
  const status = url.searchParams.get("status");

  // dealId 指定時は商談詳細用なのでフィルタ無し（その商談のタスクをそのまま返す）。
  // dealId 未指定時は全体ToDo一覧用なので受注/失注/NG 除外（社長判断 2026-05）。
  const dealClause = dealId
    ? { dealId }
    : await (async () => {
        const ex = await excludeDoneAndNGDealsWhere();
        return {
          deal: {
            deletedAt: null,
            company: { deletedAt: null },
            AND: [...ex.AND],
          },
        };
      })();

  const tasks = await prisma.task.findMany({
    where: {
      ...dealClause,
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
