import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  address: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.name) {
    const dup = await prisma.kyoproVenue.findFirst({ where: { name: parsed.data.name, NOT: { id } } });
    if (dup) return NextResponse.json({ error: "同名の会場が既に存在します" }, { status: 409 });
  }
  const venue = await prisma.kyoproVenue.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ venue });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const { id } = await params;
  const venue = await prisma.kyoproVenue.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ venue, mode: "deactivated" });
}
