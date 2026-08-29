import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";

/** GET /api/kyopro/clients — クライアント（呉服店）一覧 */
export async function GET(req: Request) {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "true";
  const clients = await prisma.kyoproClient.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ clients });
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  shortName: z.string().max(40).nullish(),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  defaultVenueId: z.string().uuid().nullish(),
  note: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const dup = await prisma.kyoproClient.findFirst({ where: { name: parsed.data.name } });
  if (dup) {
    // 無効化済みの同名があれば復活させる（同じ呉服店を二重登録しない）
    if (!dup.active) {
      const revived = await prisma.kyoproClient.update({ where: { id: dup.id }, data: { active: true } });
      return NextResponse.json({ client: revived, reactivated: true });
    }
    return NextResponse.json({ error: "同名のクライアントが既に存在します" }, { status: 409 });
  }
  const count = await prisma.kyoproClient.count();
  const client = await prisma.kyoproClient.create({
    data: {
      name: parsed.data.name,
      shortName: parsed.data.shortName ?? null,
      colorHex: parsed.data.colorHex ?? "#0d6b52",
      defaultVenueId: parsed.data.defaultVenueId ?? null,
      note: parsed.data.note ?? null,
      sortOrder: count + 1,
    },
  });
  return NextResponse.json({ client });
}
