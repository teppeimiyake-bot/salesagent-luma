import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardKyopro } from "@/lib/kyopro-server";
import { KYOPRO_ROLES } from "@/lib/kyopro";

const roleEnum = z.enum(KYOPRO_ROLES as [string, ...string[]]);

const updateSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  kana: z.string().max(60).nullish(),
  phone: z.string().max(30).nullish(),
  email: z.string().email().max(120).nullish().or(z.literal("")),
  roles: z.array(roleEnum).min(1).optional(),
  payOverrides: z.record(roleEnum, z.number().int().min(0).max(1_000_000)).nullish(),
  bankInfo: z.string().max(500).nullish(),
  note: z.string().max(2000).nullish(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("user");
  if (!g.ok) return g.response;
  const { id } = await params;
  const parsed = updateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "入力が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.name) {
    const dup = await prisma.kyoproStaff.findFirst({ where: { name: d.name, NOT: { id } } });
    if (dup) return NextResponse.json({ error: "同名の人材が既に登録されています" }, { status: 409 });
  }
  const staff = await prisma.kyoproStaff.update({
    where: { id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.kana !== undefined ? { kana: d.kana } : {}),
      ...(d.phone !== undefined ? { phone: d.phone } : {}),
      ...(d.email !== undefined ? { email: d.email ? d.email : null } : {}),
      ...(d.roles !== undefined ? { roles: d.roles as never } : {}),
      ...(d.payOverrides !== undefined ? { payOverrides: d.payOverrides ?? undefined } : {}),
      // 振込先は admin だけが書き換えられる
      ...(d.bankInfo !== undefined && g.permission === "admin" ? { bankInfo: d.bankInfo } : {}),
      ...(d.note !== undefined ? { note: d.note } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
    },
  });
  return NextResponse.json({ staff });
}

/** 稼働履歴が残るため物理削除せず無効化する */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardKyopro("admin");
  if (!g.ok) return g.response;
  const { id } = await params;
  const staff = await prisma.kyoproStaff.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ staff, mode: "deactivated" });
}
