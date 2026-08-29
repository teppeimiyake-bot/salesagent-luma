import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";

/** GET /api/kyopro/venues — 会場一覧 */
export async function GET(req: Request) {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "true";
  const venues = await prisma.kyoproVenue.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ venues });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  address: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const dup = await prisma.kyoproVenue.findFirst({ where: { name: parsed.data.name } });
  if (dup) {
    if (!dup.active) {
      const revived = await prisma.kyoproVenue.update({ where: { id: dup.id }, data: { active: true } });
      return NextResponse.json({ venue: revived, reactivated: true });
    }
    return NextResponse.json({ error: "同名の会場が既に存在します" }, { status: 409 });
  }
  const count = await prisma.kyoproVenue.count();
  const venue = await prisma.kyoproVenue.create({
    data: {
      name: parsed.data.name,
      colorHex: parsed.data.colorHex ?? "#7c3aed",
      address: parsed.data.address ?? null,
      note: parsed.data.note ?? null,
      sortOrder: count + 1,
    },
  });
  return NextResponse.json({ venue });
}
