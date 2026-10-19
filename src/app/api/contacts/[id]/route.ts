import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireWriter } from "@/lib/write-guard";

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  phone: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  isDecisionMaker: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // 書き込み・AI 呼び出し・外部取得は、操作中の会社で利用者以上（閲覧のみ・全社統合ビューは 403）
  const denied = await requireWriter();
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const data = { ...parsed.data, email: parsed.data.email === "" ? null : parsed.data.email };
  const contact = await prisma.contact.update({ where: { id }, data });
  return NextResponse.json({ contact });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // 書き込み・AI 呼び出し・外部取得は、操作中の会社で利用者以上（閲覧のみ・全社統合ビューは 403）
  const denied = await requireWriter();
  if (denied) return denied;
  const { id } = await params;
  await prisma.contact.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
