import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import { KYOPRO_ROLES } from "@/lib/kyopro";

const roleEnum = z.enum(KYOPRO_ROLES as [string, ...string[]]);
/** 職種別の個別発注単価 { "MC": 18000 } */
const payOverridesSchema = z.record(roleEnum, z.number().int().min(0).max(1_000_000));

/** GET /api/kyopro/staff — 人材一覧（振込先は admin のみ返す） */
export async function GET(req: Request) {
  const g = await guardKyopro("viewer");
  if (!g.ok) return g.response;
  const includeInactive = new URL(req.url).searchParams.get("includeInactive") === "true";
  const staff = await prisma.kyoproStaff.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const isAdmin = g.permission === "admin";
  return NextResponse.json({
    staff: staff.map((s) => ({ ...s, bankInfo: isAdmin ? s.bankInfo : null })),
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(40),
  kana: z.string().max(60).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().max(120).nullish().or(z.literal("")),
  roles: z.array(roleEnum).min(1),
  payOverrides: payOverridesSchema.nullish(),
  bankInfo: z.string().max(500).nullish(),
  /** 研修中か（アサイン時の既定になる） */
  trainee: z.boolean().optional(),
  note: z.string().max(2000).nullish(),
});

export async function POST(req: Request) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const dup = await prisma.kyoproStaff.findFirst({ where: { name: d.name } });
  if (dup) {
    if (!dup.active) {
      const revived = await prisma.kyoproStaff.update({ where: { id: dup.id }, data: { active: true } });
      return NextResponse.json({ staff: revived, reactivated: true });
    }
    // 同姓の別人（坂井 / 坂井（喜）のようなケース）は名前で区別して登録してもらう
    return NextResponse.json(
      { error: "同名の人材が既に登録されています。同姓の別人であれば区別できる表記で登録してください。" },
      { status: 409 },
    );
  }
  const count = await prisma.kyoproStaff.count();
  const staff = await prisma.kyoproStaff.create({
    data: {
      name: d.name,
      kana: d.kana ?? null,
      phone: d.phone ?? null,
      email: d.email ? d.email : null,
      roles: d.roles as never,
      payOverrides: d.payOverrides ?? undefined,
      bankInfo: g.permission === "admin" ? (d.bankInfo ?? null) : null,
      trainee: d.trainee ?? false,
      note: d.note ?? null,
      sortOrder: count + 1,
    },
  });
  return NextResponse.json({ staff });
}
